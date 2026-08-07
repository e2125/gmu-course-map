import assert from "node:assert/strict";
import test from "node:test";

import { calculateProgramProgress } from "../src/degree-progress.js";

function course(code, credits = 3) {
  return { code, credits: `${credits} credits` };
}

test("an alternative can be one course or a required course bundle", () => {
  const program = {
    requirements: [
      {
        id: "path",
        label: "Programming path",
        option_groups: [
          {
            required_count: 1,
            options: ["CS 112", { courses: ["CS 108", "CS 109"] }],
          },
        ],
      },
    ],
  };
  const courses = [course("CS 112", 4), course("CS 108"), course("CS 109")];

  const partial = calculateProgramProgress(program, courses, new Set(["CS 108"]));
  assert.equal(partial.requirements[0].choiceCompleted, 0);
  assert.equal(partial.requirements[0].complete, false);

  const bundled = calculateProgramProgress(program, courses, new Set(["CS 108", "CS 109"]));
  assert.equal(bundled.requirements[0].choiceCompleted, 1);
  assert.equal(bundled.requirements[0].complete, true);

  const single = calculateProgramProgress(program, courses, new Set(["CS 112"]));
  assert.equal(single.requirements[0].complete, true);
});

test("overlapping choice groups do not reuse the same completed course", () => {
  const program = {
    requirements: [
      {
        id: "senior",
        label: "Senior courses",
        option_groups: [
          { required_count: 1, options: ["CS 455", "CS 468", "CS 475"] },
          { required_count: 2, options: ["CS 455", "CS 468", "CS 475"] },
        ],
      },
    ],
  };
  const courses = [course("CS 455"), course("CS 468"), course("CS 475")];

  const twoCourses = calculateProgramProgress(
    program,
    courses,
    new Set(["CS 455", "CS 468"]),
  );
  assert.equal(twoCourses.requirements[0].choiceCompleted, 2);
  assert.equal(twoCourses.requirements[0].complete, false);

  const threeCourses = calculateProgramProgress(
    program,
    courses,
    new Set(["CS 455", "CS 468", "CS 475"]),
  );
  assert.equal(threeCourses.requirements[0].choiceCompleted, 3);
  assert.equal(threeCourses.requirements[0].complete, true);
});

test("credit requirements count credits and cap them at the target", () => {
  const program = {
    requirements: [
      {
        id: "related",
        label: "Related courses",
        credits_needed: 6,
        courses: ["SWE 419", "ECE 232", "ECE 301"],
      },
    ],
  };
  const courses = [course("SWE 419"), course("ECE 232", 1), course("ECE 301")];
  const progress = calculateProgramProgress(
    program,
    courses,
    new Set(["SWE 419", "ECE 232", "ECE 301"]),
  );

  assert.equal(progress.requirements[0].creditCompleted, 6);
  assert.equal(progress.requirements[0].complete, true);
});

test("a catalog or-path contributes only one option to a credit pool", () => {
  const program = {
    requirements: [
      {
        id: "related",
        label: "Related courses",
        credits_needed: 6,
        credit_options: [
          {
            alternatives: [
              "ECE 301",
              { courses: ["ECE 231", "ECE 232"] },
            ],
          },
          "SWE 419",
        ],
      },
    ],
  };
  const courses = [
    course("ECE 301"),
    course("ECE 231"),
    course("ECE 232", 1),
    course("SWE 419"),
  ];
  const progress = calculateProgramProgress(
    program,
    courses,
    new Set(courses.map((item) => item.code)),
  );
  const stats = progress.requirements[0];

  assert.equal(stats.creditCompleted, 6);
  assert.equal(stats.complete, true);
  assert.equal(stats.consumedCodes.has("ECE 301"), false);
  assert.equal(stats.consumedCodes.has("ECE 231"), true);
  assert.equal(stats.consumedCodes.has("ECE 232"), true);
});

test("a completed course is not counted in two separate degree areas", () => {
  const program = {
    requirements: [
      { id: "core", label: "Core", required_courses: ["CS 450"] },
      {
        id: "related",
        label: "Related",
        credits_needed: 6,
        courses: ["CS 450", "CS 425", "CS 440"],
      },
    ],
  };
  const courses = [course("CS 450"), course("CS 425"), course("CS 440")];

  const short = calculateProgramProgress(
    program,
    courses,
    new Set(["CS 450", "CS 425"]),
  );
  assert.equal(short.requirements[0].complete, true);
  assert.equal(short.requirements[1].creditCompleted, 3);

  const complete = calculateProgramProgress(
    program,
    courses,
    new Set(["CS 450", "CS 425", "CS 440"]),
  );
  assert.equal(complete.requirements[1].creditCompleted, 6);
  assert.equal(complete.requirements[1].complete, true);
});

test("catalog rules add dynamic candidates to a credit requirement", () => {
  const program = {
    requirements: [
      {
        id: "upper",
        label: "Upper level",
        credits_needed: 3,
        courses: [],
        rules: [
          { subject: "CS", min_number: 301, exclude: ["CS 504"] },
        ],
      },
    ],
  };
  const courses = [course("CS 310"), course("CS 504"), course("CS 211")];
  const progress = calculateProgramProgress(program, courses, new Set(["CS 310"]));

  assert.deepEqual(progress.requirements[0].codes, ["CS 310"]);
  assert.equal(progress.requirements[0].complete, true);
});
