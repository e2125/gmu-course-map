import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDegreeAuditText } from "../src/audit-import.js";

test("imports only grade-backed completed courses by default", () => {
  const result = analyzeDegreeAuditText(`
    Fall 2024 CS 112 Introduction to Computer Programming 4.000 A
    Spring 2025 MATH 125 Discrete Mathematics 3.000 B+
    Still needed: CS 310 Data Structures
  `);

  assert.deepEqual(result.completedCodes, ["CS 112", "MATH 125"]);
  assert.equal(result.courses.find((course) => course.code === "CS 310")?.status, "review");
});

test("keeps registered courses separate from completed courses", () => {
  const result = analyzeDegreeAuditText(`
    Fall 2025 CS 211 Object-Oriented Programming 3.000 IP
    Spring 2025 CS 110 Essentials of Computer Science 3.000 P
  `);

  assert.deepEqual(result.completedCodes, ["CS 110"]);
  assert.deepEqual(result.inProgressCodes, ["CS 211"]);
});

test("a completed record wins when a course appears more than once", () => {
  const result = analyzeDegreeAuditText(`
    Requirement option: CS 211
    Completed: CS 211 Object-Oriented Programming 3.000 A-
  `);

  assert.deepEqual(result.completedCodes, ["CS 211"]);
  assert.equal(result.courses.length, 1);
});

test("reports exception language without applying it automatically", () => {
  const result = analyzeDegreeAuditText(
    "Exception Details: CS 211 was substituted and one requirement was waived.",
  );

  assert.equal(result.exceptionDetailCount, 3);
});

