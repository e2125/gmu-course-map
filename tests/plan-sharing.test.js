import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShareUrl,
  comparePlanCourses,
  normalizePlanCourseCodes,
  parsePlanId,
} from "../src/plan-sharing.js";

test("normalizes and deduplicates plan course codes", () => {
  assert.deepEqual(
    normalizePlanCourseCodes(["cs211", "CS 211", " math 125 ", "not a course"]),
    ["CS 211", "MATH 125"],
  );
});

test("reads a plan ID from either a link or a raw ID", () => {
  assert.equal(parsePlanId("Abcd_1234"), "Abcd_1234");
  assert.equal(
    parsePlanId("https://example.com/map?plan=Abcd_1234#ignored"),
    "Abcd_1234",
  );
  assert.equal(parsePlanId("too short"), null);
});

test("builds a share URL without preserving a hash", () => {
  assert.equal(
    buildShareUrl("https://example.com/map?view=degree#course", "Abcd_1234"),
    "https://example.com/map?view=degree&plan=Abcd_1234",
  );
});

test("compares shared and plan-specific completed courses", () => {
  assert.deepEqual(
    comparePlanCourses(["CS 112", "CS 211"], ["CS 112", "MATH 125"]),
    {
      shared: ["CS 112"],
      onlyCurrent: ["CS 211"],
      onlyComparison: ["MATH 125"],
    },
  );
});
