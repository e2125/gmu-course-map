export function getPrerequisiteLogic(course) {
  if (course.prerequisite_logic) return course.prerequisite_logic;
  const prerequisites = course.prerequisites || [];
  if (!prerequisites.length) return null;
  return {
    type: "all",
    items: prerequisites.map((code) => ({ type: "course", code })),
  };
}

export function isLogicSatisfied(logic, completedCodes) {
  if (!logic) return true;
  if (logic.type === "course") return completedCodes.has(logic.code);
  const items = logic.items || [];
  if (logic.type === "any") {
    return items.some((item) => isLogicSatisfied(item, completedCodes));
  }
  return items.every((item) => isLogicSatisfied(item, completedCodes));
}

export function countUnsatisfiedRequirements(logic, completedCodes) {
  if (!logic || isLogicSatisfied(logic, completedCodes)) return 0;
  if (logic.type === "course" || logic.type === "any") return 1;
  return (logic.items || []).reduce(
    (total, item) => total + countUnsatisfiedRequirements(item, completedCodes),
    0,
  );
}

export function requiresManualPrerequisiteReview(course) {
  return ["non_course", "partial"].includes(course.prerequisite_parse_status);
}

export function isCourseReady(course, completedCodes) {
  return !requiresManualPrerequisiteReview(course)
    && isLogicSatisfied(getPrerequisiteLogic(course), completedCodes);
}

function impactSort(firstCode, secondCode, coursesByCode, completedCodes, includeCode, compareCodes) {
  const first = coursesByCode.get(firstCode);
  const second = coursesByCode.get(secondCode);
  const firstMissing = first
    ? countUnsatisfiedRequirements(getPrerequisiteLogic(first), completedCodes)
    : Number.POSITIVE_INFINITY;
  const secondMissing = second
    ? countUnsatisfiedRequirements(getPrerequisiteLogic(second), completedCodes)
    : Number.POSITIVE_INFINITY;
  if (firstMissing !== secondMissing) return firstMissing - secondMissing;

  const firstUnlocks = (first?.unlocks || []).filter(includeCode).length;
  const secondUnlocks = (second?.unlocks || []).filter(includeCode).length;
  if (firstUnlocks !== secondUnlocks) return secondUnlocks - firstUnlocks;
  return compareCodes(firstCode, secondCode);
}

function getLaterUnlocks(startCode, unlocksByCode, includeCode, maxDepth) {
  const seen = new Set([startCode]);
  const queue = (unlocksByCode[startCode] || []).map((code) => ({ code, depth: 1 }));
  const later = [];

  while (queue.length) {
    const item = queue.shift();
    if (seen.has(item.code) || item.depth > maxDepth) continue;
    seen.add(item.code);
    if (item.depth > 1 && includeCode(item.code)) later.push(item);
    for (const nextCode of unlocksByCode[item.code] || []) {
      if (!seen.has(nextCode)) queue.push({ code: nextCode, depth: item.depth + 1 });
    }
  }

  return later;
}

export function buildCourseImpactPath({
  course,
  coursesByCode,
  unlocksByCode,
  completedCodes,
  includeCode = () => true,
  compareCodes = (first, second) => first.localeCompare(second),
  maxDepth = 3,
  laterLimit = 10,
}) {
  const beforeCompleted = new Set(completedCodes);
  beforeCompleted.delete(course.code);
  const afterCompleted = new Set(beforeCompleted);
  afterCompleted.add(course.code);
  const directCodes = (course.unlocks || []).filter(includeCode);
  const newlyReady = [];
  const stillBlocked = [];
  const alreadyReady = [];

  for (const code of directCodes) {
    if (afterCompleted.has(code)) continue;
    const candidate = coursesByCode.get(code);
    if (!candidate) continue;
    const readyBefore = isCourseReady(candidate, beforeCompleted);
    const readyAfter = isCourseReady(candidate, afterCompleted);
    if (!readyBefore && readyAfter) newlyReady.push(code);
    else if (!readyAfter) stillBlocked.push(code);
    else alreadyReady.push(code);
  }

  newlyReady.sort((first, second) =>
    impactSort(first, second, coursesByCode, afterCompleted, includeCode, compareCodes),
  );
  stillBlocked.sort((first, second) =>
    impactSort(first, second, coursesByCode, afterCompleted, includeCode, compareCodes),
  );

  const directSet = new Set(directCodes);
  const later = getLaterUnlocks(course.code, unlocksByCode, includeCode, maxDepth)
    .filter((item) => !directSet.has(item.code) && !afterCompleted.has(item.code))
    .sort((first, second) => {
      if (first.depth !== second.depth) return first.depth - second.depth;
      return impactSort(
        first.code,
        second.code,
        coursesByCode,
        afterCompleted,
        includeCode,
        compareCodes,
      );
    })
    .slice(0, laterLimit);

  return {
    prerequisites: [...(course.prerequisites || [])].sort(compareCodes),
    beforeCompleted,
    afterCompleted,
    newlyReady,
    stillBlocked,
    alreadyReady,
    later,
  };
}
