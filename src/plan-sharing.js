const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const COURSE_CODE_PATTERN = /^([A-Z]{2,6})\s*(\d{3}[A-Z]?)$/;

export function normalizePlanCourseCodes(codes) {
  const normalized = new Set();

  for (const value of codes || []) {
    if (typeof value !== "string") continue;
    const match = value.trim().toUpperCase().match(COURSE_CODE_PATTERN);
    if (match) normalized.add(`${match[1]} ${match[2]}`);
  }

  return [...normalized].sort((first, second) =>
    first.localeCompare(second, undefined, { numeric: true }),
  );
}

export function parsePlanId(value, baseUrl = "http://localhost/") {
  const candidate = String(value || "").trim();
  if (!candidate) return null;
  if (PLAN_ID_PATTERN.test(candidate)) return candidate;

  try {
    const planId = new URL(candidate, baseUrl).searchParams.get("plan") || "";
    return PLAN_ID_PATTERN.test(planId) ? planId : null;
  } catch {
    return null;
  }
}

export function buildShareUrl(baseUrl, planId) {
  if (!PLAN_ID_PATTERN.test(String(planId || ""))) return "";

  const url = new URL(baseUrl);
  url.searchParams.set("plan", planId);
  url.hash = "";
  return url.toString();
}

export function comparePlanCourses(currentCodes, comparisonCodes) {
  const current = new Set(normalizePlanCourseCodes(currentCodes));
  const comparison = new Set(normalizePlanCourseCodes(comparisonCodes));
  const sortCodes = (codes) =>
    [...codes].sort((first, second) =>
      first.localeCompare(second, undefined, { numeric: true }),
    );

  return {
    shared: sortCodes([...current].filter((code) => comparison.has(code))),
    onlyCurrent: sortCodes([...current].filter((code) => !comparison.has(code))),
    onlyComparison: sortCodes([...comparison].filter((code) => !current.has(code))),
  };
}
