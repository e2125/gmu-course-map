from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup, NavigableString, Tag


BASE_URL = "https://catalog.gmu.edu"
COURSE_INDEX_URL = f"{BASE_URL}/courses/"
COURSE_CODE_RE = re.compile(r"\b([A-Z]{2,6})[\s\u00a0]+(\d{3}[A-Z]?)\b")
DEPARTMENT_PATH_RE = re.compile(r"^/courses/([a-z0-9-]+)/$")
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
    "swe",
    "phil",
    "biol",
    "chem",
    "geol",
]


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\xa0", " ")).strip()


def extract_department_slugs(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    departments: list[str] = []
    for link in soup.select("a[href]"):
        match = DEPARTMENT_PATH_RE.fullmatch(link.get("href", ""))
        if match and match.group(1) not in departments:
            departments.append(match.group(1))
    return departments


def discover_departments() -> list[str]:
    response = requests.get(
        COURSE_INDEX_URL,
        headers={"User-Agent": "gmu-course-map course index scraper"},
        timeout=30,
    )
    response.raise_for_status()
    departments = extract_department_slugs(response.text)
    if not departments:
        raise ValueError("The GMU catalog course index did not list any departments")
    return departments


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
    prerequisite_logic, prerequisite_parse_status, prerequisite_parse_warnings = (
        parse_prerequisite_details(prereq_nodes)
    )
    prerequisites = extract_course_codes_from_logic(prerequisite_logic)
    referenced_prerequisites = extract_course_codes_from_html_nodes(prereq_nodes)
    unparsed_prerequisite_codes = sorted(
        set(referenced_prerequisites) - set(prerequisites),
        key=course_sort_key,
    )

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
        "department": code.split()[0],
        "title": title,
        "credits": parse_credits(full_title),
        "description": description,
        "prerequisite_text": prereq_text,
        "prerequisites": prerequisites,
        "prerequisite_logic": prerequisite_logic,
        "prerequisite_parse_status": prerequisite_parse_status,
        "prerequisite_parse_warnings": prerequisite_parse_warnings,
        "unparsed_prerequisite_codes": unparsed_prerequisite_codes,
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
            elif lower_value == "or":
                tokens.append({"type": "or"})
            elif value == ",":
                tokens.append({"type": "comma"})
            elif value == ";":
                tokens.append({"type": "semicolon"})
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
    return normalize_prerequisite_tokens(tokens)


def token_depths(tokens: list[dict[str, str]]) -> list[int]:
    depths = []
    depth = 0
    for token in tokens:
        if token["type"] == "rparen":
            depth = max(0, depth - 1)
        depths.append(depth)
        if token["type"] == "lparen":
            depth += 1
    return depths


def comma_is_alternative(
    tokens: list[dict[str, str]],
    depths: list[int],
    index: int,
) -> bool:
    depth = depths[index]
    left = index - 1
    while left >= 0:
        token_type = tokens[left]["type"]
        if depths[left] < depth or (depths[left] == depth and token_type == "semicolon"):
            break
        left -= 1

    right = index + 1
    while right < len(tokens):
        token_type = tokens[right]["type"]
        if depths[right] < depth or (depths[right] == depth and token_type == "semicolon"):
            break
        right += 1

    has_or = any(
        tokens[candidate]["type"] == "or" and depths[candidate] == depth
        for candidate in range(left + 1, right)
    )
    if not has_or:
        return False

    comma_before_or = any(
        tokens[candidate]["type"] == "comma"
        and depths[candidate] == depth
        and candidate + 1 < len(tokens)
        and tokens[candidate + 1]["type"] == "or"
        for candidate in range(left + 1, right)
    )
    if comma_before_or:
        return True

    previous_course = next(
        (
            tokens[candidate]["code"]
            for candidate in range(index - 1, left, -1)
            if tokens[candidate]["type"] == "course" and depths[candidate] == depth
        ),
        None,
    )
    next_course = next(
        (
            tokens[candidate]["code"]
            for candidate in range(index + 1, right)
            if tokens[candidate]["type"] == "course" and depths[candidate] == depth
        ),
        None,
    )
    if not previous_course or not next_course:
        return False
    return previous_course.split()[0] == next_course.split()[0]


def separator_segment_has_or(
    tokens: list[dict[str, str]],
    depths: list[int],
    index: int,
) -> bool:
    depth = depths[index]
    left = index - 1
    while left >= 0:
        if depths[left] < depth or (
            depths[left] == depth and tokens[left]["type"] == "semicolon"
        ):
            break
        left -= 1
    right = index + 1
    while right < len(tokens):
        if depths[right] < depth or (
            depths[right] == depth and tokens[right]["type"] == "semicolon"
        ):
            break
        right += 1
    return any(
        tokens[candidate]["type"] == "or" and depths[candidate] == depth
        for candidate in range(left + 1, right)
    )


def normalize_prerequisite_tokens(tokens: list[dict[str, str]]) -> list[dict[str, str]]:
    """Resolve catalog punctuation and insert operators the catalog leaves implicit."""
    if not tokens:
        return []

    depths = token_depths(tokens)
    resolved: list[dict[str, str]] = []
    for index, token in enumerate(tokens):
        token_type = token["type"]
        if token_type == "comma":
            if comma_is_alternative(tokens, depths, index):
                resolved.append({"type": "or"})
            elif separator_segment_has_or(tokens, depths, index):
                resolved.append({"type": "semicolon"})
            else:
                resolved.append({"type": "and"})
        elif token_type == "semicolon":
            following_type = tokens[index + 1]["type"] if index + 1 < len(tokens) else None
            resolved.append({"type": "or" if following_type == "or" else "semicolon"})
        else:
            resolved.append(token)

    with_implicit_operators: list[dict[str, str]] = []
    ending_types = {"course", "rparen"}
    starting_types = {"course", "lparen"}
    for token in resolved:
        if (
            with_implicit_operators
            and with_implicit_operators[-1]["type"] in ending_types
            and token["type"] in starting_types
        ):
            with_implicit_operators.append({"type": "and"})
        with_implicit_operators.append(token)

    cleaned: list[dict[str, str]] = []
    operator_types = {"and", "or", "semicolon"}
    for token in with_implicit_operators:
        token_type = token["type"]
        if token_type in operator_types:
            if not cleaned or cleaned[-1]["type"] == "lparen":
                continue
            if cleaned[-1]["type"] in operator_types:
                if token_type == "or" or cleaned[-1]["type"] == "or":
                    cleaned[-1] = {"type": "or"}
                elif token_type == "semicolon" or cleaned[-1]["type"] == "semicolon":
                    cleaned[-1] = {"type": "semicolon"}
                continue
        if token_type == "rparen" and cleaned and cleaned[-1]["type"] in operator_types:
            cleaned.pop()
        cleaned.append(token)

    while cleaned and cleaned[-1]["type"] in operator_types:
        cleaned.pop()
    return cleaned


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
        return simplify_logic(self.parse_sequence())

    def parse_sequence(self) -> dict[str, Any] | None:
        items = [self.parse_any()]

        while self.current() and self.current()["type"] == "semicolon":
            self.advance()
            items.append(self.parse_any())

        return combine_logic("all", items)

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
            item = self.parse_sequence()
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


def parse_prerequisite_details(
    nodes: list[Any],
) -> tuple[dict[str, Any] | None, str, list[str]]:
    expressions = []
    warnings = []
    for node in nodes:
        tokens = tokenize_prerequisite_node(node)
        parser = PrerequisiteParser(tokens)
        expression = parser.parse()
        if expression:
            expressions.append(expression)
        if parser.current():
            remaining_types = [token["type"] for token in tokens[parser.index:]]
            warnings.append(f"Unparsed prerequisite tokens: {', '.join(remaining_types)}")

    logic = simplify_logic(combine_logic("all", expressions))
    referenced_codes = set(extract_course_codes_from_html_nodes(nodes))
    parsed_codes = set(extract_course_codes_from_logic(logic))
    missing_codes = sorted(referenced_codes - parsed_codes, key=course_sort_key)
    if missing_codes:
        warnings.append(f"Course references missing from logic: {', '.join(missing_codes)}")

    has_text = any(clean_text(node.get_text(" ", strip=True)) for node in nodes)
    if not has_text:
        status = "not_applicable"
    elif not referenced_codes:
        status = "non_course"
    elif warnings:
        status = "partial"
    else:
        status = "parsed"

    return logic, status, warnings


def parse_prerequisite_logic(nodes: list[Any]) -> dict[str, Any] | None:
    logic, _, _ = parse_prerequisite_details(nodes)
    return logic


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


def build_dataset(
    departments: list[str],
    resolve_missing: bool = False,
    max_resolution_passes: int = 2,
    max_workers: int = 1,
) -> dict[str, Any]:
    courses: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    department_errors = []
    requested_departments = list(dict.fromkeys(department.lower() for department in departments))
    attempted_departments: list[str] = []
    resolved_departments: list[str] = []
    pending_departments = requested_departments
    resolution_pass = 0

    while pending_departments:
        batch = [
            department
            for department in pending_departments
            if department not in attempted_departments
        ]
        attempted_departments.extend(batch)

        def scrape_safely(department: str) -> tuple[str, list[dict[str, Any]] | None, str | None]:
            try:
                return department, scrape_department(department), None
            except requests.RequestException as error:
                return department, None, str(error)

        worker_count = max(1, min(max_workers, len(batch)))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            batch_results = list(executor.map(scrape_safely, batch))

        for department, department_courses, error in batch_results:
            if error:
                department_errors.append({"department": department.upper(), "error": error})
                continue

            for course in department_courses or []:
                if course["code"] in seen_codes:
                    continue

                seen_codes.add(course["code"])
                courses.append(course)

        if not resolve_missing or resolution_pass >= max_resolution_passes:
            break

        current_missing = find_missing_prerequisites(courses)
        pending_departments = sorted(
            {
                code.split()[0].lower()
                for code in current_missing
                if code.split()[0].lower() not in attempted_departments
            }
        )
        resolved_departments.extend(pending_departments)
        resolution_pass += 1

    courses = sorted(courses, key=lambda course: course_sort_key(course["code"]))
    unlocks = add_unlocks(courses)

    edges = []
    for prereq_code, unlocked_courses in unlocks.items():
        for unlocked_code in unlocked_courses:
            edges.append({"from": prereq_code, "to": unlocked_code})

    missing_prerequisites = find_missing_prerequisites(courses)
    parse_warning_count = sum(
        bool(course.get("prerequisite_parse_warnings"))
        for course in courses
    )
    non_course_prerequisite_count = sum(
        course.get("prerequisite_parse_status") == "non_course"
        for course in courses
    )

    return {
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "George Mason University Catalog",
            "departments": sorted({course["department"] for course in courses}),
            "requested_departments": [department.upper() for department in requested_departments],
            "resolved_departments": [department.upper() for department in resolved_departments],
            "source_urls": [
                f"{BASE_URL}/courses/{department}/"
                for department in attempted_departments
            ],
            "department_errors": department_errors,
            "known_course_count": len(courses),
            "missing_prerequisite_count": len(missing_prerequisites),
            "prerequisite_parse_warning_count": parse_warning_count,
            "non_course_prerequisite_count": non_course_prerequisite_count,
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
        "--all-departments",
        action="store_true",
        help="Discover and scrape every subject listed on the official GMU course index.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Concurrent catalog requests. Defaults to 8.",
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
    parser.add_argument(
        "--resolve-missing",
        action="store_true",
        help=(
            "Scrape additional subject pages referenced by prerequisites, up to two passes, "
            "before reporting unresolved courses."
        ),
    )
    args = parser.parse_args()

    departments = discover_departments() if args.all_departments else args.departments
    if args.all_departments:
        print(f"Discovered {len(departments)} GMU course subjects")
    dataset = build_dataset(
        departments,
        resolve_missing=args.resolve_missing,
        max_workers=args.workers,
    )

    if not args.no_write:
        write_dataset(dataset, Path(args.output))
        print(f"Wrote {len(dataset['courses'])} courses to {args.output}")
        print(f"Built {len(dataset['edges'])} prerequisite unlock edges")
        missing_count = dataset["metadata"]["missing_prerequisite_count"]
        print(f"Found {missing_count} referenced prerequisite courses outside this dataset")
        warning_count = dataset["metadata"]["prerequisite_parse_warning_count"]
        print(f"Flagged {warning_count} courses with prerequisite parse warnings")
        if dataset["metadata"]["resolved_departments"]:
            resolved = ", ".join(dataset["metadata"]["resolved_departments"])
            print(f"Expanded prerequisite coverage with: {resolved}")
        if dataset["metadata"]["department_errors"]:
            print("Skipped departments with errors:")
            for item in dataset["metadata"]["department_errors"]:
                print(f"- {item['department']}: {item['error']}")

    if args.show:
        print()
        print_course_summary(dataset, args.show)


if __name__ == "__main__":
    main()
