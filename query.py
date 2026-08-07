from __future__ import annotations

import argparse
import json
import re
from collections import Counter, deque
from pathlib import Path
from typing import Any


COURSE_CODE_RE = re.compile(r"\b([A-Z]{2,6})\s*(\d{3}[A-Z]?)\b")
PROJECT_ROOT = Path(__file__).resolve().parent


def normalize_course_code(value: str) -> str | None:
    match = COURSE_CODE_RE.search(value.strip().upper())
    if not match:
        return None

    subject, number = match.groups()
    return f"{subject} {number}"


def course_sort_key(code: str) -> tuple[str, int, str]:
    normalized_code = normalize_course_code(code)
    if not normalized_code:
        return (code.upper(), 0, "")

    subject, number = normalized_code.split()
    number_match = re.match(r"(\d+)([A-Z]?)", number)
    if not number_match:
        return (subject, 0, number)

    numeric_part, suffix = number_match.groups()
    return (subject, int(numeric_part), suffix)


def load_dataset(path: Path) -> dict[str, Any]:
    if not path.is_absolute():
        path = PROJECT_ROOT / path

    if not path.exists():
        raise SystemExit(
            f"Could not find {path}. Run `python scraper.py --departments cs` first."
        )

    return json.loads(path.read_text(encoding="utf-8"))


def index_courses(dataset: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {course["code"]: course for course in dataset["courses"]}


def format_course_line(code: str, courses_by_code: dict[str, dict[str, Any]]) -> str:
    course = courses_by_code.get(code)
    if not course:
        return code

    return f"{code}: {course['title']}"


def print_course_list(
    title: str,
    codes: list[str],
    courses_by_code: dict[str, dict[str, Any]],
) -> None:
    print(f"\n{title}:")
    if not codes:
        print("- None found")
        return

    for code in sorted(codes, key=course_sort_key):
        print(f"- {format_course_line(code, courses_by_code)}")


def format_logic_inline(logic: dict[str, Any], courses_by_code: dict[str, dict[str, Any]]) -> str:
    if logic["type"] == "course":
        return format_course_line(logic["code"], courses_by_code)

    joiner = " and " if logic["type"] == "all" else " or "
    parts = [format_logic_inline(item, courses_by_code) for item in logic.get("items", [])]

    if logic["type"] == "any":
        return "one of: " + joiner.join(parts)

    return joiner.join(parts)


def print_requirement_logic(course: dict[str, Any], courses_by_code: dict[str, dict[str, Any]]) -> None:
    logic = course.get("prerequisite_logic")
    if not logic:
        print_course_list("Requires", [], courses_by_code)
        return

    print("\nRequires:")
    if logic["type"] == "all":
        for item in logic.get("items", []):
            print(f"- {format_logic_inline(item, courses_by_code)}")
    else:
        print(f"- {format_logic_inline(logic, courses_by_code)}")


def find_unlock_chain(
    start_code: str,
    unlocks_by_code: dict[str, list[str]],
    max_depth: int,
) -> dict[int, list[str]]:
    levels: dict[int, list[str]] = {}
    visited = {start_code}
    queue = deque((code, 1) for code in unlocks_by_code.get(start_code, []))

    while queue:
        code, depth = queue.popleft()
        if code in visited or depth > max_depth:
            continue

        visited.add(code)
        levels.setdefault(depth, []).append(code)

        for unlocked_code in unlocks_by_code.get(code, []):
            if unlocked_code not in visited:
                queue.append((unlocked_code, depth + 1))

    return {
        depth: sorted(codes, key=course_sort_key)
        for depth, codes in sorted(levels.items())
    }


def print_course_summary(
    course: dict[str, Any],
    courses_by_code: dict[str, dict[str, Any]],
    unlocks_by_code: dict[str, list[str]],
    chain_depth: int,
    show_raw: bool,
) -> None:
    print(f"{course['code']}: {course['title']}")
    if course.get("credits"):
        print(f"Credits: {course['credits']}")
    if course.get("source_url"):
        print(f"Source: {course['source_url']}")

    print_requirement_logic(course, courses_by_code)
    print_course_list("Directly unlocks", course.get("unlocks", []), courses_by_code)

    if chain_depth > 1:
        chain = find_unlock_chain(course["code"], unlocks_by_code, chain_depth)
        later_codes = [
            code
            for depth, codes in chain.items()
            if depth > 1
            for code in codes
        ]
        print_course_list(
            f"Later unlocks within {chain_depth} steps",
            later_codes,
            courses_by_code,
        )

    if show_raw and course.get("prerequisite_text"):
        print("\nRaw prerequisite text:")
        print(course["prerequisite_text"])


def search_courses(query: str, courses: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    normalized_query = query.strip().lower()
    matches = []

    for course in courses:
        haystack = " ".join(
            [
                course.get("code", ""),
                course.get("title", ""),
                course.get("description", ""),
            ]
        ).lower()
        if normalized_query in haystack:
            matches.append(course)

    return sorted(matches, key=lambda course: course_sort_key(course["code"]))[:limit]


def print_search_results(query: str, matches: list[dict[str, Any]]) -> None:
    print(f"Search results for {query!r}:")
    if not matches:
        print("- No courses found")
        return

    for course in matches:
        count = course.get("direct_unlock_count", 0)
        plural = "" if count == 1 else "s"
        print(f"- {course['code']}: {course['title']} ({count} direct unlock{plural})")


def print_bottlenecks(
    courses: list[dict[str, Any]],
    courses_by_code: dict[str, dict[str, Any]],
    limit: int,
) -> None:
    ranked_courses = sorted(
        courses,
        key=lambda course: (-course.get("direct_unlock_count", 0), course_sort_key(course["code"])),
    )

    print(f"Top {limit} direct-unlock bottlenecks:")
    for course in ranked_courses[:limit]:
        count = course.get("direct_unlock_count", 0)
        print(f"- {format_course_line(course['code'], courses_by_code)} ({count})")


def print_missing_prerequisites(
    dataset: dict[str, Any],
    courses_by_code: dict[str, dict[str, Any]],
    limit: int,
) -> None:
    missing = dataset.get("missing_prerequisites", {})
    metadata = dataset.get("metadata", {})
    missing_codes_by_subject = Counter(code.split()[0] for code in missing)
    references_by_subject = Counter(
        {
            subject: sum(
                len(referencing_codes)
                for code, referencing_codes in missing.items()
                if code.startswith(f"{subject} ")
            )
            for subject in missing_codes_by_subject
        }
    )

    print("Missing prerequisite coverage:")
    print(f"- Known courses: {metadata.get('known_course_count', len(courses_by_code))}")
    print(f"- Missing referenced courses: {len(missing)}")

    department_errors = metadata.get("department_errors", [])
    if department_errors:
        print("\nSkipped departments:")
        for item in department_errors:
            print(f"- {item['department']}: {item['error']}")

    if not missing:
        print("\nNo missing prerequisite references found.")
        return

    print("\nMissing references by subject:")
    for subject, reference_count in references_by_subject.most_common(min(limit, 12)):
        missing_count = missing_codes_by_subject[subject]
        plural = "" if missing_count == 1 else "s"
        print(f"- {subject}: {reference_count} references across {missing_count} missing course{plural}")

    ranked_missing = sorted(
        missing.items(),
        key=lambda item: (-len(item[1]), course_sort_key(item[0])),
    )[:limit]

    print(f"\nTop {len(ranked_missing)} missing prerequisite courses:")
    for code, referencing_codes in ranked_missing:
        plural = "" if len(referencing_codes) == 1 else "s"
        print(f"- {code} referenced by {len(referencing_codes)} course{plural}")
        for referencing_code in referencing_codes[:5]:
            print(f"  - {format_course_line(referencing_code, courses_by_code)}")
        if len(referencing_codes) > 5:
            print(f"  - ...and {len(referencing_codes) - 5} more")


def print_scrape_quality(dataset: dict[str, Any], limit: int) -> None:
    courses = dataset.get("courses", [])
    metadata = dataset.get("metadata", {})
    statuses = Counter(
        course.get("prerequisite_parse_status", "legacy")
        for course in courses
    )
    warning_courses = [
        course for course in courses if course.get("prerequisite_parse_warnings")
    ]
    non_course_courses = [
        course
        for course in courses
        if course.get("prerequisite_parse_status") == "non_course"
    ]

    print("Scrape quality:")
    print(f"- Courses: {len(courses)}")
    print(f"- Prerequisite edges: {len(dataset.get('edges', []))}")
    print(f"- Missing referenced courses: {metadata.get('missing_prerequisite_count', 0)}")
    print(f"- Parse warnings: {len(warning_courses)}")
    print(f"- Non-course prerequisite statements: {len(non_course_courses)}")
    print("- Parse statuses: " + ", ".join(
        f"{status}={count}" for status, count in sorted(statuses.items())
    ))

    if warning_courses:
        print(f"\nFirst {min(limit, len(warning_courses))} parse warnings:")
        for course in warning_courses[:limit]:
            warnings = "; ".join(course["prerequisite_parse_warnings"])
            print(f"- {course['code']}: {warnings}")

    if non_course_courses:
        print(f"\nFirst {min(limit, len(non_course_courses))} non-course prerequisites:")
        for course in non_course_courses[:limit]:
            print(f"- {course['code']}: {course.get('prerequisite_text', '')}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Query saved GMU course prerequisite data.")
    parser.add_argument("query", nargs="?", help="Course code like CS 211, or text to search.")
    parser.add_argument("--data", default="data/courses.json", help="Path to scraped course JSON.")
    parser.add_argument("--depth", type=int, default=3, help="Unlock chain depth to show.")
    parser.add_argument("--raw", action="store_true", help="Show raw prerequisite text.")
    parser.add_argument("--limit", type=int, default=12, help="Search or bottleneck result limit.")
    parser.add_argument(
        "--bottlenecks",
        action="store_true",
        help="Show courses that directly unlock the most other courses.",
    )
    parser.add_argument(
        "--missing",
        action="store_true",
        help="Show prerequisite course codes referenced by the data but not included in it.",
    )
    parser.add_argument(
        "--quality",
        action="store_true",
        help="Summarize prerequisite parse coverage, warnings, and non-course requirements.",
    )
    args = parser.parse_args()

    dataset = load_dataset(Path(args.data))
    courses = dataset["courses"]
    courses_by_code = index_courses(dataset)
    unlocks_by_code = dataset.get("unlocks", {})

    if args.bottlenecks:
        print_bottlenecks(courses, courses_by_code, args.limit)
        return

    if args.missing:
        print_missing_prerequisites(dataset, courses_by_code, args.limit)
        return

    if args.quality:
        print_scrape_quality(dataset, args.limit)
        return

    if not args.query:
        raise SystemExit(
            "Give me a course code, search text, or use --bottlenecks/--missing/--quality."
        )

    code = normalize_course_code(args.query)
    if code and code in courses_by_code:
        print_course_summary(
            courses_by_code[code],
            courses_by_code,
            unlocks_by_code,
            args.depth,
            args.raw,
        )
        return

    matches = search_courses(args.query, courses, args.limit)
    print_search_results(args.query, matches)


if __name__ == "__main__":
    main()
