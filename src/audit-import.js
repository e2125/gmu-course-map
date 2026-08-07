const COURSE_CODE_PATTERN = /\b([A-Z]{2,6})\s*(\d{3}[A-Z]?)\b/g;

const PASSING_GRADES = new Set([
  "A+", "A", "A-",
  "B+", "B", "B-",
  "C+", "C", "C-",
  "D+", "D", "D-",
  "P", "S", "CR", "TR", "T",
]);
const IN_PROGRESS_GRADES = new Set(["IP", "REG", "ENR"]);
const NOT_COMPLETED_GRADES = new Set(["F", "W", "NC", "NG", "AU"]);
const STATUS_PRIORITY = {
  review: 0,
  "not-completed": 1,
  "in-progress": 2,
  completed: 3,
};

export function normalizeAuditCourseCode(value) {
  const match = String(value || "").trim().toUpperCase().match(/^([A-Z]{2,6})\s*(\d{3}[A-Z]?)$/);
  return match ? `${match[1]} ${match[2]}` : null;
}

function getGradeFromSegment(value) {
  const segment = value.toUpperCase().replace(/[,;|]/g, " ");
  const explicit = segment.match(/\b(P|S|CR|TR|T|IP|REG|ENR|NC|NG|AU|W)\b/);
  if (explicit) return explicit[1];

  const gradedWithCredits = segment.match(
    /(?:\b\d(?:\.\d{1,3})?\s+)(A[+-]?|B[+-]?|C[+-]?|D[+-]?|F)\b|\b(A[+-]?|B[+-]?|C[+-]?|D[+-]?|F)(?:\s+\d(?:\.\d{1,3})?\b)/,
  );
  if (gradedWithCredits) return gradedWithCredits[1] || gradedWithCredits[2];

  const signedGrade = segment.match(/\b(A[+-]|B[+-]|C[+-]|D[+-])\b/);
  return signedGrade?.[1] || null;
}

function getCourseStatus(grade, evidence) {
  if (PASSING_GRADES.has(grade)) return "completed";
  if (IN_PROGRESS_GRADES.has(grade)) return "in-progress";
  if (NOT_COMPLETED_GRADES.has(grade)) return "not-completed";
  const hasAcademicTerm = /\b(?:SPRING|SUMMER|FALL|WINTER)\s+'?\d{2}\b/.test(evidence);
  const isExplicitlyRemaining = /\bREMAINING\b/.test(evidence);
  if (hasAcademicTerm && !isExplicitlyRemaining) return "in-progress";
  return "review";
}

function chooseStrongerEntry(current, candidate) {
  if (!current) return candidate;
  return STATUS_PRIORITY[candidate.status] > STATUS_PRIORITY[current.status]
    ? candidate
    : current;
}

export function analyzeDegreeAuditText(rawText) {
  const text = String(rawText || "").replace(/\u00a0/g, " ");
  const compactText = text.replace(/\s+/g, " ");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const coursesByCode = new Map();

  for (const line of lines) {
    const matches = [...line.toUpperCase().matchAll(COURSE_CODE_PATTERN)];
    for (const [index, match] of matches.entries()) {
      const code = `${match[1]} ${match[2]}`;
      const start = (match.index || 0) + match[0].length;
      const nextStart = matches[index + 1]?.index ?? Math.min(line.length, start + 150);
      const afterCourse = line.slice(start, nextStart);
      const beforeCourse = line.slice(Math.max(0, (match.index || 0) - 35), match.index || 0);
      const grade = getGradeFromSegment(afterCourse) || getGradeFromSegment(beforeCourse);
      const candidate = {
        code,
        grade,
        status: getCourseStatus(grade, line.toUpperCase()),
        evidence: line,
      };
      coursesByCode.set(code, chooseStrongerEntry(coursesByCode.get(code), candidate));
    }
  }

  const courses = [...coursesByCode.values()].sort((first, second) =>
    first.code.localeCompare(second.code, undefined, { numeric: true }),
  );
  const exceptionDetailCount = (
    text.match(/\b(exception details?|substitution|substituted|waiver|waived)\b/gi) || []
  ).length;
  const creditSummary = compactText.match(
    /\bTaken\b.{0,180}?(\d+)\s+courses?\s*\((\d+(?:\.\d+)?)\s+credits?\)\s*(\d+)\s+courses?\s*\((\d+(?:\.\d+)?)\s+credits?\)\s*(\d+)\s+courses?\s*\((\d+(?:\.\d+)?)\s+credits?\)/i,
  );

  return {
    courses,
    completedCodes: courses
      .filter((course) => course.status === "completed")
      .map((course) => course.code),
    inProgressCodes: courses
      .filter((course) => course.status === "in-progress")
      .map((course) => course.code),
    earnedCredits: creditSummary ? Number(creditSummary[2]) : null,
    inProgressCredits: creditSummary ? Number(creditSummary[4]) : null,
    reportedRemainingCredits: creditSummary ? Number(creditSummary[6]) : null,
    exceptionDetailCount,
  };
}
