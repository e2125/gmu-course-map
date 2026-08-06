from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup


BASE_URL = "https://catalog.gmu.edu"
COURSE_CODE_RE = re.compile(r"\b([A-Z]{2,6})[\s\u00a0]+(\d{3}[A-Z]?)\b")


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\xa0", " ")).strip()


def normalize_course_code(value: str) -> str | None:
    match = COURSE_CODE_RE.search(clean_text(value).upper())
    if not match:
        return None

    subject, number = match.groups()
    return f"{subject.upper()} {number.upper()}"


def course_sort_key(code: str) -> tuple[str, int, str]:
    match = COURSE_CODE_RE.fullmatch(code)
    if not match:
        return (code, 0, "")

    subject, number = match.groups()
    number_match = re.match(r"(\d+)([A-Z]?)", number.upper())
    if not number_match:
        return (subject.upper(), 0, number.upper())

    numeric_part, suffix = number_match.groups()
    return (subject.upper(), int(numeric_part), suffix)


def extract_course_codes_from_html(node: Any) -> list[str]:
    codes: set[str] = set()

    for link in node.select("a"):
        for candidate in (link.get("title", ""), link.get_text(" ", strip=True)):
            code = normalize_course_code(candidate)
            if code:
                codes.add(code)

    for subject, number in COURSE_CODE_RE.findall(node.get_text(" ", strip=True)):
        codes.add(f"{subject.upper()} {number.upper()}")

    return sorted(codes, key=course_sort_key)


def parse_credits(title_text: str) -> str | None:
    match = re.search(r"(\d+(?:-\d+)?(?:\s+credits?|\s+credit))\.?$", title_text)
    return match.group(1) if match else None


def parse_course_block(block: Any, department: str) -> dict[str, Any] | None:
    title_node = block.select_one(".courseblocktitle")
    code_node = block.select_one(".cb_code")
    course_title_node = block.select_one(".cb_title")

    if not title_node or not code_node:
        return None

    code = normalize_course_code(code_node.get_text(" ", strip=True))
    if not code:
        return None

    title = ""
    if course_title_node:
        title = clean_text(course_title_node.get_text(" ", strip=True)).rstrip(".")

    full_title = clean_text(title_node.get_text(" ", strip=True))
    description_node = block.select_one(".courseblockdesc")
    description = clean_text(description_node.get_text(" ", strip=True)) if description_node else ""

    prereq_nodes = block.select("p.prereq")
    prereq_text = " ".join(clean_text(node.get_text(" ", strip=True)) for node in prereq_nodes)
    prerequisites = extract_course_codes_from_html_nodes(prereq_nodes)

    recommended_prerequisites = []
    recommended_prerequisite_text = []
    for extra_node in block.select(".courseblockextra"):
        text = clean_text(extra_node.get_text(" ", strip=True))
        if text.lower().startswith("recommended prerequisite"):
            recommended_prerequisite_text.append(text)
            recommended_prerequisites.extend(extract_course_codes_from_html(extra_node))

    recommended_prerequisites = sorted(set(recommended_prerequisites), key=course_sort_key)

    return {
        "code": code,
        "department": department.upper(),
        "title": title,
        "credits": parse_credits(full_title),
        "description": description,
        "prerequisite_text": prereq_text,
        "prerequisites": prerequisites,
        "recommended_prerequisite_text": " ".join(recommended_prerequisite_text),
        "recommended_prerequisites": recommended_prerequisites,
        "source_url": f"{BASE_URL}/search/?P={code.replace(' ', '%20')}",
    }


def extract_course_codes_from_html_nodes(nodes: list[Any]) -> list[str]:
    codes: set[str] = set()
    for node in nodes:
        codes.update(extract_course_codes_from_html(node))

    return sorted(codes, key=course_sort_key)


def scrape_department(department: str) -> list[dict[str, Any]]:
    normalized_department = department.lower()
    url = f"{BASE_URL}/courses/{normalized_department}/"
    response = requests.get(
        url,
        headers={"User-Agent": "gmu-course-map prototype scraper"},
        timeout=30,
    )
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    courses = []

    for block in soup.select(".courseblock"):
        course = parse_course_block(block, normalized_department)
        if course:
            courses.append(course)

    return sorted(courses, key=lambda course: course_sort_key(course["code"]))


def add_unlocks(courses: list[dict[str, Any]]) -> dict[str, list[str]]:
    unlocks: dict[str, set[str]] = defaultdict(set)

    for course in courses:
        for prereq_code in course["prerequisites"]:
            if prereq_code != course["code"]:
                unlocks[prereq_code].add(course["code"])

    sorted_unlocks = {
        code: sorted(unlocked_courses, key=course_sort_key)
        for code, unlocked_courses in sorted(unlocks.items(), key=lambda item: course_sort_key(item[0]))
    }

    for course in courses:
        course["unlocks"] = sorted_unlocks.get(course["code"], [])
        course["direct_unlock_count"] = len(course["unlocks"])

    return sorted_unlocks


def build_dataset(departments: list[str]) -> dict[str, Any]:
    courses: list[dict[str, Any]] = []
    seen_codes: set[str] = set()

    for department in departments:
        for course in scrape_department(department):
            if course["code"] in seen_codes:
                continue

            seen_codes.add(course["code"])
            courses.append(course)

    courses = sorted(courses, key=lambda course: course_sort_key(course["code"]))
    unlocks = add_unlocks(courses)

    edges = []
    for prereq_code, unlocked_courses in unlocks.items():
        for unlocked_code in unlocked_courses:
            edges.append({"from": prereq_code, "to": unlocked_code})

    return {
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "George Mason University Catalog",
            "departments": [department.upper() for department in departments],
            "source_urls": [f"{BASE_URL}/courses/{department.lower()}/" for department in departments],
        },
        "courses": courses,
        "unlocks": unlocks,
        "edges": edges,
    }


def print_course_summary(dataset: dict[str, Any], raw_code: str) -> None:
    code = normalize_course_code(raw_code)
    if not code:
        raise SystemExit(f"Could not understand course code: {raw_code}")

    courses_by_code = {course["code"]: course for course in dataset["courses"]}
    course = courses_by_code.get(code)
    if not course:
        raise SystemExit(f"{code} was not found in this dataset.")

    print(f"{course['code']}: {course['title']}")
    if course["credits"]:
        print(f"Credits: {course['credits']}")

    print("\nRequires:")
    if course["prerequisites"]:
        for prereq in course["prerequisites"]:
            print(f"- {prereq}")
    else:
        print("- No required course prerequisites found")

    print("\nUnlocks:")
    if course["unlocks"]:
        for unlocked in course["unlocks"]:
            unlocked_course = courses_by_code.get(unlocked)
            title = f": {unlocked_course['title']}" if unlocked_course else ""
            print(f"- {unlocked}{title}")
    else:
        print("- No direct unlocks found in this dataset")


def write_dataset(dataset: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(dataset, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape GMU catalog courses and build prereq/unlock data.")
    parser.add_argument(
        "--departments",
        nargs="+",
        default=["cs"],
        help="Catalog department slugs to scrape, like cs math stat.",
    )
    parser.add_argument(
        "--output",
        default="data/courses.json",
        help="Where to save the scraped JSON dataset.",
    )
    parser.add_argument(
        "--show",
        help="After scraping, print a quick prereq/unlocks summary for a course code.",
    )
    parser.add_argument(
        "--no-write",
        action="store_true",
        help="Scrape and print summary without writing JSON.",
    )
    args = parser.parse_args()

    dataset = build_dataset(args.departments)

    if not args.no_write:
        write_dataset(dataset, Path(args.output))
        print(f"Wrote {len(dataset['courses'])} courses to {args.output}")
        print(f"Built {len(dataset['edges'])} prerequisite unlock edges")

    if args.show:
        print()
        print_course_summary(dataset, args.show)


if __name__ == "__main__":
    main()
