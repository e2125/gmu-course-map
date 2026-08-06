from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DATA_PATH = Path(__file__).resolve().parent / "data" / "courses.json"


def load_courses() -> dict[str, dict[str, Any]]:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return {course["code"]: course for course in data["courses"]}


def is_satisfied(logic: dict[str, Any] | None, completed: set[str]) -> bool:
    if not logic:
        return True

    if logic["type"] == "course":
        return logic["code"] in completed

    items = logic.get("items", [])
    if logic["type"] == "any":
        return any(is_satisfied(item, completed) for item in items)

    return all(is_satisfied(item, completed) for item in items)


def assert_ready(
    courses: dict[str, dict[str, Any]],
    code: str,
    completed: set[str],
    expected: bool,
) -> None:
    actual = is_satisfied(courses[code].get("prerequisite_logic"), completed)
    if actual != expected:
        state = "ready" if actual else "blocked"
        expected_state = "ready" if expected else "blocked"
        raise AssertionError(f"{code} was {state}; expected {expected_state}")


def main() -> None:
    courses = load_courses()

    assert_ready(courses, "CS 211", {"CS 112"}, True)
    assert_ready(courses, "CS 211", {"CS 109"}, True)
    assert_ready(courses, "CS 211", set(), False)

    assert_ready(courses, "CS 310", {"CS 211", "MATH 125", "MATH 113"}, True)
    assert_ready(courses, "CS 310", {"CS 211", "MATH 125"}, False)
    assert_ready(courses, "CS 310", {"CS 211", "MATH 113"}, False)

    print("Prerequisite logic checks passed.")


if __name__ == "__main__":
    main()
