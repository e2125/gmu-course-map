const COURSE_CODE_PATTERN = /\b([A-Z]{2,6})\s*(\d{3}[A-Z]?)\b/;
const COURSE_CODE_GLOBAL_PATTERN = /\b([A-Z]{2,6})\s*(\d{3}[A-Z]?)\b/g;
const COMPLETED_STORAGE_KEY = "gmu-course-map.completed-courses";
const MAX_RESULTS = 60;
const LATER_UNLOCK_DEPTH = 3;
const READY_NEXT_LIMIT = 12;

const state = {
  dataset: null,
  courses: [],
  coursesByCode: new Map(),
  completedCodes: new Set(),
  selectedCode: "CS 211",
};

const elements = {
  datasetPill: document.querySelector("#datasetPill"),
  search: document.querySelector("#courseSearch"),
  completedForm: document.querySelector("#completedForm"),
  completedInput: document.querySelector("#completedInput"),
  completedCount: document.querySelector("#completedCount"),
  readyCount: document.querySelector("#readyCount"),
  readyNextList: document.querySelector("#readyNextList"),
  clearProgressButton: document.querySelector("#clearProgressButton"),
  resultMeta: document.querySelector("#resultMeta"),
  courseResults: document.querySelector("#courseResults"),
  courseCode: document.querySelector("#courseCode"),
  courseTitle: document.querySelector("#courseTitle"),
  courseDescription: document.querySelector("#courseDescription"),
  selectedStatus: document.querySelector("#selectedStatus"),
  completedToggle: document.querySelector("#completedToggle"),
  impactNumber: document.querySelector("#impactNumber"),
  graphSummary: document.querySelector("#graphSummary"),
  dependencyGraph: document.querySelector("#dependencyGraph"),
  requiresCount: document.querySelector("#requiresCount"),
  requiresList: document.querySelector("#requiresList"),
  unlocksCount: document.querySelector("#unlocksCount"),
  unlocksList: document.querySelector("#unlocksList"),
  laterCount: document.querySelector("#laterCount"),
  laterList: document.querySelector("#laterList"),
  bottleneckList: document.querySelector("#bottleneckList"),
  rawPrereqText: document.querySelector("#rawPrereqText"),
};

function normalizeCourseCode(value) {
  const match = value.trim().toUpperCase().match(COURSE_CODE_PATTERN);
  return match ? `${match[1]} ${match[2]}` : null;
}

function extractCourseCodes(value) {
  const codes = new Set();
  for (const match of value.toUpperCase().matchAll(COURSE_CODE_GLOBAL_PATTERN)) {
    codes.add(`${match[1]} ${match[2]}`);
  }
  return [...codes].sort(compareCourses);
}

function courseSortKey(code) {
  const normalized = normalizeCourseCode(code);
  if (!normalized) return [code, 0, ""];

  const [subject, number] = normalized.split(" ");
  const match = number.match(/^(\d+)([A-Z]?)$/);
  return match ? [subject, Number(match[1]), match[2]] : [subject, 0, number];
}

function compareCourses(firstCode, secondCode) {
  const first = courseSortKey(firstCode);
  const second = courseSortKey(secondCode);

  if (first[0] !== second[0]) return first[0].localeCompare(second[0]);
  if (first[1] !== second[1]) return first[1] - second[1];
  return first[2].localeCompare(second[2]);
}

function getCourse(code) {
  return state.coursesByCode.get(code);
}

function isCompleted(code) {
  return state.completedCodes.has(code);
}

function getPrerequisiteLogic(course) {
  if (course.prerequisite_logic) {
    return course.prerequisite_logic;
  }

  const prerequisites = course.prerequisites || [];
  if (!prerequisites.length) {
    return null;
  }

  return {
    type: "all",
    items: prerequisites.map((code) => ({ type: "course", code })),
  };
}

function isLogicSatisfied(logic) {
  if (!logic) return true;

  if (logic.type === "course") {
    return isCompleted(logic.code);
  }

  const items = logic.items || [];
  if (logic.type === "any") {
    return items.some(isLogicSatisfied);
  }

  return items.every(isLogicSatisfied);
}

function countUnsatisfiedRequirements(logic) {
  if (!logic || isLogicSatisfied(logic)) return 0;

  if (logic.type === "course") {
    return 1;
  }

  if (logic.type === "any") {
    return 1;
  }

  return (logic.items || []).reduce(
    (total, item) => total + countUnsatisfiedRequirements(item),
    0,
  );
}

function collectLogicCourseCodes(logic) {
  if (!logic) return [];

  if (logic.type === "course") {
    return [logic.code];
  }

  return (logic.items || []).flatMap(collectLogicCourseCodes);
}

function applyRequirementMeta(logic, metaByCode) {
  if (!logic) return;

  if (logic.type === "course") {
    metaByCode.set(logic.code, isCompleted(logic.code) ? "done" : "needed");
    return;
  }

  if (logic.type === "any") {
    const groupSatisfied = isLogicSatisfied(logic);
    for (const code of collectLogicCourseCodes(logic)) {
      if (isCompleted(code)) {
        metaByCode.set(code, "done");
      } else {
        metaByCode.set(code, groupSatisfied ? "option" : "choose one");
      }
    }
    return;
  }

  for (const item of logic.items || []) {
    applyRequirementMeta(item, metaByCode);
  }
}

function getRequirementMetaByCode(course) {
  const metaByCode = new Map();
  applyRequirementMeta(getPrerequisiteLogic(course), metaByCode);
  return metaByCode;
}

function isCourseReady(course) {
  return isLogicSatisfied(getPrerequisiteLogic(course));
}

function getCourseStatus(course) {
  if (isCompleted(course.code)) {
    return { label: "Completed", tone: "done" };
  }

  const missingCount = countUnsatisfiedRequirements(getPrerequisiteLogic(course));
  if (!missingCount) {
    return { label: "Ready", tone: "ready" };
  }

  return { label: `${missingCount} missing`, tone: "blocked" };
}

function getCodeStatus(code) {
  const course = getCourse(code);
  if (course) {
    return getCourseStatus(course);
  }

  if (isCompleted(code)) {
    return { label: "Completed", tone: "done" };
  }

  return { label: "Needed", tone: "blocked" };
}

function formatCourseLabel(code) {
  const course = getCourse(code);
  return course ? `${code}: ${course.title}` : code;
}

function getSearchText(course) {
  return [course.code, course.title, course.description, course.prerequisite_text]
    .join(" ")
    .toLowerCase();
}

function findCourses(query) {
  const normalizedCode = normalizeCourseCode(query);
  const text = query.trim().toLowerCase();

  if (!text) {
    return state.courses.slice(0, MAX_RESULTS);
  }

  const exact = normalizedCode ? getCourse(normalizedCode) : null;
  const matches = state.courses.filter((course) => getSearchText(course).includes(text));

  if (exact && !matches.some((course) => course.code === exact.code)) {
    matches.unshift(exact);
  }

  return matches.slice(0, MAX_RESULTS);
}

function getUnlockChain(startCode, maxDepth) {
  const levels = new Map();
  const seen = new Set([startCode]);
  const queue = (state.dataset.unlocks[startCode] || []).map((code) => ({ code, depth: 1 }));

  while (queue.length) {
    const item = queue.shift();
    if (seen.has(item.code) || item.depth > maxDepth) continue;

    seen.add(item.code);
    if (!levels.has(item.depth)) levels.set(item.depth, []);
    levels.get(item.depth).push(item.code);

    for (const nextCode of state.dataset.unlocks[item.code] || []) {
      if (!seen.has(nextCode)) {
        queue.push({ code: nextCode, depth: item.depth + 1 });
      }
    }
  }

  return [...levels.entries()].map(([depth, codes]) => ({
    depth,
    codes: codes.sort(compareCourses),
  }));
}

function renderResults() {
  const matches = findCourses(elements.search.value);
  elements.resultMeta.textContent = `${matches.length} shown`;
  elements.courseResults.replaceChildren(
    ...matches.map((course) => {
      const button = document.createElement("button");
      button.className = "course-result";
      button.type = "button";
      button.dataset.active = String(course.code === state.selectedCode);
      button.addEventListener("click", () => selectCourse(course.code));

      const code = document.createElement("span");
      code.className = "result-code";
      code.textContent = course.code;

      const title = document.createElement("span");
      title.className = "result-title";
      title.textContent = course.title;

      const count = document.createElement("span");
      count.className = "result-count";
      count.textContent = `${course.direct_unlock_count || 0}`;

      if (isCompleted(course.code)) {
        const done = document.createElement("span");
        done.className = "result-done";
        done.textContent = "Done";
        title.append(done);
      }

      button.append(code, title, count);
      return button;
    }),
  );
}

function createCourseButton(code, metaText = "") {
  const button = document.createElement("button");
  button.className = "mini-course";
  button.type = "button";
  button.dataset.complete = String(isCompleted(code));

  if (getCourse(code)) {
    button.addEventListener("click", () => selectCourse(code));
  } else {
    button.disabled = true;
  }

  const label = document.createElement("span");
  label.className = "mini-course-label";
  label.textContent = formatCourseLabel(code);

  button.append(label);

  if (metaText) {
    const meta = document.createElement("span");
    meta.className = "mini-course-meta";
    meta.textContent = metaText;
    button.append(meta);
  }

  return button;
}

function renderCourseList(container, codes, emptyText, metaForCode = () => "") {
  container.replaceChildren();

  if (!codes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  for (const code of [...codes].sort(compareCourses)) {
    container.append(createCourseButton(code, metaForCode(code)));
  }
}

function renderLaterUnlocks(course) {
  const chain = getUnlockChain(course.code, LATER_UNLOCK_DEPTH);
  const later = chain.flatMap((level) =>
    level.depth > 1 ? level.codes.map((code) => ({ code, depth: level.depth })) : [],
  );

  elements.laterCount.textContent = String(later.length);
  elements.laterList.replaceChildren();

  if (!later.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No later unlocks found";
    elements.laterList.append(empty);
    return;
  }

  for (const item of later.sort((first, second) => compareCourses(first.code, second.code))) {
    elements.laterList.append(createCourseButton(item.code, `${item.depth} steps`));
  }
}

function createGraphNode(code, metaText = "", isCurrent = false) {
  const course = getCourse(code);
  const status = getCodeStatus(code);
  const button = document.createElement("button");
  button.className = "graph-node";
  button.type = "button";
  button.dataset.tone = status.tone;
  button.dataset.current = String(isCurrent);
  button.dataset.complete = String(isCompleted(code));

  if (course) {
    button.addEventListener("click", () => selectCourse(code));
  } else {
    button.disabled = true;
  }

  const codeText = document.createElement("span");
  codeText.className = "graph-node-code";
  codeText.textContent = code;

  const titleText = document.createElement("span");
  titleText.className = "graph-node-title";
  titleText.textContent = course?.title || "Outside current data";

  const meta = document.createElement("span");
  meta.className = "graph-node-meta";
  meta.textContent = metaText || status.label;

  button.append(codeText, titleText, meta);
  return button;
}

function createGraphColumn(title, codes, emptyText, metaForCode = () => "", markCurrent = false) {
  const column = document.createElement("section");
  column.className = "graph-column";
  column.setAttribute("aria-label", title);

  const heading = document.createElement("div");
  heading.className = "graph-column-title";
  heading.textContent = title;

  const body = document.createElement("div");
  body.className = "graph-column-body";

  if (!codes.length) {
    const empty = document.createElement("p");
    empty.className = "graph-empty";
    empty.textContent = emptyText;
    body.append(empty);
  } else {
    for (const code of [...codes].sort(compareCourses)) {
      body.append(createGraphNode(code, metaForCode(code), markCurrent && code === state.selectedCode));
    }
  }

  column.append(heading, body);
  return column;
}

function createGraphConnector(label = "to") {
  const connector = document.createElement("div");
  connector.className = "graph-connector";
  connector.setAttribute("aria-label", label);
  connector.textContent = "->";
  return connector;
}

function renderDependencyGraph(course) {
  const prerequisites = course.prerequisites || [];
  const directUnlocks = course.unlocks || [];
  const requirementMetaByCode = getRequirementMetaByCode(course);
  const chain = getUnlockChain(course.code, LATER_UNLOCK_DEPTH);
  const laterUnlocks = chain.flatMap((level) =>
    level.depth > 1 ? level.codes.map((code) => ({ code, depth: level.depth })) : [],
  );
  const laterCodes = laterUnlocks.map((item) => item.code);
  const laterDepthByCode = new Map(laterUnlocks.map((item) => [item.code, item.depth]));
  const totalVisible = prerequisites.length + 1 + directUnlocks.length + laterCodes.length;

  elements.graphSummary.textContent = `${totalVisible} visible`;
  elements.dependencyGraph.replaceChildren(
    createGraphColumn(
      "Requires",
      prerequisites,
      "No course prereqs",
      (code) => requirementMetaByCode.get(code) || "needed",
    ),
    createGraphConnector("requires selected course"),
    createGraphColumn(
      "Selected",
      [course.code],
      "",
      () => getCourseStatus(course).label.toLowerCase(),
      true,
    ),
    createGraphConnector("selected course unlocks direct courses"),
    createGraphColumn(
      "Direct Unlocks",
      directUnlocks,
      "No direct unlocks",
      (code) => getCodeStatus(code).label.toLowerCase(),
    ),
    createGraphConnector("direct unlocks can lead to later courses"),
    createGraphColumn(
      "Later",
      laterCodes,
      "No later unlocks",
      (code) => `${laterDepthByCode.get(code)} steps`,
    ),
  );

}

function getReadyCourses() {
  return state.courses
    .filter((course) => !isCompleted(course.code) && isCourseReady(course))
    .sort((first, second) => {
      if (second.direct_unlock_count !== first.direct_unlock_count) {
        return second.direct_unlock_count - first.direct_unlock_count;
      }
      return compareCourses(first.code, second.code);
    });
}

function renderPlanner() {
  const readyCourses = getReadyCourses();
  elements.completedCount.textContent = String(state.completedCodes.size);
  elements.readyCount.textContent = String(readyCourses.length);

  const readyNext = readyCourses.slice(0, READY_NEXT_LIMIT);
  elements.readyNextList.replaceChildren();

  if (!readyNext.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No ready courses found";
    elements.readyNextList.append(empty);
    return;
  }

  for (const course of readyNext) {
    elements.readyNextList.append(createCourseButton(course.code, `${course.direct_unlock_count} unlocks`));
  }
}

function renderBottlenecks() {
  const bottlenecks = [...state.courses]
    .filter((course) => course.direct_unlock_count > 0)
    .sort((first, second) => {
      if (second.direct_unlock_count !== first.direct_unlock_count) {
        return second.direct_unlock_count - first.direct_unlock_count;
      }
      return compareCourses(first.code, second.code);
    })
    .slice(0, 8);

  elements.bottleneckList.replaceChildren(
    ...bottlenecks.map((course) =>
      createCourseButton(course.code, `${course.direct_unlock_count} unlocks`),
    ),
  );
}

function selectCourse(code) {
  const course = getCourse(code);
  if (!course) return;

  state.selectedCode = code;
  elements.courseCode.textContent = course.code;
  elements.courseTitle.textContent = course.title;
  elements.courseDescription.textContent = course.description || "No description found.";
  elements.impactNumber.textContent = String(course.direct_unlock_count || 0);

  const prerequisites = course.prerequisites || [];
  const unlocks = course.unlocks || [];
  const status = getCourseStatus(course);
  const requirementMetaByCode = getRequirementMetaByCode(course);
  elements.requiresCount.textContent = String(prerequisites.length);
  elements.unlocksCount.textContent = String(unlocks.length);
  elements.rawPrereqText.textContent = course.prerequisite_text || "No required prerequisite text found.";
  elements.selectedStatus.textContent = status.label;
  elements.selectedStatus.dataset.tone = status.tone;
  elements.completedToggle.textContent = isCompleted(course.code) ? "Remove Complete" : "Mark Complete";

  renderCourseList(
    elements.requiresList,
    prerequisites,
    "No required course prerequisites found",
    (prereqCode) => requirementMetaByCode.get(prereqCode) || "needed",
  );
  renderCourseList(
    elements.unlocksList,
    unlocks,
    "No direct unlocks found",
    (unlockCode) => getCourseStatus(getCourse(unlockCode)).label.toLowerCase(),
  );
  renderDependencyGraph(course);
  renderLaterUnlocks(course);
  renderPlanner();
  renderResults();
}

function saveCompletedCodes() {
  localStorage.setItem(
    COMPLETED_STORAGE_KEY,
    JSON.stringify([...state.completedCodes].sort(compareCourses)),
  );
}

function loadCompletedCodes() {
  try {
    const saved = JSON.parse(localStorage.getItem(COMPLETED_STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) {
      state.completedCodes = new Set(saved.map(normalizeCourseCode).filter(Boolean));
    }
  } catch {
    state.completedCodes = new Set();
  }
}

function addCompletedCourses(rawValue) {
  const codes = extractCourseCodes(rawValue);
  for (const code of codes) {
    state.completedCodes.add(code);
  }

  if (codes.length) {
    saveCompletedCodes();
    selectCourse(state.selectedCode);
  }

  return codes.length;
}

function toggleSelectedCompleted() {
  const course = getCourse(state.selectedCode);
  if (!course) return;

  if (isCompleted(course.code)) {
    state.completedCodes.delete(course.code);
  } else {
    state.completedCodes.add(course.code);
  }

  saveCompletedCodes();
  selectCourse(course.code);
}

async function loadCourses() {
  const response = await fetch("data/courses.json");
  if (!response.ok) {
    throw new Error(`Could not load data/courses.json (${response.status})`);
  }

  state.dataset = await response.json();
  loadCompletedCodes();
  state.courses = [...state.dataset.courses].sort((first, second) =>
    compareCourses(first.code, second.code),
  );
  state.coursesByCode = new Map(state.courses.map((course) => [course.code, course]));

  const departments = state.dataset.metadata?.departments || [];
  elements.datasetPill.textContent =
    departments.length > 3 ? `${departments.length} subjects` : departments.join(" + ") || "Courses";
  elements.datasetPill.title = departments.join(", ");

  if (!getCourse(state.selectedCode) && state.courses.length) {
    state.selectedCode = state.courses[0].code;
  }

  renderBottlenecks();
  renderResults();
  selectCourse(state.selectedCode);
}

elements.search.addEventListener("input", renderResults);
elements.completedToggle.addEventListener("click", toggleSelectedCompleted);
elements.completedForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const addedCount = addCompletedCourses(elements.completedInput.value);
  if (addedCount) {
    elements.completedInput.value = "";
  }
});
elements.clearProgressButton.addEventListener("click", () => {
  state.completedCodes.clear();
  saveCompletedCodes();
  selectCourse(state.selectedCode);
});

loadCourses().catch((error) => {
  document.body.innerHTML = `
    <main class="load-error">
      <h1>Could not load course data</h1>
      <p>${error.message}</p>
    </main>
  `;
});
