import {
  calculateProgramProgress,
  getRequirementCandidateCodes,
} from "./degree-progress.js";
import { analyzeDegreeAuditText } from "./audit-import.js?v=20260807-stellic-v1";
import { buildConnectedMapModel } from "./connected-map.js";
import {
  buildCourseImpactPath,
  countUnsatisfiedRequirements as countUnsatisfiedRequirementsWith,
  getPrerequisiteLogic,
  isCourseReady as isCourseReadyWith,
  isLogicSatisfied as isLogicSatisfiedWith,
  requiresManualPrerequisiteReview,
} from "./course-path.js";
import {
  buildShareUrl,
  comparePlanCourses,
  normalizePlanCourseCodes,
  parsePlanId,
} from "./plan-sharing.js";
import { getCourseSearchRank, searchCourses } from "./course-search.js";

const COURSE_CODE_PATTERN = /\b([A-Z]{2,6})\s*(\d{3}[A-Z]?)\b/;
const COURSE_CODE_GLOBAL_PATTERN = /\b([A-Z]{2,6})\s*(\d{3}[A-Z]?)\b/g;
const COMPLETED_STORAGE_KEY = "gmu-course-map.completed-courses";
const PLAN_TOKEN_STORAGE_PREFIX = "gmu-course-map.plan-token.";
const MAX_RESULTS = 60;
const LATER_UNLOCK_DEPTH = 3;
const READY_NEXT_LIMIT = 4;
const DEGREE_PROGRESS_LIMIT = 4;
const DIRECT_MAP_LIMIT = 6;
const LATER_MAP_LIMIT = 6;
const SEARCH_SUGGESTION_LIMIT = 7;

const state = {
  dataset: null,
  programsData: null,
  programs: [],
  programCourseIndex: new Map(),
  courses: [],
  coursesByCode: new Map(),
  completedCodes: new Set(),
  selectedCode: "CS 211",
  activeScopeId: "cs-bs-2026",
  activePlanId: null,
  activePlanToken: null,
  planName: "",
  planDirty: false,
  planBusy: false,
  planStatus: "Your progress is saved in this browser. Save it to create a share link.",
  comparisonPlan: null,
  auditCourses: [],
  auditAnalysis: null,
  auditLastFocus: null,
  activeSuggestionIndex: -1,
  searchSuggestions: [],
};

const elements = {
  datasetPill: document.querySelector("#datasetPill"),
  search: document.querySelector("#courseSearch"),
  searchCombobox: document.querySelector("#searchCombobox"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  openAuditImportButton: document.querySelector("#openAuditImportButton"),
  auditImportModal: document.querySelector("#auditImportModal"),
  closeAuditImportButton: document.querySelector("#closeAuditImportButton"),
  cancelAuditImportButton: document.querySelector("#cancelAuditImportButton"),
  auditFileInput: document.querySelector("#auditFileInput"),
  auditDropzone: document.querySelector("#auditDropzone"),
  auditPasteInput: document.querySelector("#auditPasteInput"),
  analyzeAuditTextButton: document.querySelector("#analyzeAuditTextButton"),
  auditImportStatus: document.querySelector("#auditImportStatus"),
  auditImportResults: document.querySelector("#auditImportResults"),
  auditResultsSummary: document.querySelector("#auditResultsSummary"),
  auditCourseList: document.querySelector("#auditCourseList"),
  auditExceptionNote: document.querySelector("#auditExceptionNote"),
  toggleAuditCoursesButton: document.querySelector("#toggleAuditCoursesButton"),
  applyAuditImportButton: document.querySelector("#applyAuditImportButton"),
  courseHero: document.querySelector("#courseHero"),
  graphPanel: document.querySelector("#graphPanel"),
  connectedMap: document.querySelector("#connectedMap"),
  courseMapEdges: document.querySelector("#courseMapEdges"),
  scopeSelect: document.querySelector("#scopeSelect"),
  scopeMeta: document.querySelector("#scopeMeta"),
  degreeProgressPanel: document.querySelector("#degreeProgressPanel"),
  degreeProgressSummary: document.querySelector("#degreeProgressSummary"),
  degreeProgressBar: document.querySelector("#degreeProgressBar"),
  degreeProgressList: document.querySelector("#degreeProgressList"),
  completedForm: document.querySelector("#completedForm"),
  completedInput: document.querySelector("#completedInput"),
  completedCount: document.querySelector("#completedCount"),
  readyCount: document.querySelector("#readyCount"),
  readyNextList: document.querySelector("#readyNextList"),
  clearProgressButton: document.querySelector("#clearProgressButton"),
  planNameInput: document.querySelector("#planNameInput"),
  planAccess: document.querySelector("#planAccess"),
  savePlanButton: document.querySelector("#savePlanButton"),
  copyPlanLinkButton: document.querySelector("#copyPlanLinkButton"),
  planShareUrl: document.querySelector("#planShareUrl"),
  planStatus: document.querySelector("#planStatus"),
  comparePlanInput: document.querySelector("#comparePlanInput"),
  comparePlanButton: document.querySelector("#comparePlanButton"),
  comparisonResult: document.querySelector("#comparisonResult"),
  courseCode: document.querySelector("#courseCode"),
  courseTitle: document.querySelector("#courseTitle"),
  courseDescription: document.querySelector("#courseDescription"),
  selectedStatus: document.querySelector("#selectedStatus"),
  degreeTag: document.querySelector("#degreeTag"),
  completedToggle: document.querySelector("#completedToggle"),
  impactNumber: document.querySelector("#impactNumber"),
  graphSummary: document.querySelector("#graphSummary"),
  dependencyGraph: document.querySelector("#dependencyGraph"),
  requiresCount: document.querySelector("#requiresCount"),
  unlocksCount: document.querySelector("#unlocksCount"),
  laterCount: document.querySelector("#laterCount"),
  bottleneckList: document.querySelector("#bottleneckList"),
  rawPrereqText: document.querySelector("#rawPrereqText"),
};

let visibleMapEdges = [];
let highlightedMapCode = null;
let mapDrawFrame = 0;

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

function openAuditImport() {
  state.auditLastFocus = document.activeElement;
  elements.auditImportModal.hidden = false;
  elements.closeAuditImportButton.focus();
}

function closeAuditImport() {
  elements.auditImportModal.hidden = true;
  if (state.auditLastFocus instanceof HTMLElement) {
    state.auditLastFocus.focus();
  }
}

function getAuditStatusLabel(course) {
  if (course.status === "completed") {
    return course.grade ? `Completed · ${course.grade}` : "Completed";
  }
  if (course.status === "in-progress") return "Registered / in progress";
  if (course.status === "not-completed") {
    return course.grade ? `Not completed · ${course.grade}` : "Not completed";
  }
  return "Needs review";
}

function getSelectedAuditCodes() {
  return state.auditCourses.filter((course) => course.selected).map((course) => course.code);
}

function updateAuditApplyButton() {
  const selectedCount = getSelectedAuditCodes().length;
  elements.applyAuditImportButton.disabled = selectedCount === 0;
  elements.applyAuditImportButton.textContent = selectedCount
    ? `Add ${selectedCount} completed course${selectedCount === 1 ? "" : "s"}`
    : "Add completed courses";
  const completedCourses = state.auditCourses.filter((course) => course.status === "completed");
  const allCompletedSelected = completedCourses.length
    && completedCourses.every((course) => course.selected);
  elements.toggleAuditCoursesButton.textContent = allCompletedSelected
    ? "Clear selection"
    : "Select completed";
}

function createAuditCourseRow(course) {
  const label = document.createElement("label");
  label.className = "audit-course-row";
  label.dataset.status = course.status;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = course.selected;
  checkbox.disabled = course.status === "in-progress" || course.status === "not-completed";
  checkbox.addEventListener("change", () => {
    course.selected = checkbox.checked;
    updateAuditApplyButton();
  });

  const copy = document.createElement("span");
  const code = document.createElement("strong");
  code.textContent = course.code;
  const title = document.createElement("small");
  title.textContent = getCourse(course.code)?.title || "Course not found in the current catalog";
  copy.append(code, title);

  const status = document.createElement("em");
  status.textContent = getAuditStatusLabel(course);
  label.append(checkbox, copy, status);
  return label;
}

function renderAuditAnalysis(analysis, sourceLabel) {
  state.auditAnalysis = analysis;
  const knownCourses = analysis.courses.filter((course) => state.coursesByCode.has(course.code));
  const unknownCount = analysis.courses.length - knownCourses.length;
  state.auditCourses = knownCourses.map((course) => ({
    ...course,
    selected: course.status === "completed",
  }));

  elements.auditImportResults.hidden = !state.auditCourses.length;
  elements.auditCourseList.replaceChildren(...state.auditCourses.map(createAuditCourseRow));
  const completedCount = state.auditCourses.filter((course) => course.status === "completed").length;
  const inProgressCount = state.auditCourses.filter((course) => course.status === "in-progress").length;
  const reviewCount = state.auditCourses.filter((course) => course.status === "review").length;
  elements.auditResultsSummary.textContent = [
    `${completedCount} completed`,
    `${inProgressCount} in progress`,
    reviewCount ? `${reviewCount} to review` : null,
  ].filter(Boolean).join(" · ");
  elements.auditImportStatus.textContent = state.auditCourses.length
    ? `${sourceLabel} analyzed locally. Review the detected courses before adding them.`
    : `No recognizable catalog courses were found in ${sourceLabel}. Try the Extended report or paste its text.`;
  if (unknownCount) {
    elements.auditImportStatus.textContent += ` ${unknownCount} course code${unknownCount === 1 ? " was" : "s were"} outside the current catalog data.`;
  }

  elements.auditExceptionNote.hidden = analysis.exceptionDetailCount === 0;
  elements.auditExceptionNote.textContent = analysis.exceptionDetailCount
    ? "Exception details were detected. Substitutions and waivers are flagged for review and are not applied automatically."
    : "";
  updateAuditApplyButton();
}

function buildPdfPageText(items) {
  const lines = [];
  let currentLine = [];
  let lastY = null;

  const flushLine = () => {
    const line = currentLine.join(" ").replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
    currentLine = [];
  };

  for (const item of items) {
    if (!("str" in item)) continue;
    const y = item.transform?.[5] ?? lastY;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) flushLine();
    if (item.str.trim()) currentLine.push(item.str.trim());
    if (item.hasEOL) flushLine();
    lastY = y;
  }
  flushLine();
  return lines.join("\n");
}

async function extractPdfAuditText(file) {
  const pdfjs = await import("../vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "../vendor/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document = await loadingTask.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(buildPdfPageText(content.items));
  }
  await document.destroy();
  return pages.join("\n");
}

async function analyzeAuditFile(file) {
  if (!file) return;
  elements.auditImportStatus.textContent = `Reading ${file.name}…`;
  elements.auditImportResults.hidden = true;
  elements.applyAuditImportButton.disabled = true;
  try {
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const text = isPdf ? await extractPdfAuditText(file) : await file.text();
    renderAuditAnalysis(analyzeDegreeAuditText(text), file.name);
  } catch (error) {
    elements.auditImportStatus.textContent =
      `This audit could not be read: ${error.message}. Try downloading the Extended PDF again or paste the audit text.`;
  }
}

function applyAuditImport() {
  const selectedCodes = getSelectedAuditCodes();
  if (!selectedCodes.length) return;
  for (const code of selectedCodes) state.completedCodes.add(code);
  saveCompletedCodes();
  markPlanDirty();
  state.planStatus = `${selectedCodes.length} completed course${selectedCodes.length === 1 ? "" : "s"} imported from your degree audit.`;
  selectCourse(state.selectedCode);
  closeAuditImport();
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

function getCourseNumber(code) {
  const normalized = normalizeCourseCode(code);
  if (!normalized) return 0;

  const number = normalized.split(" ")[1];
  const match = number.match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

function getCourse(code) {
  return state.coursesByCode.get(code);
}

function buildProgramCourseIndex(program) {
  const index = new Map();

  for (const requirement of program.requirements || []) {
    for (const code of getRequirementCandidateCodes(requirement, state.courses)) {
      if (!index.has(code)) {
        index.set(code, []);
      }
      index.get(code).push({
        label: requirement.label,
        role: requirement.role,
        source: "requirement",
      });
    }
  }

  return index;
}

function getActiveProgram() {
  if (state.activeScopeId === "all") return null;
  return state.programs.find((program) => program.id === state.activeScopeId) || null;
}

function getDefaultPlanName() {
  const program = getActiveProgram();
  return program ? `${program.name} plan` : "My GMU course plan";
}

function getProgramInfo(code) {
  const program = getActiveProgram();
  if (!program) return null;

  const directMatches = state.programCourseIndex.get(code) || [];
  const normalized = normalizeCourseCode(code);
  if (!normalized) return directMatches.length ? { entries: directMatches } : null;

  const ruleMatches = [];
  const subject = normalized.split(" ")[0];
  const number = getCourseNumber(normalized);
  // Backward compatibility for first-pass program files that stored rules globally.
  for (const rule of program.rules || []) {
    if (rule.subject !== subject) continue;
    if (number < rule.min_number) continue;
    if ((rule.exclude || []).includes(normalized)) continue;

    ruleMatches.push({
      label: rule.label,
      role: rule.role,
      source: "rule",
    });
  }

  const entries = [...directMatches, ...ruleMatches];
  return entries.length ? { entries } : null;
}

function isCourseInScope(code) {
  return Boolean(getCourse(code));
}

function filterCodesToScope(codes) {
  return codes.filter((code) => state.coursesByCode.has(code));
}

function getDegreeLabel(code) {
  const info = getProgramInfo(code);
  if (!info) return "Outside focus";

  const required = info.entries.find((entry) => entry.role === "required");
  const entry = required || info.entries[0];
  return entry.label;
}

function getScopedCourses() {
  return state.courses.filter((course) => isCourseInScope(course.code));
}

function addReadyCourseStats(stats) {
  const readyCodes = stats.codes
    .filter((code) => {
      const course = getCourse(code);
      return course && !isCompleted(code) && isCourseReady(course);
    })
    .sort((firstCode, secondCode) => {
      const firstCourse = getCourse(firstCode);
      const secondCourse = getCourse(secondCode);
      const firstUnlocks = filterCodesToScope(firstCourse?.unlocks || []).length;
      const secondUnlocks = filterCodesToScope(secondCourse?.unlocks || []).length;
      if (secondUnlocks !== firstUnlocks) {
        return secondUnlocks - firstUnlocks;
      }
      return compareCourses(firstCode, secondCode);
    });

  return {
    ...stats,
    readyCodes,
    readyCount: readyCodes.length,
  };
}

function getRequirementJumpCode(stats) {
  const incompleteReadyCode = stats.readyCodes[0];
  if (incompleteReadyCode) return incompleteReadyCode;

  return stats.codes.find((code) => !isCompleted(code)) || stats.codes[0] || null;
}

function createDegreeProgressRow(requirement, evaluatedStats) {
  const stats = addReadyCourseStats(evaluatedStats);
  const jumpCode = getRequirementJumpCode(stats);
  const row = document.createElement("button");
  row.className = "degree-row";
  row.type = "button";
  row.disabled = !jumpCode;
  row.dataset.active = String(stats.codes.includes(state.selectedCode));
  row.dataset.complete = String(stats.complete);
  row.setAttribute(
    "aria-label",
    `${requirement.label}: ${stats.summary}. ${stats.readyCount} ready next.`,
  );
  row.addEventListener("click", () => {
    if (jumpCode) {
      selectCourse(jumpCode);
    }
  });

  const top = document.createElement("span");
  top.className = "degree-row-top";

  const label = document.createElement("strong");
  label.textContent = requirement.label;

  const count = document.createElement("span");
  count.textContent = stats.complete ? "Complete" : `${stats.percent}%`;

  const track = document.createElement("span");
  track.className = "degree-row-track";

  const fill = document.createElement("span");
  fill.style.width = `${stats.percent}%`;
  track.append(fill);

  const meta = document.createElement("span");
  meta.className = "degree-row-meta";
  meta.textContent = `${stats.summary} · ${stats.readyCount} ready`;

  top.append(label, count);
  row.append(top, track, meta);
  return row;
}

function renderDegreeProgress() {
  const activeProgram = getActiveProgram();
  if (!activeProgram) {
    elements.degreeProgressPanel.hidden = true;
    return;
  }

  elements.degreeProgressPanel.hidden = false;
  const progress = calculateProgramProgress(
    activeProgram,
    state.courses,
    state.completedCodes,
  );

  elements.degreeProgressSummary.textContent =
    `${progress.completedAreas}/${progress.totalAreas} areas`;
  elements.degreeProgressBar.style.width = `${progress.percent}%`;
  elements.degreeProgressBar.parentElement.setAttribute("aria-valuenow", String(progress.percent));
  elements.degreeProgressList.replaceChildren(
    ...progress.requirements.slice(0, DEGREE_PROGRESS_LIMIT).map((stats) =>
      createDegreeProgressRow(stats.requirement, stats),
    ),
  );
}

function renderScopeOptions() {
  elements.scopeSelect.replaceChildren();

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "No degree selected";
  elements.scopeSelect.append(allOption);

  for (const program of state.programs) {
    const option = document.createElement("option");
    option.value = program.id;
    option.textContent = program.label || program.name;
    elements.scopeSelect.append(option);
  }

  if (state.activeScopeId !== "all" && !getActiveProgram()) {
    state.activeScopeId = "all";
  }

  const activeProgram = getActiveProgram();
  state.programCourseIndex = activeProgram ? buildProgramCourseIndex(activeProgram) : new Map();
  elements.scopeSelect.value = state.activeScopeId;
  renderScopeMeta();
}

function renderScopeMeta() {
  const activeProgram = getActiveProgram();
  if (!activeProgram) {
    elements.scopeMeta.textContent = `All ${state.courses.length} catalog courses are searchable.`;
    return;
  }

  const modeledCount = state.courses.filter((course) => Boolean(getProgramInfo(course.code))).length;
  elements.scopeMeta.textContent = `${activeProgram.name}: ${modeledCount} modeled degree candidates; all ${state.courses.length} catalog courses searchable.`;
}

function isCompleted(code) {
  return state.completedCodes.has(code);
}

function isLogicSatisfied(logic) {
  return isLogicSatisfiedWith(logic, state.completedCodes);
}

function countUnsatisfiedRequirements(logic) {
  return countUnsatisfiedRequirementsWith(logic, state.completedCodes);
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
  return isCourseReadyWith(course, state.completedCodes);
}

function getCourseStatus(course) {
  if (isCompleted(course.code)) {
    return { label: "Completed", tone: "done" };
  }

  if (requiresManualPrerequisiteReview(course)) {
    return { label: "Check catalog", tone: "blocked" };
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

function findCourses(query) {
  const scopedCourses = getScopedCourses();
  return searchCourses(scopedCourses, query, compareCourses, MAX_RESULTS);
}

function closeSearchSuggestions() {
  state.activeSuggestionIndex = -1;
  state.searchSuggestions = [];
  elements.searchSuggestions.hidden = true;
  elements.searchSuggestions.replaceChildren();
  elements.search.setAttribute("aria-expanded", "false");
  elements.search.removeAttribute("aria-activedescendant");
}

function getSuggestionReason(course, query) {
  const rank = getCourseSearchRank(course, query);
  const reasons = {
    0: "Exact course",
    1: "Course code",
    2: "Title match",
    3: "Course match",
    4: "Description match",
    5: "Listed as a prerequisite",
  };
  const programLabel = getProgramInfo(course.code) ? getDegreeLabel(course.code) : null;
  return [reasons[rank] || "Recommended", programLabel].filter(Boolean).join(" · ");
}

function selectCourseFromSearch(code) {
  elements.search.value = code;
  closeSearchSuggestions();
  selectCourse(code);
}

function renderSearchSuggestions() {
  const query = elements.search.value.trim();
  if (query.length < 2) {
    closeSearchSuggestions();
    return;
  }

  state.searchSuggestions = searchCourses(
    state.courses,
    query,
    compareCourses,
    SEARCH_SUGGESTION_LIMIT,
  );
  if (!state.searchSuggestions.length) {
    closeSearchSuggestions();
    return;
  }

  if (
    state.activeSuggestionIndex < 0
    || state.activeSuggestionIndex >= state.searchSuggestions.length
  ) {
    state.activeSuggestionIndex = 0;
  }

  elements.searchSuggestions.replaceChildren(
    ...state.searchSuggestions.map((course, index) => {
      const button = document.createElement("button");
      button.className = "search-suggestion";
      button.id = `searchSuggestion${index}`;
      button.type = "button";
      button.role = "option";
      button.dataset.active = String(index === state.activeSuggestionIndex);
      button.setAttribute("aria-selected", String(index === state.activeSuggestionIndex));
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => selectCourseFromSearch(course.code));

      const code = document.createElement("strong");
      code.textContent = course.code;
      const title = document.createElement("span");
      title.textContent = course.title;
      const reason = document.createElement("small");
      reason.textContent = getSuggestionReason(course, query);
      button.append(code, title, reason);
      return button;
    }),
  );
  elements.searchSuggestions.hidden = false;
  elements.search.setAttribute("aria-expanded", "true");
  elements.search.setAttribute(
    "aria-activedescendant",
    `searchSuggestion${state.activeSuggestionIndex}`,
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

function setMapHighlight(code = null) {
  highlightedMapCode = code;
  const relatedCodes = new Set(code ? [code] : []);
  if (code) {
    for (const edge of visibleMapEdges) {
      if (edge.source === code || edge.target === code) {
        relatedCodes.add(edge.source);
        relatedCodes.add(edge.target);
      }
    }
  }

  for (const node of elements.dependencyGraph.querySelectorAll("[data-map-id]")) {
    node.dataset.dimmed = String(Boolean(code) && !relatedCodes.has(node.dataset.mapId));
  }
  scheduleMapEdgeDraw();
}

function scheduleMapEdgeDraw() {
  if (mapDrawFrame) cancelAnimationFrame(mapDrawFrame);
  mapDrawFrame = requestAnimationFrame(() => {
    mapDrawFrame = 0;
    drawCourseMapEdges();
  });
}

function getMapNode(code) {
  return [...elements.dependencyGraph.querySelectorAll("[data-map-id]")]
    .find((node) => node.dataset.mapId === code);
}

function getEdgeColor(kind) {
  const styles = getComputedStyle(document.documentElement);
  const property = kind === "requirement"
    ? "--before"
    : kind === "direct"
      ? "--next"
      : "--later";
  return styles.getPropertyValue(property).trim();
}

function drawArrowHead(context, x, y, angle, color, opacity) {
  const size = 6;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.globalAlpha = opacity;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(-size, -size * 0.66);
  context.lineTo(-size, size * 0.66);
  context.closePath();
  context.fill();
  context.restore();
}

function drawCourseMapEdges() {
  const canvas = elements.courseMapEdges;
  const map = elements.connectedMap;
  if (!canvas || !map) return;

  const mapRect = map.getBoundingClientRect();
  const width = Math.max(1, map.scrollWidth);
  const height = Math.max(1, map.scrollHeight);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineCap = "round";
  context.lineJoin = "round";

  const orderedEdges = [...visibleMapEdges].sort((first, second) => {
    const firstActive = highlightedMapCode
      && (first.source === highlightedMapCode || first.target === highlightedMapCode);
    const secondActive = highlightedMapCode
      && (second.source === highlightedMapCode || second.target === highlightedMapCode);
    return Number(firstActive) - Number(secondActive);
  });

  for (const edge of orderedEdges) {
    const source = getMapNode(edge.source);
    const target = getMapNode(edge.target);
    if (!source || !target) continue;

    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const horizontal = targetRect.left > sourceRect.right + 12;
    const start = horizontal
      ? {
        x: sourceRect.right - mapRect.left,
        y: sourceRect.top + sourceRect.height / 2 - mapRect.top,
      }
      : {
        x: sourceRect.left + sourceRect.width / 2 - mapRect.left,
        y: sourceRect.bottom - mapRect.top,
      };
    const end = horizontal
      ? {
        x: targetRect.left - mapRect.left,
        y: targetRect.top + targetRect.height / 2 - mapRect.top,
      }
      : {
        x: targetRect.left + targetRect.width / 2 - mapRect.left,
        y: targetRect.top - mapRect.top,
      };
    const active = !highlightedMapCode
      || edge.source === highlightedMapCode
      || edge.target === highlightedMapCode;
    const opacity = highlightedMapCode ? (active ? 0.9 : 0.08) : 0.42;
    const color = getEdgeColor(edge.kind);

    context.save();
    context.globalAlpha = opacity;
    context.strokeStyle = color;
    context.lineWidth = active && highlightedMapCode ? 3 : 2;
    context.setLineDash(edge.indirect ? [7, 6] : []);
    context.beginPath();
    context.moveTo(start.x, start.y);
    if (horizontal) {
      const bend = Math.max(28, (end.x - start.x) * 0.52);
      context.bezierCurveTo(
        start.x + bend,
        start.y,
        end.x - bend,
        end.y,
        end.x,
        end.y,
      );
    } else {
      const bend = Math.max(24, (end.y - start.y) * 0.5);
      context.bezierCurveTo(
        start.x,
        start.y + bend,
        end.x,
        end.y - bend,
        end.x,
        end.y,
      );
    }
    context.stroke();
    context.restore();
    drawArrowHead(
      context,
      end.x,
      end.y,
      horizontal ? 0 : Math.PI / 2,
      color,
      opacity,
    );
  }
}

function createGraphNode(
  code,
  metaText = "",
  isCurrent = false,
  toneOverride = null,
  stage = "",
) {
  const course = getCourse(code);
  const status = getCodeStatus(code);
  const button = document.createElement("button");
  button.className = "graph-node";
  button.type = "button";
  button.dataset.mapId = code;
  button.dataset.stage = stage;
  button.dataset.tone = toneOverride || status.tone;
  button.dataset.current = String(isCurrent);
  button.dataset.complete = String(isCompleted(code));

  if (course) {
    button.addEventListener("click", () => selectCourse(code));
  } else {
    button.disabled = true;
  }
  button.addEventListener("pointerenter", () => setMapHighlight(code));
  button.addEventListener("pointerleave", () => setMapHighlight());
  button.addEventListener("focus", () => setMapHighlight(code));
  button.addEventListener("blur", () => setMapHighlight());

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

function createGraphColumn({
  step,
  title,
  stage,
  codes,
  emptyText,
  metaForCode = () => "",
  toneForCode = () => null,
  markCurrent = false,
  overflowCount = 0,
}) {
  const column = document.createElement("section");
  column.className = "graph-column";
  column.dataset.stage = stage;
  column.setAttribute("aria-label", title);

  const heading = document.createElement("div");
  heading.className = "graph-column-title";
  const stepText = document.createElement("span");
  stepText.textContent = step;
  const titleText = document.createElement("strong");
  titleText.textContent = title;
  const count = document.createElement("em");
  count.textContent = String(codes.length);
  heading.append(stepText, titleText, count);

  const body = document.createElement("div");
  body.className = "graph-column-body";

  if (!codes.length) {
    const empty = document.createElement("p");
    empty.className = "graph-empty";
    empty.textContent = emptyText;
    body.append(empty);
  } else {
    for (const code of codes) {
      body.append(
        createGraphNode(
          code,
          metaForCode(code),
          markCurrent && code === state.selectedCode,
          toneForCode(code),
          stage,
        ),
      );
    }
  }

  if (overflowCount > 0) {
    const overflow = document.createElement("p");
    overflow.className = "graph-overflow";
    overflow.textContent = `+${overflowCount} more paths beyond this view`;
    body.append(overflow);
  }

  column.append(heading, body);
  return column;
}

function renderDependencyGraph(course) {
  const path = buildCourseImpactPath({
    course,
    coursesByCode: state.coursesByCode,
    unlocksByCode: state.dataset.unlocks,
    completedCodes: state.completedCodes,
    includeCode: isCourseInScope,
    compareCodes: compareCourses,
    maxDepth: LATER_UNLOCK_DEPTH,
    laterLimit: 32,
  });
  const allDirectCodes = filterCodesToScope(course.unlocks || []);
  const directCodes = allDirectCodes.slice(0, DIRECT_MAP_LIMIT);
  const model = buildConnectedMapModel({
    course,
    path,
    unlocksByCode: state.dataset.unlocks,
    directCodes,
    laterLimit: LATER_MAP_LIMIT,
  });
  const requirementMetaByCode = getRequirementMetaByCode(course);
  const selectedStatus = getCourseStatus(course);
  const selectedMeta = isCompleted(course.code)
    ? "Completed"
    : `${selectedStatus.label} · preview complete`;

  visibleMapEdges = model.edges;
  highlightedMapCode = null;
  const visibleCourseCount = Object.values(model.stages)
    .reduce((total, codes) => total + codes.length, 0);
  elements.graphSummary.textContent =
    `${visibleCourseCount} courses · ${model.edges.length} connections`;
  elements.impactNumber.textContent = String(path.newlyReady.length);
  elements.requiresCount.textContent = String(model.stages.before.length);
  elements.unlocksCount.textContent = String(model.stages.next.length);
  elements.laterCount.textContent = String(model.stages.later.length);
  elements.dependencyGraph.replaceChildren(
    createGraphColumn({
      step: "Before",
      title: "Prerequisites",
      stage: "before",
      codes: model.stages.before,
      emptyText: "No course prerequisites",
      metaForCode: (code) => requirementMetaByCode.get(code) || "needed",
    }),
    createGraphColumn({
      step: "You are here",
      title: "Selected",
      stage: "current",
      codes: model.stages.current,
      emptyText: "",
      metaForCode: () => selectedMeta,
      toneForCode: () => (isCompleted(course.code) ? "done" : selectedStatus.tone),
      markCurrent: true,
    }),
    createGraphColumn({
      step: "One course away",
      title: "Direct connections",
      stage: "next",
      codes: model.stages.next,
      emptyText: "No courses list this as a prerequisite",
      metaForCode: (code) => {
        const category = model.directCategoryByCode.get(code);
        const unlockCount = filterCodesToScope(getCourse(code)?.unlocks || []).length;
        if (isCompleted(code)) return `Completed · ${unlockCount} unlocks`;
        if (category === "newly-ready") return `Opens now · ${unlockCount} unlocks`;
        if (category === "already-ready") return `Already available · ${unlockCount} unlocks`;
        const candidate = getCourse(code);
        const missing = candidate
          ? countUnsatisfiedRequirementsWith(
            getPrerequisiteLogic(candidate),
            path.afterCompleted,
          )
          : 0;
        return `${missing} more requirement${missing === 1 ? "" : "s"}`;
      },
      toneForCode: (code) => {
        if (isCompleted(code)) return "done";
        return model.directCategoryByCode.get(code) === "blocked" ? "blocked" : "ready";
      },
      overflowCount: Math.max(0, allDirectCodes.length - directCodes.length),
    }),
    createGraphColumn({
      step: "Two–three steps",
      title: "Later branches",
      stage: "later",
      codes: model.stages.later,
      emptyText: "No later branches in this focus",
      metaForCode: (code) => {
        const candidate = getCourse(code);
        if (candidate && requiresManualPrerequisiteReview(candidate)) {
          return "Check catalog";
        }
        return `${model.laterDepthByCode.get(code) || 2} steps out`;
      },
      toneForCode: () => "later",
      overflowCount: model.hiddenLaterCount,
    }),
  );
  setMapHighlight();
  scheduleMapEdgeDraw();
}

function getReadyCourses() {
  return state.courses
    .filter((course) => {
      const isDegreeCandidate = !getActiveProgram() || Boolean(getProgramInfo(course.code));
      return isDegreeCandidate && !isCompleted(course.code) && isCourseReady(course);
    })
    .sort((first, second) => {
      const firstUnlockCount = filterCodesToScope(first.unlocks || []).length;
      const secondUnlockCount = filterCodesToScope(second.unlocks || []).length;
      if (secondUnlockCount !== firstUnlockCount) {
        return secondUnlockCount - firstUnlockCount;
      }
      return compareCourses(first.code, second.code);
    });
}

function getPlanTokenStorageKey(planId) {
  return `${PLAN_TOKEN_STORAGE_PREFIX}${planId}`;
}

function getStoredPlanToken(planId) {
  try {
    return localStorage.getItem(getPlanTokenStorageKey(planId));
  } catch {
    return null;
  }
}

function storePlanToken(planId, editToken) {
  try {
    localStorage.setItem(getPlanTokenStorageKey(planId), editToken);
  } catch {
    // The active tab can still edit until it closes when browser storage is unavailable.
  }
}

function getCurrentShareUrl() {
  return state.activePlanId
    ? buildShareUrl(window.location.href, state.activePlanId)
    : "";
}

function createComparisonGroup(label, codes) {
  const group = document.createElement("div");
  group.className = "comparison-group";

  const heading = document.createElement("strong");
  heading.textContent = `${label} · ${codes.length}`;

  const list = document.createElement("span");
  const preview = codes.slice(0, 8);
  list.textContent = preview.length
    ? `${preview.join(", ")}${codes.length > preview.length ? ` +${codes.length - preview.length}` : ""}`
    : "None";
  group.append(heading, list);
  return group;
}

function renderComparison() {
  elements.comparisonResult.replaceChildren();
  if (!state.comparisonPlan) return;

  const comparison = comparePlanCourses(
    state.completedCodes,
    state.comparisonPlan.completed_codes,
  );
  const heading = document.createElement("div");
  heading.className = "comparison-heading";

  const title = document.createElement("strong");
  title.textContent = state.comparisonPlan.name;
  const clear = document.createElement("button");
  clear.className = "text-button comparison-clear";
  clear.type = "button";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    state.comparisonPlan = null;
    elements.comparePlanInput.value = "";
    renderComparison();
  });

  heading.append(title, clear);
  elements.comparisonResult.append(
    heading,
    createComparisonGroup("Both plans", comparison.shared),
    createComparisonGroup("Only this plan", comparison.onlyCurrent),
    createComparisonGroup("Only compared plan", comparison.onlyComparison),
  );
}

function renderPlanSharing() {
  if (document.activeElement !== elements.planNameInput) {
    elements.planNameInput.value = state.planName || getDefaultPlanName();
  }

  const shareUrl = getCurrentShareUrl();
  const isEditableSavedPlan = Boolean(state.activePlanId && state.activePlanToken);
  const isReadOnlySharedPlan = Boolean(state.activePlanId && !state.activePlanToken);

  elements.planAccess.textContent = isEditableSavedPlan
    ? "Editable link"
    : isReadOnlySharedPlan
      ? "Shared view"
      : "Browser only";
  elements.savePlanButton.textContent = state.planBusy
    ? "Saving…"
    : isReadOnlySharedPlan
      ? "Save a Copy"
      : isEditableSavedPlan
        ? state.planDirty ? "Update Plan" : "Saved"
        : "Save & Share";
  elements.savePlanButton.disabled =
    state.planBusy || (isEditableSavedPlan && !state.planDirty);
  elements.planStatus.textContent = state.planStatus;
  elements.planShareUrl.hidden = !shareUrl;
  elements.copyPlanLinkButton.hidden = !shareUrl;
  elements.planShareUrl.value = shareUrl;
  renderComparison();
}

function markPlanDirty() {
  state.planDirty = true;
  if (state.activePlanId && state.activePlanToken) {
    state.planStatus = "Unsaved changes. Update the plan to refresh its shared link.";
  } else if (state.activePlanId) {
    state.planStatus = "Changes are local. Save a copy to get your own editable link.";
  } else {
    state.planStatus = "Saved in this browser. Save the plan to create a share link.";
  }
  renderPlanSharing();
}

function renderPlanner() {
  const readyCourses = getReadyCourses();
  elements.completedCount.textContent = String(state.completedCodes.size);
  elements.readyCount.textContent = String(readyCourses.length);
  renderDegreeProgress();
  renderPlanSharing();

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
    elements.readyNextList.append(createCourseButton(course.code, `${filterCodesToScope(course.unlocks || []).length} unlocks`));
  }
}

function renderBottlenecks() {
  if (!elements.bottleneckList) return;

  const bottlenecks = [...state.courses]
    .filter((course) => isCourseInScope(course.code) && filterCodesToScope(course.unlocks || []).length > 0)
    .sort((first, second) => {
      const firstUnlockCount = filterCodesToScope(first.unlocks || []).length;
      const secondUnlockCount = filterCodesToScope(second.unlocks || []).length;
      if (secondUnlockCount !== firstUnlockCount) {
        return secondUnlockCount - firstUnlockCount;
      }
      return compareCourses(first.code, second.code);
    })
    .slice(0, 8);

  elements.bottleneckList.replaceChildren(
    ...bottlenecks.map((course) =>
      createCourseButton(course.code, `${filterCodesToScope(course.unlocks || []).length} unlocks`),
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

  const prerequisites = course.prerequisites || [];
  const unlocks = filterCodesToScope(course.unlocks || []);
  const status = getCourseStatus(course);
  elements.impactNumber.textContent = String(unlocks.length);
  elements.requiresCount.textContent = String(prerequisites.length);
  elements.unlocksCount.textContent = String(unlocks.length);
  elements.rawPrereqText.textContent = course.prerequisite_text || "No required prerequisite text found.";
  elements.selectedStatus.textContent = status.label;
  elements.selectedStatus.dataset.tone = status.tone;
  elements.degreeTag.textContent =
    state.activeScopeId === "all" ? "Catalog course" : getDegreeLabel(course.code);
  elements.degreeTag.dataset.focus = String(isCourseInScope(course.code));
  elements.completedToggle.textContent = isCompleted(course.code) ? "Remove Complete" : "Mark Complete";

  renderDependencyGraph(course);
  renderPlanner();
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

async function requestPlanJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("Could not reach plan storage. Start the app with npm run dev and try again.");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // A static-only server often returns HTML for an unknown API route.
  }

  if (!response.ok) {
    throw new Error(data?.error || `Plan storage returned ${response.status}.`);
  }
  if (!data?.plan) throw new Error("Plan storage returned an invalid response.");
  return data;
}

function applySharedPlan(plan, editToken = null) {
  state.activePlanId = plan.id;
  state.activePlanToken = editToken;
  state.planName = plan.name;
  state.activeScopeId =
    plan.program_id === "all" || state.programs.some((program) => program.id === plan.program_id)
      ? plan.program_id
      : "all";
  state.completedCodes = new Set(normalizePlanCourseCodes(plan.completed_codes));
  state.planDirty = false;
  state.planStatus = editToken
    ? "Shared plan loaded. This browser has its private edit key."
    : "Viewing a shared plan. Save a copy to make your own editable version.";
  saveCompletedCodes();
}

async function loadSharedPlanFromLocation() {
  const planId = parsePlanId(window.location.href, window.location.href);
  if (!planId) return;

  try {
    const data = await requestPlanJson(`/api/plans/${encodeURIComponent(planId)}`);
    applySharedPlan(data.plan, getStoredPlanToken(planId));
  } catch (error) {
    state.planStatus = `${error.message} Browser-saved progress is still available.`;
  }
}

function getPlanPayload() {
  const name = state.planName.trim() || getDefaultPlanName();
  return {
    name,
    program_id: state.activeScopeId,
    completed_codes: [...state.completedCodes].sort(compareCourses),
  };
}

async function saveSharedPlan() {
  if (state.planBusy) return;
  state.planBusy = true;
  state.planStatus = "Saving plan…";
  renderPlanSharing();

  const canUpdate = Boolean(state.activePlanId && state.activePlanToken);
  const url = canUpdate
    ? `/api/plans/${encodeURIComponent(state.activePlanId)}`
    : "/api/plans";
  const headers = { "content-type": "application/json" };
  if (canUpdate) headers.authorization = `Bearer ${state.activePlanToken}`;

  try {
    const data = await requestPlanJson(url, {
      method: canUpdate ? "PUT" : "POST",
      headers,
      body: JSON.stringify(getPlanPayload()),
    });
    if (data.edit_token) {
      state.activePlanToken = data.edit_token;
      storePlanToken(data.plan.id, data.edit_token);
    }
    state.activePlanId = data.plan.id;
    state.planName = data.plan.name;
    state.planDirty = false;
    state.planStatus = canUpdate
      ? "Plan updated. Anyone with the link now sees these changes."
      : "Plan saved. Copy the link to share a read-only view.";

    const shareUrl = getCurrentShareUrl();
    if (shareUrl) history.replaceState({}, "", shareUrl);
  } catch (error) {
    state.planStatus = error.message;
  } finally {
    state.planBusy = false;
    renderPlanSharing();
  }
}

async function copyPlanLink() {
  const shareUrl = getCurrentShareUrl();
  if (!shareUrl) return;

  try {
    await navigator.clipboard.writeText(shareUrl);
    state.planStatus = "Share link copied.";
  } catch {
    elements.planShareUrl.hidden = false;
    elements.planShareUrl.focus();
    elements.planShareUrl.select();
    state.planStatus = "Copy the selected link to share this plan.";
  }
  renderPlanSharing();
}

async function compareSharedPlan() {
  const planId = parsePlanId(elements.comparePlanInput.value, window.location.href);
  if (!planId) {
    state.planStatus = "Paste a valid plan link or plan ID to compare.";
    renderPlanSharing();
    return;
  }

  elements.comparePlanButton.disabled = true;
  elements.comparePlanButton.textContent = "Loading…";
  try {
    const data = await requestPlanJson(`/api/plans/${encodeURIComponent(planId)}`);
    state.comparisonPlan = data.plan;
    state.planStatus = `Comparing this plan with ${data.plan.name}.`;
  } catch (error) {
    state.planStatus = error.message;
  } finally {
    elements.comparePlanButton.disabled = false;
    elements.comparePlanButton.textContent = "Compare";
    renderPlanSharing();
  }
}

function addCompletedCourses(rawValue) {
  const codes = extractCourseCodes(rawValue);
  for (const code of codes) {
    state.completedCodes.add(code);
  }

  if (codes.length) {
    saveCompletedCodes();
    markPlanDirty();
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
  markPlanDirty();
  selectCourse(course.code);
}

async function loadCourses() {
  const [coursesResponse, programsResponse] = await Promise.all([
    fetch("data/courses.json?v=20260807-full-catalog"),
    fetch("data/programs.json?v=20260807-full-catalog"),
  ]);
  if (!coursesResponse.ok) {
    throw new Error(`Could not load data/courses.json (${coursesResponse.status})`);
  }
  if (!programsResponse.ok) {
    throw new Error(`Could not load data/programs.json (${programsResponse.status})`);
  }

  state.dataset = await coursesResponse.json();
  state.programsData = await programsResponse.json();
  state.programs = state.programsData.programs || [];
  loadCompletedCodes();
  state.courses = [...state.dataset.courses].sort((first, second) =>
    compareCourses(first.code, second.code),
  );
  state.coursesByCode = new Map(state.courses.map((course) => [course.code, course]));
  const activeProgram = getActiveProgram();
  if (activeProgram) {
    state.programCourseIndex = buildProgramCourseIndex(activeProgram);
  }

  const departments = state.dataset.metadata?.departments || [];
  elements.datasetPill.textContent =
    departments.length > 3 ? `${departments.length} subjects` : departments.join(" + ") || "Courses";
  elements.datasetPill.title = departments.join(", ");

  renderScopeOptions();
  await loadSharedPlanFromLocation();
  renderScopeOptions();
  if (!state.planName) state.planName = getDefaultPlanName();

  if ((!getCourse(state.selectedCode) || !isCourseInScope(state.selectedCode)) && state.courses.length) {
    state.selectedCode = findCourses("")[0]?.code || state.courses[0].code;
  }

  renderBottlenecks();
  selectCourse(state.selectedCode);
}

elements.openAuditImportButton.addEventListener("click", openAuditImport);
elements.closeAuditImportButton.addEventListener("click", closeAuditImport);
elements.cancelAuditImportButton.addEventListener("click", closeAuditImport);
elements.auditImportModal.addEventListener("click", (event) => {
  if (event.target === elements.auditImportModal) closeAuditImport();
});
elements.auditFileInput.addEventListener("change", () => {
  analyzeAuditFile(elements.auditFileInput.files?.[0]);
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.auditDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.auditDropzone.dataset.dragging = "true";
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.auditDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.auditDropzone.dataset.dragging = "false";
  });
}
elements.auditDropzone.addEventListener("drop", (event) => {
  analyzeAuditFile(event.dataTransfer?.files?.[0]);
});
elements.analyzeAuditTextButton.addEventListener("click", () => {
  const text = elements.auditPasteInput.value.trim();
  if (!text) {
    elements.auditImportStatus.textContent = "Paste audit text before choosing Analyze text.";
    return;
  }
  renderAuditAnalysis(analyzeDegreeAuditText(text), "Pasted audit text");
});
elements.toggleAuditCoursesButton.addEventListener("click", () => {
  const completedCourses = state.auditCourses.filter((course) => course.status === "completed");
  const shouldSelect = !completedCourses.every((course) => course.selected);
  for (const course of state.auditCourses) {
    course.selected = course.status === "completed" ? shouldSelect : false;
  }
  elements.auditCourseList.replaceChildren(...state.auditCourses.map(createAuditCourseRow));
  updateAuditApplyButton();
});
elements.applyAuditImportButton.addEventListener("click", applyAuditImport);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.auditImportModal.hidden) closeAuditImport();
});

elements.search.addEventListener("input", () => {
  state.activeSuggestionIndex = -1;
  renderSearchSuggestions();
});
elements.search.addEventListener("focus", renderSearchSuggestions);
elements.search.addEventListener("keydown", (event) => {
  if (!state.searchSuggestions.length && !["Escape", "Tab"].includes(event.key)) {
    renderSearchSuggestions();
  }
  if (!state.searchSuggestions.length) return;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.activeSuggestionIndex =
      (state.activeSuggestionIndex + direction + state.searchSuggestions.length)
      % state.searchSuggestions.length;
    renderSearchSuggestions();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const suggestion = state.searchSuggestions[state.activeSuggestionIndex]
      || state.searchSuggestions[0];
    if (suggestion) selectCourseFromSearch(suggestion.code);
  } else if (event.key === "Escape") {
    closeSearchSuggestions();
  }
});
document.addEventListener("click", (event) => {
  if (!elements.searchCombobox.contains(event.target)) closeSearchSuggestions();
});
elements.scopeSelect.addEventListener("change", () => {
  state.activeScopeId = elements.scopeSelect.value;
  markPlanDirty();
  const activeProgram = getActiveProgram();
  state.programCourseIndex = activeProgram ? buildProgramCourseIndex(activeProgram) : new Map();

  if (!isCourseInScope(state.selectedCode)) {
    state.selectedCode = findCourses(elements.search.value)[0]?.code || findCourses("")[0]?.code || state.selectedCode;
  }

  renderScopeMeta();
  renderBottlenecks();
  selectCourse(state.selectedCode);
});
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
  markPlanDirty();
  selectCourse(state.selectedCode);
});
elements.planNameInput.addEventListener("input", () => {
  state.planName = elements.planNameInput.value;
  markPlanDirty();
});
elements.savePlanButton.addEventListener("click", saveSharedPlan);
elements.copyPlanLinkButton.addEventListener("click", copyPlanLink);
elements.planShareUrl.addEventListener("focus", () => elements.planShareUrl.select());
elements.comparePlanButton.addEventListener("click", compareSharedPlan);
elements.comparePlanInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") compareSharedPlan();
});

if ("ResizeObserver" in window) {
  const mapResizeObserver = new ResizeObserver(scheduleMapEdgeDraw);
  mapResizeObserver.observe(elements.connectedMap);
}
window.addEventListener("resize", scheduleMapEdgeDraw);
document.fonts?.ready.then(scheduleMapEdgeDraw);

loadCourses().catch((error) => {
  document.body.innerHTML = `
    <main class="load-error">
      <h1>Could not load course data</h1>
      <p>${error.message}</p>
    </main>
  `;
});
