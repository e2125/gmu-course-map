const COURSE_CODE_PATTERN = /^([A-Z]{2,6})\s*(\d{3}[A-Z]?)$/;
const PROGRAM_ID_PATTERN = /^(all|[a-z0-9][a-z0-9-]{0,79})$/;
const MAX_COURSES = 300;

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

  const completedCodes = new Set();
  for (const rawCode of value.completed_codes) {
    if (typeof rawCode !== "string") {
      throw new PlanValidationError("Every completed course must be a course code.");
    }
    const match = rawCode.trim().toUpperCase().match(COURSE_CODE_PATTERN);
    if (!match) {
      throw new PlanValidationError(`Invalid course code: ${rawCode}`);
    }
    completedCodes.add(`${match[1]} ${match[2]}`);
  }

  if (completedCodes.size > MAX_COURSES) {
    throw new PlanValidationError(`A plan can contain at most ${MAX_COURSES} courses.`);
  }

  return {
    name,
    programId,
    completedCodes: [...completedCodes].sort((first, second) =>
      first.localeCompare(second, undefined, { numeric: true }),
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
