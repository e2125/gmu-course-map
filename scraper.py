from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup, NavigableString, Tag


BASE_URL = "https://catalog.gmu.edu"
COURSE_CODE_RE = re.compile(r"\b([A-Z]{2,6})[\s\u00a0]+(\d{3}[A-Z]?)\b")
PREREQ_TOKEN_RE = re.compile(
    r"\b[A-Z]{2,6}[\s\u00a0]+\d{3}[A-Z]?\b|\b(?:and|or)\b|[(),;]",
)
DEFAULT_DEPARTMENTS = [
    "cs",
    "math",
    "stat",
    "ece",
    "engh",
    "comm",
    "infs",
    "hnrs",
    "or",
    "phys",
    "cds",
    "engr",
    "bus",
    "favs",
    "me",
    "cyse",
    "syst",
    "it",
]


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
    prerequisite_logic = parse_prerequisite_logic(prereq_nodes)
    prerequisites = extract_course_codes_from_logic(prerequisite_logic)

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
        "prerequisite_logic": prerequisite_logic,
        "recommended_prerequisite_text": " ".join(recommended_prerequisite_text),
        "recommended_prerequisites": recommended_prerequisites,
        "source_url": f"{BASE_URL}/search/?P={code.replace(' ', '%20')}",
    }


def extract_course_codes_from_html_nodes(nodes: list[Any]) -> list[str]:
    codes: set[str] = set()
    for node in nodes:
        codes.update(extract_course_codes_from_html(node))

    return sorted(codes, key=course_sort_key)


def tokenize_prerequisite_node(node: Any) -> list[dict[str, str]]:
    tokens: list[dict[str, str]] = []

    def add_text_tokens(text: str) -> None:
        for match in PREREQ_TOKEN_RE.finditer(text.replace("\xa0", " ")):
            value = match.group(0)
            lower_value = value.lower()

            if lower_value == "and":
                tokens.append({"type": "and"})
            elif lower_value == "or" or value in {",", ";"}:
                tokens.append({"type": "or"})
            elif value == "(":
                tokens.append({"type": "lparen"})
            elif value == ")":
                tokens.append({"type": "rparen"})
            else:
                code = normalize_course_code(value)
                if code:
                    tokens.append({"type": "course", "code": code})

    def walk(current_node: Any) -> None:
        if isinstance(current_node, NavigableString):
            add_text_tokens(str(current_node))
            return

        if not isinstance(current_node, Tag):
            return

        if current_node.name == "a":
            code = normalize_course_code(
                current_node.get("title", "") or current_node.get_text(" ", strip=True)
            )
            if code:
                tokens.append({"type": "course", "code": code})
            return

        if current_node.name == "sup":
            return

        for child in current_node.children:
            walk(child)

    walk(node)
    return tokens


class PrerequisiteParser:
    def __init__(self, tokens: list[dict[str, str]]) -> None:
        self.tokens = tokens
        self.index = 0

    def current(self) -> dict[str, str] | None:
        if self.index >= len(self.tokens):
            return None
        return self.tokens[self.index]

    def advance(self) -> dict[str, str] | None:
        token = self.current()
        if token:
            self.index += 1
        return token

    def parse(self) -> dict[str, Any] | None:
        return simplify_logic(self.parse_any())

    def parse_any(self) -> dict[str, Any] | None:
        items = [self.parse_all()]

        while self.current() and self.current()["type"] == "or":
            self.advance()
            items.append(self.parse_all())

        return combine_logic("any", items)

    def parse_all(self) -> dict[str, Any] | None:
        items = [self.parse_factor()]

        while self.current() and self.current()["type"] == "and":
            self.advance()
            items.append(self.parse_factor())

        return combine_logic("all", items)

    def parse_factor(self) -> dict[str, Any] | None:
        while self.current() and self.current()["type"] == "or":
            self.advance()

        token = self.current()
        if not token or token["type"] == "rparen":
            return None

        if token["type"] == "course":
            self.advance()
            return {"type": "course", "code": token["code"]}

        if token["type"] == "lparen":
            self.advance()
            item = self.parse_any()
            if self.current() and self.current()["type"] == "rparen":
                self.advance()
            return item

        self.advance()
        return self.parse_factor()


def combine_logic(kind: str, items: list[dict[str, Any] | None]) -> dict[str, Any] | None:
    filtered_items = [item for item in items if item]
    if not filtered_items:
        return None

    if len(filtered_items) == 1:
        return filtered_items[0]

    return {"type": kind, "items": filtered_items}


def simplify_logic(logic: dict[str, Any] | None) -> dict[str, Any] | None:
    if not logic:
        return None

    if logic["type"] == "course":
        return logic

    simplified_items = []
    seen_course_codes = set()
    for item in logic.get("items", []):
        simplified_item = simplify_logic(item)
        if not simplified_item:
            continue

        if simplified_item["type"] == logic["type"]:
            nested_items = simplified_item.get("items", [])
        else:
            nested_items = [simplified_item]

        for nested_item in nested_items:
            if nested_item["type"] == "course":
                course_code = nested_item["code"]
                if course_code in seen_course_codes:
                    continue
                seen_course_codes.add(course_code)
            simplified_items.append(nested_item)

    if not simplified_items:
        return None
    if len(simplified_items) == 1:
        return simplified_items[0]

    return {"type": logic["type"], "items": simplified_items}


def extract_course_codes_from_logic(logic: dict[str, Any] | None) -> list[str]:
    codes: set[str] = set()

    def walk(item: dict[str, Any] | None) -> None:
        if not item:
            return

        if item["type"] == "course":
            codes.add(item["code"])
            return

        for child in item.get("items", []):
            walk(child)

    walk(logic)
    return sorted(codes, key=course_sort_key)


def parse_prerequisite_logic(nodes: list[Any]) -> dict[str, Any] | None:
    expressions = []
    for node in nodes:
        tokens = tokenize_prerequisite_node(node)
        expression = PrerequisiteParser(tokens).parse()
        if expression:
            expressions.append(expression)

    return simplify_logic(combine_logic("all", expressions))


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


def find_missing_prerequisites(courses: list[dict[str, Any]]) -> dict[str, list[str]]:
    known_codes = {course["code"] for course in courses}
    missing_references: dict[str, set[str]] = defaultdict(set)

    for course in courses:
        for prereq_code in course["prerequisites"]:
            if prereq_code not in known_codes:
                missing_references[prereq_code].add(course["code"])

    return {
        code: sorted(referencing_courses, key=course_sort_key)
        for code, referencing_courses in sorted(
            missing_references.items(),
            key=lambda item: course_sort_key(item[0]),
        )
    }


def build_dataset(departments: list[str]) -> dict[str, Any]:
    courses: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    department_errors = []

    for department in departments:
        try:
            department_courses = scrape_department(department)
        except requests.RequestException as error:
            department_errors.append({"department": department.upper(), "error": str(error)})
            continue

        for course in department_courses:
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

    missing_prerequisites = find_missing_prerequisites(courses)

    return {
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "George Mason University Catalog",
            "departments": [department.upper() for department in departments],
            "source_urls": [f"{BASE_URL}/courses/{department.lower()}/" for department in departments],
            "department_errors": department_errors,
            "known_course_count": len(courses),
            "missing_prerequisite_count": len(missing_prerequisites),
        },
        "courses": courses,
        "unlocks": unlocks,
        "edges": edges,
        "missing_prerequisites": missing_prerequisites,
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
        default=DEFAULT_DEPARTMENTS,
        help="Catalog department slugs to scrape, like cs math stat. Defaults to common CS prereq subjects.",
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
        missing_count = dataset["metadata"]["missing_prerequisite_count"]
        print(f"Found {missing_count} referenced prerequisite courses outside this dataset")
        if dataset["metadata"]["department_errors"]:
            print("Skipped departments with errors:")
            for item in dataset["metadata"]["department_errors"]:
                print(f"- {item['department']}: {item['error']}")

    if args.show:
        print()
        print_course_summary(dataset, args.show)


if __name__ == "__main__":
    main()
