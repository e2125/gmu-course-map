import assert from "node:assert/strict";
import test from "node:test";

import { buildCourseImpactPath } from "../src/course-path.js";

function course(code, prerequisites = [], unlocks = [], prerequisiteLogic = null) {
  return {
    code,
    prerequisites,
    prerequisite_logic: prerequisiteLogic,
    prerequisite_parse_status: prerequisites.length ? "parsed" : "not_applicable",
    unlocks,
  };
}

test("course impact separates newly ready, still blocked, and later branches", () => {
  const courses = [
    course("CS 100", [], ["CS 200", "CS 250"]),
    course("CS 200", ["CS 100"], ["CS 300"]),
    course("CS 250", ["CS 100", "MATH 100"]),
    course("CS 300", ["CS 200"]),
    course("MATH 100"),
  ];
  const coursesByCode = new Map(courses.map((item) => [item.code, item]));
  const path = buildCourseImpactPath({
    course: coursesByCode.get("CS 100"),
    coursesByCode,
    unlocksByCode: {
      "CS 100": ["CS 200", "CS 250"],
      "CS 200": ["CS 300"],
    },
    completedCodes: new Set(),
  });

  assert.deepEqual(path.newlyReady, ["CS 200"]);
  assert.deepEqual(path.stillBlocked, ["CS 250"]);
  assert.deepEqual(path.later, [{ code: "CS 300", depth: 2 }]);
});

test("a completed selected course still shows what its completion opened", () => {
  const selected = course("CS 100", [], ["CS 200"]);
  const unlocked = course("CS 200", ["CS 100"]);
  const coursesByCode = new Map([
    [selected.code, selected],
    [unlocked.code, unlocked],
  ]);
  const path = buildCourseImpactPath({
    course: selected,
    coursesByCode,
    unlocksByCode: { "CS 100": ["CS 200"] },
    completedCodes: new Set(["CS 100"]),
  });

  assert.deepEqual(path.newlyReady, ["CS 200"]);
});

test("a course already ready through another option is not credited to the selected course", () => {
  const selected = course("CS 100", [], ["CS 200"]);
  const unlocked = course(
    "CS 200",
    ["CS 100", "CS 101"],
    [],
    {
      type: "any",
      items: [
        { type: "course", code: "CS 100" },
        { type: "course", code: "CS 101" },
      ],
    },
  );
  const coursesByCode = new Map([
    [selected.code, selected],
    [unlocked.code, unlocked],
  ]);
  const path = buildCourseImpactPath({
    course: selected,
    coursesByCode,
    unlocksByCode: { "CS 100": ["CS 200"] },
    completedCodes: new Set(["CS 101"]),
  });

  assert.deepEqual(path.newlyReady, []);
  assert.deepEqual(path.alreadyReady, ["CS 200"]);
});

test("manual catalog requirements are never presented as automatically ready", () => {
  const selected = course("CS 100", [], ["MATH 115"]);
  const placementCourse = course("MATH 115");
  placementCourse.prerequisite_parse_status = "non_course";
  const coursesByCode = new Map([
    [selected.code, selected],
    [placementCourse.code, placementCourse],
  ]);
  const path = buildCourseImpactPath({
    course: selected,
    coursesByCode,
    unlocksByCode: { "CS 100": ["MATH 115"] },
    completedCodes: new Set(),
  });

  assert.deepEqual(path.newlyReady, []);
  assert.deepEqual(path.stillBlocked, ["MATH 115"]);
});
