function uniqueCodes(codes) {
  return [...new Set(codes.filter(Boolean))];
}

export function buildConnectedMapModel({
  course,
  path,
  unlocksByCode,
  directCodes: requestedDirectCodes = null,
  laterLimit = 24,
}) {
  const classifiedDirectCodes = [
    ...path.newlyReady,
    ...path.alreadyReady,
    ...path.stillBlocked,
  ];
  const directCodes = uniqueCodes(requestedDirectCodes || classifiedDirectCodes);
  const directSet = new Set(directCodes);
  const laterItems = path.later
    .filter((item) => !directSet.has(item.code))
    .slice(0, laterLimit);
  const laterCodes = laterItems.map((item) => item.code);
  const visibleBranchCodes = new Set([...directCodes, ...laterCodes]);
  const directCategoryByCode = new Map([
    ...path.newlyReady.map((code) => [code, "newly-ready"]),
    ...path.alreadyReady.map((code) => [code, "already-ready"]),
    ...path.stillBlocked.map((code) => [code, "blocked"]),
  ]);
  const laterDepthByCode = new Map(
    laterItems.map((item) => [item.code, item.depth]),
  );
  const edges = path.prerequisites.map((code) => ({
    source: code,
    target: course.code,
    kind: "requirement",
    indirect: false,
  }));

  for (const code of directCodes) {
    edges.push({
      source: course.code,
      target: code,
      kind: "direct",
      indirect: false,
    });
  }

  for (const item of laterItems) {
    const parents = [...visibleBranchCodes].filter((code) =>
      (unlocksByCode[code] || []).includes(item.code),
    );
    if (parents.length) {
      for (const parent of parents) {
        edges.push({
          source: parent,
          target: item.code,
          kind: "later",
          indirect: false,
        });
      }
    } else {
      edges.push({
        source: course.code,
        target: item.code,
        kind: "later",
        indirect: true,
      });
    }
  }

  return {
    stages: {
      before: uniqueCodes(path.prerequisites),
      current: [course.code],
      next: directCodes,
      later: laterCodes,
    },
    directCategoryByCode,
    laterDepthByCode,
    edges,
    hiddenLaterCount: Math.max(0, path.later.length - laterItems.length),
  };
}
