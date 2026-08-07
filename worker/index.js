import {
  createPlanCredentials,
  hashEditToken,
  normalizePlanPayload,
  PlanValidationError,
} from "./plan-utils.js";

const MAX_BODY_BYTES = 64 * 1024;
const PLAN_PATH = /^\/api\/plans\/([A-Za-z0-9_-]{8,64})$/;

function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function publicPlan(row) {
  return {
    id: row.id,
    name: row.name,
    program_id: row.program_id,
    completed_codes: JSON.parse(row.completed_codes),
    transferred_codes: JSON.parse(row.transferred_codes || "[]"),
    planned_codes: JSON.parse(row.planned_codes || "[]"),
    planned_terms: JSON.parse(row.planned_terms || "{}"),
    earned_credits: row.earned_credits == null ? null : Number(row.earned_credits),
    audit_completed_codes: JSON.parse(row.audit_completed_codes || "[]"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function readPlanBody(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new PlanValidationError("Plan data is too large.");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new PlanValidationError("Plan data is too large.");
  }

  try {
    return normalizePlanPayload(JSON.parse(text));
  } catch (error) {
    if (error instanceof PlanValidationError) throw error;
    throw new PlanValidationError("Plan data must be valid JSON.");
  }
}

async function createPlan(request, env) {
  const payload = await readPlanBody(request);
  const credentials = createPlanCredentials();
  const editTokenHash = await hashEditToken(credentials.editToken);
  const timestamp = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO plans
      (id, edit_token_hash, name, program_id, completed_codes, transferred_codes, planned_codes, planned_terms, earned_credits, audit_completed_codes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    credentials.id,
    editTokenHash,
    payload.name,
    payload.programId,
    JSON.stringify(payload.completedCodes),
    JSON.stringify(payload.transferredCodes),
    JSON.stringify(payload.plannedCodes),
    JSON.stringify(payload.plannedTerms),
    payload.earnedCredits,
    JSON.stringify(payload.auditCompletedCodes),
    timestamp,
    timestamp,
  ).run();

  const row = await env.DB.prepare("SELECT * FROM plans WHERE id = ?")
    .bind(credentials.id)
    .first();
  return jsonResponse({ plan: publicPlan(row), edit_token: credentials.editToken }, 201);
}

async function getPlan(planId, env) {
  const row = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first();
  if (!row) return jsonResponse({ error: "Plan not found." }, 404);
  return jsonResponse({ plan: publicPlan(row) });
}

async function updatePlan(request, planId, env) {
  const editToken = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!editToken) return jsonResponse({ error: "This plan needs its private edit key." }, 401);

  const row = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first();
  if (!row) return jsonResponse({ error: "Plan not found." }, 404);
  if ((await hashEditToken(editToken)) !== row.edit_token_hash) {
    return jsonResponse({ error: "The edit key is not valid for this plan." }, 403);
  }

  const payload = await readPlanBody(request);
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE plans
     SET name = ?, program_id = ?, completed_codes = ?, transferred_codes = ?, planned_codes = ?, planned_terms = ?, earned_credits = ?, audit_completed_codes = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(
    payload.name,
    payload.programId,
    JSON.stringify(payload.completedCodes),
    JSON.stringify(payload.transferredCodes),
    JSON.stringify(payload.plannedCodes),
    JSON.stringify(payload.plannedTerms),
    payload.earnedCredits,
    JSON.stringify(payload.auditCompletedCodes),
    timestamp,
    planId,
  ).run();

  const updated = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first();
  return jsonResponse({ plan: publicPlan(updated) });
}

async function routeApi(request, env, url) {
  if (!env.DB) return jsonResponse({ error: "Plan storage is not configured." }, 503);
  if (url.pathname === "/api/plans" && request.method === "POST") {
    return createPlan(request, env);
  }

  const match = url.pathname.match(PLAN_PATH);
  if (match && request.method === "GET") return getPlan(match[1], env);
  if (match && request.method === "PUT") return updatePlan(request, match[1], env);
  return jsonResponse({ error: "API route not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await routeApi(request, env, url);
      }
      if (!env.ASSETS) return new Response("Static assets are not configured.", { status: 503 });
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof PlanValidationError) {
        return jsonResponse({ error: error.message }, 400);
      }
      console.error(error);
      return jsonResponse({ error: "Unexpected server error." }, 500);
    }
  },
};
