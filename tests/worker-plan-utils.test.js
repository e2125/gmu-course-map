import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlanCredentials,
  hashEditToken,
  normalizePlanPayload,
  PlanValidationError,
} from "../worker/plan-utils.js";

test("server payload validation normalizes a safe plan", () => {
  assert.deepEqual(
    normalizePlanPayload({
      name: "  Systems plan ",
      program_id: "cs-bs-2026",
      completed_codes: ["cs211", "CS 211", "math 125"],
      transferred_codes: ["math 125", "CS 310"],
      planned_codes: ["CS 310", "CS 211"],
      planned_terms: { "CS 310": "fall-2026", "CS 211": "spring-2027" },
    }),
    {
      name: "Systems plan",
      programId: "cs-bs-2026",
      completedCodes: ["CS 211", "MATH 125"],
      transferredCodes: ["MATH 125"],
      plannedCodes: ["CS 310"],
      plannedTerms: { "CS 310": "fall-2026" },
    },
  );
});

test("server payload validation rejects malformed codes", () => {
  assert.throws(
    () => normalizePlanPayload({
      name: "Plan",
      program_id: "all",
      completed_codes: ["CS 99"],
    }),
    PlanValidationError,
  );
});

test("edit credentials are opaque and only the hash is stored", async () => {
  const first = createPlanCredentials();
  const second = createPlanCredentials();
  assert.match(first.id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.editToken, second.editToken);

  const digest = await hashEditToken(first.editToken);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, first.editToken);
});
