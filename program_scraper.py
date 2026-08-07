from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from itertools import combinations, product
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup, Tag

from scraper import (
    BASE_URL,
    clean_text,
    course_sort_key,
    extract_course_codes_from_html,
    normalize_course_code,
)

MASON_CORE_URL = f"{BASE_URL}/mason-core/"
MASON_CORE_CATEGORY_ANCHORS = {
    "Literature": "literature",
    "Arts": "arts",
    "Global History": "global-history",
    "Social and Behavioral Sciences": "social-behavioral-science",
    "Global Contexts": "global-contexts",
}

COUNT_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
}
SELECTION_RE = re.compile(
    r"\bselect\s+(?P<count>\d+|one|two|three|four|five|six)\b(?P<tail>.*)",
    re.IGNORECASE,
)
CREDIT_RE = re.compile(
    r"\b(?:select|complete)\s+(?P<count>\d+|one|two|three|four|five|six)\b[^.]*?\bcredits?\b",
    re.IGNORECASE,
)
DYNAMIC_RULE_RE = re.compile(
    r"^Any\s+(?P<subjects>[A-Z]{2,6}(?:\s+or\s+[A-Z]{2,6})*)\s+course\s+numbered\s+"
    r"(?:(?P<above>above)\s+)?(?P<number>\d{3})(?:\s+or\s+above)?",
    re.IGNORECASE,
)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "requirement"


def parse_mason_core_page(html: str) -> dict[str, list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    categories: dict[str, list[str]] = {}
    for label, anchor_id in MASON_CORE_CATEGORY_ANCHORS.items():
        anchor = soup.find(id=anchor_id)
        table = anchor.find_next("table", class_="sc_courselist") if anchor else None
        if table:
            categories[label] = extract_course_codes_from_html(table)
    return categories


def apply_mason_core_categories(
    requirements: list[dict[str, Any]],
    warnings: list[str],
    categories: dict[str, list[str]],
) -> bool:
    requirement = next(
        (item for item in requirements if item.get("label") == "Additional Mason Core"),
        None,
    )
    if not requirement:
        return False

    remaining = []
    resolved_any = False
    for item in requirement.get("unmodeled", []):
        options = categories.get(item.get("label", ""), [])
        if not options:
            remaining.append(item)
            continue
        requirement.setdefault("option_groups", []).append(
            {
                "label": item["label"],
                "required_count": 1,
                "options": options,
                "catalog_credits": item.get("credits_needed"),
            }
        )
        resolved_any = True

    if remaining:
        requirement["unmodeled"] = remaining
    else:
        requirement.pop("unmodeled", None)
        warnings[:] = [
            warning
            for warning in warnings
            if warning != "Additional Mason Core: some catalog rows could not be tied to course options"
        ]
    return resolved_any


def parse_count(value: str) -> int:
    return int(value) if value.isdigit() else COUNT_WORDS[value.lower()]


def row_cells(row: Tag) -> list[Tag]:
    return [cell for cell in row.find_all(["th", "td"], recursive=False)]


def row_label(row: Tag) -> str:
    cells = row_cells(row)
    visible = [cell for cell in cells if "hourscol" not in (cell.get("class") or [])]
    return clean_text(" ".join(cell.get_text(" ", strip=True) for cell in visible))


def row_credits(row: Tag) -> int | None:
    hours = row.select_one(".hourscol")
    if not hours:
        return None
    match = re.search(r"\d+", hours.get_text(" ", strip=True))
    return int(match.group(0)) if match else None


def row_codes(row: Tag) -> list[str]:
    code_cell = row.select_one(".codecol")
    if not code_cell:
        return []
    return extract_course_codes_from_html(code_cell)


def make_course_path(codes: list[str], label: str | None = None) -> str | dict[str, Any]:
    unique = sorted(set(codes), key=course_sort_key)
    if len(unique) == 1 and not label:
        return unique[0]
    result: dict[str, Any] = {"courses": unique}
    if label:
        result["label"] = label
    return result


def path_codes(path: str | dict[str, Any]) -> list[str]:
    if isinstance(path, str):
        return [path]
    if "alternatives" in path:
        return [code for alternative in path["alternatives"] for code in path_codes(alternative)]
    return path.get("courses", [])


def merge_alternatives(
    first: str | dict[str, Any],
    second: str | dict[str, Any],
    label: str,
) -> dict[str, Any]:
    alternatives = list(first.get("alternatives", [])) if isinstance(first, dict) else []
    if not alternatives:
        alternatives = [first]
    alternatives.append(second)
    return {"label": label, "alternatives": alternatives}


def parse_selection(text: str) -> tuple[str, int] | None:
    credit_match = CREDIT_RE.search(text)
    if credit_match:
        return "credits", parse_count(credit_match.group("count"))

    selection_match = SELECTION_RE.search(text)
    if not selection_match:
        return None
    return "courses", parse_count(selection_match.group("count"))


def parse_dynamic_rules(text: str) -> list[dict[str, Any]]:
    match = DYNAMIC_RULE_RE.search(text)
    if not match:
        return []

    minimum = int(match.group("number")) + (1 if match.group("above") else 0)
    subjects = [
        subject.strip().upper()
        for subject in re.split(r"\s+or\s+", match.group("subjects"), flags=re.IGNORECASE)
    ]
    excluded_parts = re.split(r"\bexcept\b", text, maxsplit=1, flags=re.IGNORECASE)
    excluded_text = excluded_parts[1] if len(excluded_parts) == 2 else ""
    excluded_codes = extract_course_codes_from_html(
        BeautifulSoup(f"<span>{excluded_text}</span>", "html.parser")
    )
    return [
        {
            "label": text,
            "subject": subject,
            "min_number": minimum,
            "exclude": [code for code in excluded_codes if code.startswith(f"{subject} ")],
        }
        for subject in subjects
    ]


def next_row_has_courses(rows: list[Tag], index: int) -> bool:
    for next_row in rows[index + 1:]:
        classes = set(next_row.get("class") or [])
        if "hidden" in classes or "listsum" in classes:
            continue
        if "areaheader" in classes:
            return False
        return bool(row_codes(next_row))
    return False


def collapse_single_option_groups(requirement: dict[str, Any]) -> None:
    kept_groups = []
    for group in requirement.get("option_groups", []):
        options = group.get("options", [])
        only_option = options[0] if len(options) == 1 else None
        has_alternatives = isinstance(only_option, dict) and bool(only_option.get("alternatives"))
        if (
            group.get("required_count", 1) == 1
            and len(options) == 1
            and not has_alternatives
        ):
            requirement.setdefault("required_courses", []).extend(path_codes(options[0]))
        else:
            kept_groups.append(group)
    requirement["option_groups"] = kept_groups


def parse_standard_table(table: Tag, heading: str, warnings: list[str]) -> dict[str, Any]:
    requirement: dict[str, Any] = {
        "id": slugify(heading),
        "label": heading,
        "role": "required",
        "required_courses": [],
        "option_groups": [],
        "credit_options": [],
        "rules": [],
        "unmodeled": [],
    }
    rows = table.select("tr")
    active_group: dict[str, Any] | None = None
    active_credit_selection = False
    last_required_path: str | dict[str, Any] | None = None

    for index, row in enumerate(rows):
        classes = set(row.get("class") or [])
        if "hidden" in classes:
            continue
        if "listsum" in classes:
            requirement["catalog_total_credits"] = row_credits(row)
            continue

        label = row_label(row)
        codes = row_codes(row)
        if not label and not codes:
            continue

        dynamic_rules = parse_dynamic_rules(label)
        if dynamic_rules:
            requirement["rules"].extend(dynamic_rules)
            active_group = None
            active_credit_selection = False
            continue

        if not codes:
            selection = parse_selection(label)
            if selection:
                selection_type, count = selection
                if selection_type == "credits":
                    requirement["credits_needed"] = max(requirement.get("credits_needed", 0), count)
                    active_credit_selection = True
                    active_group = None
                else:
                    active_group = {
                        "label": label,
                        "required_count": count,
                        "options": [],
                    }
                    requirement["option_groups"].append(active_group)
                    active_credit_selection = False
                continue

            if row_credits(row) and next_row_has_courses(rows, index):
                active_group = {"label": label, "required_count": 1, "options": []}
                requirement["option_groups"].append(active_group)
                active_credit_selection = False
            elif row_credits(row):
                requirement["unmodeled"].append(
                    {"label": label, "credits_needed": row_credits(row)}
                )
            continue

        path = make_course_path(codes, label if len(codes) > 1 else None)
        is_alternative = "orclass" in classes

        if active_credit_selection:
            if is_alternative and requirement["credit_options"]:
                previous = requirement["credit_options"].pop()
                requirement["credit_options"].append(
                    merge_alternatives(previous, path, label)
                )
            else:
                requirement["credit_options"].append(path)
            continue

        if active_group is not None:
            if is_alternative and active_group["options"]:
                previous = active_group["options"].pop()
                active_group["options"].append(merge_alternatives(previous, path, label))
            else:
                active_group["options"].append(path)
            continue

        if is_alternative and last_required_path is not None:
            previous_codes = path_codes(last_required_path)
            for code in previous_codes:
                if code in requirement["required_courses"]:
                    requirement["required_courses"].remove(code)
            group = {
                "label": f"Choose one catalog path for {heading}",
                "required_count": 1,
                "options": [last_required_path, path],
            }
            requirement["option_groups"].append(group)
            last_required_path = None
        else:
            requirement["required_courses"].extend(path_codes(path))
            last_required_path = path

    collapse_single_option_groups(requirement)
    requirement["required_courses"] = sorted(
        set(requirement["required_courses"]), key=course_sort_key
    )
    if requirement["option_groups"] or requirement.get("credits_needed"):
        requirement["role"] = "choice"

    for key in ["required_courses", "option_groups", "credit_options", "rules", "unmodeled"]:
        if not requirement.get(key):
            requirement.pop(key, None)
    if requirement.get("unmodeled"):
        warnings.append(f"{heading}: some catalog rows could not be tied to course options")
    return requirement


def course_credits(code: str, courses_by_code: dict[str, dict[str, Any]]) -> int:
    value = courses_by_code.get(code, {}).get("credits", "")
    match = re.search(r"\d+", str(value))
    return int(match.group(0)) if match else 0


def block_paths(
    options: list[str | dict[str, Any]],
    credits_needed: int | None,
    courses_by_code: dict[str, dict[str, Any]],
) -> list[str | dict[str, Any]]:
    if not credits_needed:
        return options
    matched_paths: list[str | dict[str, Any]] = []
    for size in range(1, len(options) + 1):
        for selected in combinations(options, size):
            codes = sorted(
                {code for option in selected for code in path_codes(option)},
                key=course_sort_key,
            )
            total = sum(course_credits(code, courses_by_code) for code in codes)
            if total == credits_needed:
                matched_paths.append(make_course_path(codes))
    return matched_paths or options


def parse_sequence_table(
    table: Tag,
    courses_by_code: dict[str, dict[str, Any]],
) -> tuple[list[str], list[str | dict[str, Any]]]:
    areas: dict[str, list[dict[str, Any]]] = {}
    current_area: str | None = None
    current_block: dict[str, Any] | None = None

    for row in table.select("tr"):
        classes = set(row.get("class") or [])
        if "hidden" in classes:
            continue
        label = row_label(row)
        codes = row_codes(row)
        if "areaheader" in classes:
            current_area = label
            areas.setdefault(current_area, [])
            current_block = None
            continue
        if not current_area:
            continue
        if not codes:
            selection = parse_selection(label)
            current_block = {
                "credits_needed": row_credits(row) or (selection[1] if selection else None),
                "options": [],
            }
            areas[current_area].append(current_block)
            continue

        if current_block is None:
            current_block = {"credits_needed": row_credits(row), "options": []}
            areas[current_area].append(current_block)
        current_block["options"].append(make_course_path(codes))
        if row_credits(row):
            current_block = None

    all_codes: set[str] = set()
    sequence_paths: list[str | dict[str, Any]] = []
    for area, blocks in areas.items():
        paths_by_block = []
        for block in blocks:
            options = block_paths(
                block["options"], block.get("credits_needed"), courses_by_code
            )
            paths_by_block.append(options)
            for option in options:
                all_codes.update(path_codes(option))
        if not paths_by_block:
            continue
        for selected_paths in product(*paths_by_block):
            codes = sorted(
                {code for path in selected_paths for code in path_codes(path)},
                key=course_sort_key,
            )
            sequence_paths.append(make_course_path(codes, f"{area} sequence"))

    return sorted(all_codes, key=course_sort_key), sequence_paths


def find_heading(table: Tag) -> str:
    heading = table.find_previous(["h2", "h3", "h4"])
    return clean_text(heading.get_text(" ", strip=True)) if heading else "Program Requirements"


def replace_path_option(
    option: str | dict[str, Any],
    target_code: str,
    replacement_path: str | dict[str, Any],
    label: str,
) -> str | dict[str, Any]:
    if isinstance(option, str):
        return merge_alternatives(option, replacement_path, label) if option == target_code else option
    if option.get("courses") == [target_code]:
        return merge_alternatives(option, replacement_path, label)
    if option.get("alternatives"):
        option = dict(option)
        option["alternatives"] = [
            replace_path_option(alternative, target_code, replacement_path, label)
            for alternative in option["alternatives"]
        ]
    return option


def apply_replacement(
    requirements: list[dict[str, Any]],
    target_code: str,
    replacement_codes: list[str],
    note: str,
) -> bool:
    replacement_path = make_course_path(replacement_codes, note)
    applied = False
    for requirement in requirements:
        required_courses = requirement.get("required_courses", [])
        if target_code in required_courses:
            required_courses.remove(target_code)
            requirement.setdefault("option_groups", []).append(
                {
                    "label": note,
                    "required_count": 1,
                    "options": [target_code, replacement_path],
                }
            )
            applied = True
            continue

        for group in requirement.get("option_groups", []):
            original = json.dumps(group.get("options", []), sort_keys=True)
            group["options"] = [
                replace_path_option(option, target_code, replacement_path, note)
                for option in group.get("options", [])
            ]
            applied = applied or json.dumps(group["options"], sort_keys=True) != original

        if requirement.get("credit_options"):
            original = json.dumps(requirement["credit_options"], sort_keys=True)
            requirement["credit_options"] = [
                replace_path_option(option, target_code, replacement_path, note)
                for option in requirement["credit_options"]
            ]
            applied = applied or json.dumps(requirement["credit_options"], sort_keys=True) != original
    return applied


def compile_replacement_notes(
    container: Tag,
    requirements: list[dict[str, Any]],
    warnings: list[str],
) -> list[str]:
    source_notes = []
    seen_notes = set()
    seen_replacements = set()
    for paragraph in container.select("dd p"):
        note = clean_text(paragraph.get_text(" ", strip=True))
        if not note or note in seen_notes:
            continue
        seen_notes.add(note)
        source_notes.append(note)
        codes = []
        for link in paragraph.select("a"):
            code = normalize_course_code(
                link.get("title", "") or link.get_text(" ", strip=True)
            )
            if code and code not in codes:
                codes.append(code)
        replacement: tuple[str, tuple[str, ...]] | None = None

        if "replacement for" in note.lower() and len(codes) >= 2:
            replacement = (codes[1], (codes[0],))
        elif "may replace" in note.lower() and " with " in note.lower() and len(codes) >= 3:
            replacement = (codes[1], (codes[2], codes[0]))

        if replacement and replacement not in seen_replacements:
            seen_replacements.add(replacement)
            target, replacement_codes = replacement
            if not apply_replacement(requirements, target, list(replacement_codes), note):
                warnings.append(f"Replacement note did not match a modeled option: {note}")

        lower_note = note.lower()
        if codes and lower_note.startswith("none of ") and "may be used" in lower_note:
            for requirement in requirements:
                for rule in requirement.get("rules", []):
                    excluded = [
                        code for code in codes if code.startswith(f"{rule['subject']} ")
                    ]
                    rule["exclude"] = sorted(
                        set(rule.get("exclude", [])) | set(excluded),
                        key=course_sort_key,
                    )

    if source_notes:
        warnings.append(
            "Catalog footnotes are preserved in source_notes; replacement paths are compiled, "
            "while enrollment limits and special credit caps still require review."
        )
    return source_notes


def parse_program_page(
    html: str,
    source_url: str,
    program_id: str,
    name: str,
    label: str,
    catalog_year: str,
    courses_by_code: dict[str, dict[str, Any]] | None = None,
    mason_core_categories: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    container = soup.select_one("#requirementstextcontainer")
    if not container:
        raise ValueError("Could not find the catalog requirements container")

    course_index = courses_by_code or {}
    warnings: list[str] = []
    requirements = []
    natural_science_requirement: dict[str, Any] | None = None

    for table in container.select("table.sc_courselist"):
        heading = find_heading(table)
        if "two-course sequences" in heading.lower() and natural_science_requirement:
            sequence_codes, sequence_paths = parse_sequence_table(table, course_index)
            natural_science_requirement.setdefault("courses", []).extend(sequence_codes)
            natural_science_requirement.setdefault("option_groups", []).append(
                {
                    "label": heading,
                    "required_count": 1,
                    "options": sequence_paths,
                }
            )
            continue

        requirement = parse_standard_table(table, heading, warnings)
        has_candidates = any(
            requirement.get(key)
            for key in ("required_courses", "option_groups", "credit_options", "courses", "rules")
        )
        is_natural_science = heading.lower() == "natural science"
        if not has_candidates and not is_natural_science:
            warnings.append(f"{heading}: no course candidates were modeled")
            continue
        requirements.append(requirement)
        if is_natural_science:
            natural_science_requirement = requirement

    for requirement in requirements:
        if requirement.get("courses"):
            requirement["courses"] = sorted(set(requirement["courses"]), key=course_sort_key)

    source_notes = compile_replacement_notes(container, requirements, warnings)
    if mason_core_categories:
        apply_mason_core_categories(requirements, warnings, mason_core_categories)

    total_credits_match = re.search(
        r"Total\s+credits\s*:\s*(\d+)",
        soup.get_text(" ", strip=True),
        re.IGNORECASE,
    )
    program = {
        "id": program_id,
        "name": name,
        "label": label,
        "catalog_year": catalog_year,
        "source_url": source_url,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "notes": [
            "Generated from the official catalog requirement tables.",
            "Review scrape_warnings after catalog markup or wording changes.",
        ],
        "scrape_warnings": warnings,
        "source_notes": source_notes,
        "requirements": requirements,
    }
    if total_credits_match:
        program["total_credits"] = int(total_credits_match.group(1))
    return program


def load_course_index(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {course["code"]: course for course in data.get("courses", [])}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate app-ready degree requirement data from a GMU catalog program page."
    )
    parser.add_argument("--url", required=True, help="Full GMU catalog program URL.")
    parser.add_argument("--id", required=True, help="Stable program id, such as cs-bs-2026.")
    parser.add_argument("--name", required=True, help="Program name shown in the app.")
    parser.add_argument("--label", help="Short selector label. Defaults to the program name.")
    parser.add_argument("--catalog-year", required=True, help="Catalog year, such as 2026-2027.")
    parser.add_argument("--courses", default="data/courses.json", help="Course data used for credits.")
    parser.add_argument(
        "--mason-core-url",
        default=MASON_CORE_URL,
        help="Official Mason Core page used to resolve approved category options.",
    )
    parser.add_argument(
        "--output",
        default="data/programs.generated.json",
        help="Generated program JSON path.",
    )
    args = parser.parse_args()

    response = requests.get(
        args.url,
        headers={"User-Agent": "gmu-course-map program scraper"},
        timeout=30,
    )
    response.raise_for_status()
    mason_core_response = requests.get(
        args.mason_core_url,
        headers={"User-Agent": "gmu-course-map program scraper"},
        timeout=30,
    )
    mason_core_response.raise_for_status()
    mason_core_categories = parse_mason_core_page(mason_core_response.text)
    program = parse_program_page(
        response.text,
        args.url,
        args.id,
        args.name,
        args.label or args.name,
        args.catalog_year,
        load_course_index(Path(args.courses)),
        mason_core_categories,
    )
    program["supplemental_source_urls"] = [args.mason_core_url]
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps({"schema_version": 2, "programs": [program]}, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {len(program['requirements'])} requirement areas to {output_path}")
    print(f"Flagged {len(program['scrape_warnings'])} items for review")


if __name__ == "__main__":
    main()
