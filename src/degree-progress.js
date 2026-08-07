function uniqueCodes(codes) {
  return [...new Set(codes.filter(Boolean))];
}

function parseCredits(value) {
  if (typeof value === "number") return value;
  const match = String(value || "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function courseMatchesRule(course, rule) {
  if (!course || !rule) return false;
  const match = course.code.match(/^([A-Z]{2,6})\s+(\d{3})[A-Z]?$/);
  if (!match) return false;

  const [, subject, numberText] = match;
  const number = Number(numberText);
  if (rule.subject && subject !== rule.subject) return false;
  if (rule.min_number != null && number < rule.min_number) return false;
  if (rule.max_number != null && number > rule.max_number) return false;
  return !(rule.exclude || []).includes(course.code);
}

function optionCourses(option) {
  if (typeof option === "string") return [option];
  if (Array.isArray(option)) return option;
  if (option?.alternatives) return option.alternatives.flatMap(optionCourses);
  return option?.courses || [];
}

function collectExplicitCodes(requirement) {
  const codes = [
    ...(requirement.required_courses || []),
    ...(requirement.courses || []),
    ...(requirement.options || []).flatMap(optionCourses),
    ...(requirement.credit_options || []).flatMap(optionCourses),
  ];

  for (const group of requirement.option_groups || []) {
    codes.push(...(group.options || []).flatMap(optionCourses));
  }

  return uniqueCodes(codes);
}

export function getRequirementCandidateCodes(requirement, courses) {
  const codes = collectExplicitCodes(requirement);
  for (const rule of requirement.rules || []) {
    codes.push(...courses.filter((course) => courseMatchesRule(course, rule)).map((course) => course.code));
  }
  return uniqueCodes(codes);
}

function combinations(values, size) {
  if (size === 0) return [[]];
  if (values.length < size) return [];

  const results = [];
  function visit(start, selected) {
    if (selected.length === size) {
      results.push([...selected]);
      return;
    }

    const remaining = size - selected.length;
    for (let index = start; index <= values.length - remaining; index += 1) {
      selected.push(values[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  }

  visit(0, []);
  return results;
}

function optionVariants(option, completedCodes, unavailableCodes) {
  if (typeof option === "object" && !Array.isArray(option) && option?.alternatives) {
    return option.alternatives.flatMap((alternative) =>
      optionVariants(alternative, completedCodes, unavailableCodes),
    );
  }

  const courses = uniqueCodes(optionCourses(option)).filter(
    (code) => completedCodes.has(code) && !unavailableCodes.has(code),
  );
  const requiredCount = typeof option === "object" && !Array.isArray(option)
    ? option.required_count ?? optionCourses(option).length
    : optionCourses(option).length;

  return combinations(courses, requiredCount);
}

function groupSelections(group, completedCodes, unavailableCodes) {
  const options = group.options || [];
  const target = Math.min(group.required_count ?? 1, options.length);
  const selections = new Map();

  function remember(selectedCount, usedCodes) {
    const codes = [...usedCodes].sort();
    const key = `${selectedCount}:${codes.join("|")}`;
    selections.set(key, { selectedCount, codes });
  }

  function visit(optionIndex, selectedCount, usedCodes) {
    remember(selectedCount, usedCodes);
    if (selectedCount === target || optionIndex === options.length) return;

    visit(optionIndex + 1, selectedCount, usedCodes);
    for (const variant of optionVariants(options[optionIndex], completedCodes, unavailableCodes)) {
      if (variant.some((code) => usedCodes.has(code))) continue;
      const nextUsed = new Set(usedCodes);
      variant.forEach((code) => nextUsed.add(code));
      visit(optionIndex + 1, selectedCount + 1, nextUsed);
    }
  }

  visit(0, 0, new Set());
  return [...selections.values()].sort((first, second) => {
    if (second.selectedCount !== first.selectedCount) {
      return second.selectedCount - first.selectedCount;
    }
    return first.codes.length - second.codes.length;
  });
}

function isBetterAllocation(candidate, current) {
  if (!current) return true;
  if (candidate.totalSelected !== current.totalSelected) {
    return candidate.totalSelected > current.totalSelected;
  }

  for (let index = 0; index < candidate.groupCounts.length; index += 1) {
    if (candidate.groupCounts[index] !== current.groupCounts[index]) {
      return candidate.groupCounts[index] > current.groupCounts[index];
    }
  }
  return candidate.codes.size < current.codes.size;
}

function allocateOptionGroups(groups, completedCodes, unavailableCodes) {
  let best = null;

  function visit(groupIndex, usedCodes, groupCounts, totalSelected) {
    if (groupIndex === groups.length) {
      const candidate = { codes: new Set(usedCodes), groupCounts, totalSelected };
      if (isBetterAllocation(candidate, best)) best = candidate;
      return;
    }

    const unavailable = new Set([...unavailableCodes, ...usedCodes]);
    for (const selection of groupSelections(groups[groupIndex], completedCodes, unavailable)) {
      const nextUsed = new Set(usedCodes);
      selection.codes.forEach((code) => nextUsed.add(code));
      visit(
        groupIndex + 1,
        nextUsed,
        [...groupCounts, selection.selectedCount],
        totalSelected + selection.selectedCount,
      );
    }
  }

  visit(0, new Set(), [], 0);
  return best || { codes: new Set(), groupCounts: groups.map(() => 0), totalSelected: 0 };
}

function equivalentCourseKey(code, equivalencies) {
  const group = equivalencies.find((codes) => codes.includes(code));
  return group ? `equivalent:${group.join("|")}` : `course:${code}`;
}

function allocateCredits(
  codes,
  courseMap,
  completedCodes,
  unavailableCodes,
  creditsNeeded,
  equivalencies,
  preferredCodes,
  creditOptions = [],
) {
  const optionCodeSet = new Set(creditOptions.flatMap(optionCourses));
  const units = creditOptions.flatMap((option, optionIndex) => {
    const variants = optionVariants(option, completedCodes, unavailableCodes);
    if (!variants.length) return [];
    const rankedVariants = variants
      .map((variant) => ({
        codes: variant,
        credits: variant.reduce(
          (total, code) => total + parseCredits(courseMap.get(code)?.credits),
          0,
        ),
        preferred: variant.some((code) => preferredCodes.has(code)),
      }))
      .sort((first, second) => {
        if (first.preferred !== second.preferred) return second.preferred - first.preferred;
        return second.credits - first.credits;
      });
    return [{ ...rankedVariants[0], key: `option:${optionIndex}` }];
  });

  for (const code of uniqueCodes(codes)) {
    if (
      optionCodeSet.has(code)
      || !completedCodes.has(code)
      || unavailableCodes.has(code)
    ) continue;
    units.push({
      key: `course:${code}`,
      codes: [code],
      credits: parseCredits(courseMap.get(code)?.credits),
      preferred: preferredCodes.has(code),
    });
  }

  units.sort((first, second) => {
    if (first.preferred !== second.preferred) return second.preferred - first.preferred;
    return second.credits - first.credits;
  });
  const usedEquivalencies = new Set();
  const usedCodes = new Set();
  let credits = 0;

  for (const unit of units) {
    if (credits >= creditsNeeded) break;
    if (!unit.credits || unit.codes.some((code) => usedCodes.has(code))) continue;
    const equivalencyKeys = unit.codes.map((code) => equivalentCourseKey(code, equivalencies));
    if (equivalencyKeys.some((key) => usedEquivalencies.has(key))) continue;

    equivalencyKeys.forEach((key) => usedEquivalencies.add(key));
    unit.codes.forEach((code) => usedCodes.add(code));
    credits += unit.credits;
  }

  return {
    credits: Math.min(credits, creditsNeeded),
    codes: usedCodes,
  };
}

function makeTopLevelChoiceGroup(requirement) {
  if (requirement.required_count == null && !(requirement.options || []).length) return null;
  return {
    label: requirement.choice_label || requirement.label,
    required_count: requirement.required_count ?? 1,
    options: (requirement.options || requirement.courses || []).map((option) =>
      typeof option === "string" ? option : option,
    ),
  };
}

function requirementStats(requirement, program, courses, completedCodes, usedByPreviousRequirements) {
  const courseMap = new Map(courses.map((course) => [course.code, course]));
  const candidateCodes = getRequirementCandidateCodes(requirement, courses);
  const hasExplicitLogic = Boolean(
    requirement.required_courses
      || requirement.required_count != null
      || requirement.credits_needed != null
      || (requirement.options || []).length
      || (requirement.option_groups || []).length,
  );
  const fixedCodes = uniqueCodes(
    requirement.required_courses || (!hasExplicitLogic ? requirement.courses || [] : []),
  );
  const fixedCompletedCodes = fixedCodes.filter(
    (code) => completedCodes.has(code) && !usedByPreviousRequirements.has(code),
  );
  const fixedUsedCodes = new Set(fixedCompletedCodes);

  const topLevelGroup = makeTopLevelChoiceGroup(requirement);
  const optionGroups = [
    ...(topLevelGroup ? [topLevelGroup] : []),
    ...(requirement.option_groups || []),
  ];
  const groupUnavailable = new Set([...usedByPreviousRequirements, ...fixedUsedCodes]);
  const allocation = allocateOptionGroups(optionGroups, completedCodes, groupUnavailable);
  const choiceTarget = optionGroups.reduce(
    (total, group) => total + Math.min(group.required_count ?? 1, (group.options || []).length),
    0,
  );

  const creditsTarget = requirement.credits_needed || 0;
  const creditAllocation = creditsTarget
    ? allocateCredits(
      candidateCodes,
      courseMap,
      completedCodes,
      usedByPreviousRequirements,
      creditsTarget,
      program.equivalencies || [],
      allocation.codes,
      requirement.credit_options || [],
    )
    : { credits: 0, codes: new Set() };

  const consumedCodes = new Set([
    ...fixedUsedCodes,
    ...allocation.codes,
    ...creditAllocation.codes,
  ]);
  const fixedTarget = fixedCodes.length;
  const fixedCompleted = fixedCompletedCodes.length;
  const choiceCompleted = Math.min(allocation.totalSelected, choiceTarget);
  const creditCompleted = creditAllocation.credits;
  const targetPoints = fixedTarget + choiceTarget + creditsTarget / 3;
  const completedPoints = fixedCompleted + choiceCompleted + creditCompleted / 3;
  const complete = fixedCompleted === fixedTarget
    && choiceCompleted === choiceTarget
    && creditCompleted === creditsTarget
    && targetPoints > 0;
  const percent = targetPoints ? Math.round((completedPoints / targetPoints) * 100) : 0;
  const summaryParts = [];

  if (fixedTarget) summaryParts.push(`${fixedCompleted}/${fixedTarget} required`);
  if (choiceTarget) summaryParts.push(`${choiceCompleted}/${choiceTarget} choices`);
  if (creditsTarget) summaryParts.push(`${creditCompleted}/${creditsTarget} credits`);

  return {
    requirement,
    codes: candidateCodes,
    consumedCodes,
    completedCodes: candidateCodes.filter((code) => completedCodes.has(code)),
    fixedCompleted,
    fixedTarget,
    choiceCompleted,
    choiceTarget,
    creditCompleted,
    creditsTarget,
    completedPoints,
    targetPoints,
    percent,
    complete,
    summary: summaryParts.join(" · ") || "No measurable rules",
  };
}

export function calculateProgramProgress(program, courses, completedCodes) {
  const usedCodes = new Set();
  const requirements = [];

  for (const requirement of program.requirements || []) {
    const stats = requirementStats(requirement, program, courses, completedCodes, usedCodes);
    stats.consumedCodes.forEach((code) => usedCodes.add(code));
    requirements.push(stats);
  }

  const completedPoints = requirements.reduce((total, stats) => total + stats.completedPoints, 0);
  const targetPoints = requirements.reduce((total, stats) => total + stats.targetPoints, 0);
  const completedAreas = requirements.filter((stats) => stats.complete).length;

  return {
    requirements,
    usedCodes,
    completedAreas,
    totalAreas: requirements.length,
    percent: targetPoints ? Math.round((completedPoints / targetPoints) * 100) : 0,
  };
}
