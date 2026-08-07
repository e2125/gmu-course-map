import test from "node:test";
import assert from "node:assert/strict";

import { buildConnectedMapModel } from "../src/connected-map.js";

test("connected map preserves course-level edges across every visible stage", () => {
  const model = buildConnectedMapModel({
    course: { code: "CS 211" },
    path: {
      prerequisites: ["CS 112", "MATH 113"],
      newlyReady: ["CS 262"],
      alreadyReady: ["CS 306"],
      stillBlocked: ["CS 310"],
      later: [
        { code: "CS 367", depth: 2 },
        { code: "CS 471", depth: 3 },
      ],
    },
    unlocksByCode: {
      "CS 262": ["CS 367"],
      "CS 367": ["CS 471"],
    },
  });

  assert.deepEqual(model.stages.next, ["CS 262", "CS 306", "CS 310"]);
  assert.deepEqual(model.stages.later, ["CS 367", "CS 471"]);
  assert.ok(model.edges.some((edge) =>
    edge.source === "CS 112" && edge.target === "CS 211"));
  assert.ok(model.edges.some((edge) =>
    edge.source === "CS 211" && edge.target === "CS 310"));
  assert.ok(model.edges.some((edge) =>
    edge.source === "CS 262" && edge.target === "CS 367"));
  assert.ok(model.edges.some((edge) =>
    edge.source === "CS 367" && edge.target === "CS 471"));
});

test("connected map marks a multi-step fallback when an intermediate is hidden", () => {
  const model = buildConnectedMapModel({
    course: { code: "CS 211" },
    path: {
      prerequisites: [],
      newlyReady: [],
      alreadyReady: [],
      stillBlocked: [],
      later: [{ code: "CS 471", depth: 3 }],
    },
    unlocksByCode: {},
  });

  assert.deepEqual(model.edges, [{
    source: "CS 211",
    target: "CS 471",
    kind: "later",
    indirect: true,
  }]);
});
