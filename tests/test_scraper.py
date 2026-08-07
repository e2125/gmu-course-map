from __future__ import annotations

import unittest

from bs4 import BeautifulSoup

from scraper import extract_department_slugs, parse_prerequisite_details


def course(code: str) -> dict[str, str]:
    return {"type": "course", "code": code}


def parse(text: str):
    node = BeautifulSoup(f'<p class="prereq">{text}</p>', "html.parser").p
    assert node is not None
    return parse_prerequisite_details([node])


class PrerequisiteParserTests(unittest.TestCase):
    def test_commas_are_all_when_the_list_uses_and(self) -> None:
        logic, status, warnings = parse("CS 101, MATH 101 and STAT 101")
        self.assertEqual(
            logic,
            {
                "type": "all",
                "items": [course("CS 101"), course("MATH 101"), course("STAT 101")],
            },
        )
        self.assertEqual(status, "parsed")
        self.assertEqual(warnings, [])
    def test_oxford_comma_list_is_any_when_it_ends_in_or(self) -> None:
        logic, _, _ = parse("CS 101, MATH 101, or STAT 101")
        self.assertEqual(
            logic,
            {
                "type": "any",
                "items": [course("CS 101"), course("MATH 101"), course("STAT 101")],
            },
        )

    def test_comma_can_separate_required_course_from_an_alternative_group(self) -> None:
        logic, _, _ = parse("BIOL 103, CHEM 211 or CHEM 271")
        self.assertEqual(
            logic,
            {
                "type": "all",
                "items": [
                    course("BIOL 103"),
                    {
                        "type": "any",
                        "items": [course("CHEM 211"), course("CHEM 271")],
                    },
                ],
            },
        )

    def test_semicolon_keeps_two_alternative_groups_required(self) -> None:
        logic, _, _ = parse("(CS 101 or CS 102); MATH 101 or MATH 102")
        self.assertEqual(
            logic,
            {
                "type": "all",
                "items": [
                    {"type": "any", "items": [course("CS 101"), course("CS 102")]},
                    {"type": "any", "items": [course("MATH 101"), course("MATH 102")]},
                ],
            },
        )

    def test_missing_operator_is_treated_as_and(self) -> None:
        logic, _, _ = parse("CS 101 MATH 101")
        self.assertEqual(
            logic,
            {"type": "all", "items": [course("CS 101"), course("MATH 101")]},
        )

    def test_and_or_is_treated_as_an_alternative(self) -> None:
        logic, _, _ = parse("CS 101 and/or MATH 101")
        self.assertEqual(
            logic,
            {"type": "any", "items": [course("CS 101"), course("MATH 101")]},
        )

    def test_non_course_requirement_is_labeled_instead_of_silently_dropped(self) -> None:
        logic, status, warnings = parse("Permission of the instructor is required.")
        self.assertIsNone(logic)
        self.assertEqual(status, "non_course")
        self.assertEqual(warnings, [])


class CourseIndexTests(unittest.TestCase):
    def test_department_discovery_deduplicates_catalog_links(self) -> None:
        html = """
        <a href="/courses/cs/">Computer Science (CS)</a>
        <a href="/courses/engh/">English (ENGH)</a>
        <a href="/courses/cs/">Computer Science again</a>
        <a href="/courses/">Course index</a>
        <a href="/colleges/engineering/">Not a course subject</a>
        """
        self.assertEqual(extract_department_slugs(html), ["cs", "engh"])


if __name__ == "__main__":
    unittest.main()
