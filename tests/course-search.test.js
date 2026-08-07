import assert from "node:assert/strict";
import test from "node:test";

import { getCourseSearchRank, searchCourses } from "../src/course-search.js";

const courses = [
  {
    code: "CS 321",
    title: "Software Engineering",
    description: "Build software in teams.",
    prerequisite_text: "CS 310 and ENGH 302",
  },
  {
    code: "ENGH 302",
    title: "Advanced Composition",
    description: "Advanced writing for majors.",
    prerequisite_text: "ENGH 101",
  },
  {
    code: "ENGH 388",
    title: "Professional Writing",
    description: "Writing in technical settings.",
    prerequisite_text: "ENGH 302",
  },
];

const compareCodes = (first, second) => first.localeCompare(second, undefined, { numeric: true });

test("an exact course code ranks ahead of prerequisite mentions", () => {
  assert.deepEqual(
    searchCourses(courses, "engh 302", compareCodes).map((course) => course.code),
    ["ENGH 302", "CS 321", "ENGH 388"],
  );
});

test("subject prefixes return subject courses before description matches", () => {
  assert.deepEqual(
    searchCourses(courses, "ENGH", compareCodes).map((course) => course.code),
    ["ENGH 302", "ENGH 388", "CS 321"],
  );
});

test("unrelated courses are excluded", () => {
  assert.equal(getCourseSearchRank(courses[0], "chemistry"), null);
});
