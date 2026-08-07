const COURSE_CODE_PATTERN = /^([A-Z]{2,6})\s*(\d{3}[A-Z]?)$/;
const PROGRAM_ID_PATTERN = /^(all|[a-z0-9][a-z0-9-]{0,79})$/;
const MAX_COURSES = 300;
const TERM_ID_PATTERN = /^(?:(?:spring|summer|fall|winter)-20\d{2}|later)$/;

export class PlanValidationError extends Error {}

export function normalizePlanPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanValidationError("Plan data must be a JSON object.");
  }

  const name = String(value.name || "").trim();
  const programId = String(value.program_id || "").trim();
  if (!name || name.length > 80) {
    throw new PlanValidationError("Plan name must be between 1 and 80 characters.");
  }
  if (!PROGRAM_ID_PATTERN.test(programId)) {
    throw new PlanValidationError("Choose a valid degree program.");
  }
  if (!Array.isArray(value.completed_codes)) {
    throw new PlanValidationError("Completed courses must be an array.");
  }

  function normalizeCodes(rawCodes, label) {
    if (!Array.isArray(rawCodes)) {
      throw new PlanValidationError(`${label} courses must be an array.`);
    }
    const codes = new Set();
    for (const rawCode of rawCodes) {
      if (typeof rawCode !== "string") {
        throw new PlanValidationError(`Every ${label.toLowerCase()} course must be a course code.`);
      }
      const match = rawCode.trim().toUpperCase().match(COURSE_CODE_PATTERN);
      if (!match) {
        throw new PlanValidationError(`Invalid course code: ${rawCode}`);
      }
      codes.add(`${match[1]} ${match[2]}`);
    }
    if (codes.size > MAX_COURSES) {
      throw new PlanValidationError(`A plan can contain at most ${MAX_COURSES} ${label.toLowerCase()} courses.`);
    }
    return codes;
  }

  const completedCodes = normalizeCodes(value.completed_codes, "Completed");
  const transferredCodes = normalizeCodes(value.transferred_codes || [], "Transferred");
  const plannedCodes = normalizeCodes(value.planned_codes || [], "Planned");
  for (const code of [...transferredCodes]) {
    if (!completedCodes.has(code)) transferredCodes.delete(code);
  }
  for (const code of completedCodes) plannedCodes.delete(code);
  const rawPlannedTerms = value.planned_terms || {};
  if (!rawPlannedTerms || typeof rawPlannedTerms !== "object" || Array.isArray(rawPlannedTerms)) {
    throw new PlanValidationError("Planned semesters must be an object.");
  }
  const plannedTerms = {};
  for (const [rawCode, rawTermId] of Object.entries(rawPlannedTerms)) {
    const code = normalizeCodes([rawCode], "Planned").values().next().value;
    const termId = String(rawTermId || "").trim().toLowerCase();
    if (!TERM_ID_PATTERN.test(termId)) {
      throw new PlanValidationError(`Invalid semester: ${rawTermId}`);
    }
    if (plannedCodes.has(code)) plannedTerms[code] = termId;
  }

  const sorted = (codes) => [...codes].sort((first, second) =>
    first.localeCompare(second, undefined, { numeric: true }),
  );

  return {
    name,
    programId,
    completedCodes: sorted(completedCodes),
    transferredCodes: sorted(transferredCodes),
    plannedCodes: sorted(plannedCodes),
    plannedTerms: Object.fromEntries(
      Object.entries(plannedTerms).sort(([first], [second]) => first.localeCompare(second)),
    ),
  };
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createPlanCredentials() {
  return {
    id: randomBase64Url(12),
    editToken: randomBase64Url(32),
  };
}

export async function hashEditToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
