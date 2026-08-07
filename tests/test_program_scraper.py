from __future__ import annotations

import unittest

from bs4 import BeautifulSoup

from program_scraper import (
    apply_mason_core_categories,
    parse_dynamic_rules,
    parse_mason_core_page,
    parse_program_page,
    parse_standard_table,
)


class ProgramScraperTests(unittest.TestCase):
    def test_mason_core_categories_resolve_program_placeholder_rows(self) -> None:
        html = """
        <a id="literature"></a>
        <p>Literature description</p>
        <table class="sc_courselist">
          <tr><td class="codecol"><a title="ENGH 201">ENGH 201</a></td></tr>
          <tr><td class="codecol"><a title="PHIL 253">PHIL 253</a></td></tr>
        </table>
        <a id="arts"></a>
        <table class="sc_courselist">
          <tr><td class="codecol"><a title="ARTH 101">ARTH 101</a></td></tr>
        </table>
        """
        categories = parse_mason_core_page(html)
        requirements = [{
            "label": "Additional Mason Core",
            "option_groups": [],
            "unmodeled": [
                {"label": "Literature", "credits_needed": 3},
                {"label": "Arts", "credits_needed": 3},
            ],
        }]
        warnings = ["Additional Mason Core: some catalog rows could not be tied to course options"]

        self.assertEqual(categories["Literature"], ["ENGH 201", "PHIL 253"])
        self.assertTrue(apply_mason_core_categories(requirements, warnings, categories))
        self.assertNotIn("unmodeled", requirements[0])
        self.assertEqual(requirements[0]["option_groups"][0]["required_count"], 1)
        self.assertEqual(requirements[0]["option_groups"][1]["options"], ["ARTH 101"])
        self.assertEqual(warnings, [])

    def test_standard_table_models_fixed_alternative_and_choose_count_rows(self) -> None:
        html = """
        <table class="sc_courselist">
          <tr><td class="codecol">CS 110</td><td>Essentials</td><td class="hourscol">3</td></tr>
          <tr><td class="codecol">CS 112</td><td>Programming</td><td class="hourscol">4</td></tr>
          <tr class="orclass"><td class="codecol">or CS 108 &amp; CS 109</td><td>Two-part path</td></tr>
          <tr><td colspan="2">Select two from the following:</td><td class="hourscol">6</td></tr>
          <tr><td class="codecol">CS 425</td><td>Game Programming</td></tr>
          <tr><td class="codecol">CS 440</td><td>Compilers</td></tr>
          <tr class="listsum"><td colspan="2">Total Credits</td><td class="hourscol">13</td></tr>
        </table>
        """
        table = BeautifulSoup(html, "html.parser").table
        assert table is not None
        warnings: list[str] = []
        requirement = parse_standard_table(table, "Computer Science", warnings)

        self.assertEqual(requirement["required_courses"], ["CS 110"])
        self.assertEqual(requirement["option_groups"][0]["required_count"], 1)
        self.assertEqual(
            requirement["option_groups"][0]["options"][1]["courses"],
            ["CS 108", "CS 109"],
        )
        self.assertEqual(requirement["option_groups"][1]["required_count"], 2)
        self.assertEqual(requirement["catalog_total_credits"], 13)
        self.assertEqual(warnings, [])

    def test_credit_list_preserves_or_paths_as_one_credit_option(self) -> None:
        html = """
        <table class="sc_courselist">
          <tr><td colspan="2">Select 6 credits from the following:</td><td class="hourscol">6</td></tr>
          <tr><td class="codecol">ECE 301</td><td>Digital Electronics</td></tr>
          <tr class="orclass"><td class="codecol">or ECE 231 &amp; ECE 232</td><td>Digital Design</td></tr>
        </table>
        """
        table = BeautifulSoup(html, "html.parser").table
        assert table is not None
        requirement = parse_standard_table(table, "Related", [])

        self.assertEqual(requirement["credits_needed"], 6)
        self.assertEqual(len(requirement["credit_options"]), 1)
        alternatives = requirement["credit_options"][0]["alternatives"]
        self.assertEqual(alternatives[0], "ECE 301")
        self.assertEqual(alternatives[1]["courses"], ["ECE 231", "ECE 232"])

    def test_dynamic_upper_level_rule_parses_subjects_and_exclusions(self) -> None:
        rules = parse_dynamic_rules(
            "Any MATH or CS course numbered above 300 (except MATH 351)"
        )
        self.assertEqual([rule["subject"] for rule in rules], ["MATH", "CS"])
        self.assertEqual([rule["min_number"] for rule in rules], [301, 301])
        self.assertEqual(rules[0]["exclude"], ["MATH 351"])
        self.assertEqual(rules[1]["exclude"], [])

    def test_program_page_compiles_replacement_note_and_science_sequence(self) -> None:
        html = """
        <div id="requirementstextcontainer">
          <p>Total credits: 120</p>
          <h3>Statistics</h3>
          <table class="sc_courselist">
            <tr><td class="codecol">STAT 344</td><td>Statistics</td><td class="hourscol">3</td></tr>
          </table>
          <dl><dd><p>Those who take
            <a title="MATH 352">MATH 352</a> may replace
            <a title="STAT 344">STAT 344</a> with
            <a title="MATH 351">MATH 351</a>.
          </p></dd></dl>
          <h3>Natural Science</h3>
          <table class="sc_courselist">
            <tr><td colspan="2">Select 12 credits of natural science</td><td class="hourscol">12</td></tr>
          </table>
          <h4>Approved Two-Course Sequences with Laboratories</h4>
          <table class="sc_courselist">
            <tr class="areaheader"><td colspan="2">Chemistry</td></tr>
            <tr><td class="codecol">CHEM 211 &amp; CHEM 213</td><td>First pair</td><td class="hourscol">4</td></tr>
            <tr><td class="codecol">CHEM 212 &amp; CHEM 214</td><td>Second pair</td><td class="hourscol">4</td></tr>
          </table>
        </div>
        """
        courses = {
            code: {"code": code, "credits": credits}
            for code, credits in {
                "CHEM 211": "3 credits",
                "CHEM 213": "1 credit",
                "CHEM 212": "3 credits",
                "CHEM 214": "1 credit",
                "STAT 344": "3 credits",
                "MATH 351": "3 credits",
                "MATH 352": "3 credits",
            }.items()
        }
        program = parse_program_page(
            html,
            "https://catalog.gmu.edu/example",
            "test-bs",
            "Test, BS",
            "Test BS",
            "2026-2027",
            courses,
        )

        self.assertEqual(program["total_credits"], 120)
        statistics = next(item for item in program["requirements"] if item["id"] == "statistics")
        self.assertEqual(statistics.get("required_courses"), [])
        stats_options = statistics["option_groups"][0]["options"]
        self.assertEqual(stats_options[0], "STAT 344")
        self.assertEqual(stats_options[1]["courses"], ["MATH 351", "MATH 352"])

        science = next(item for item in program["requirements"] if item["id"] == "natural-science")
        self.assertEqual(science["credits_needed"], 12)
        sequence = science["option_groups"][0]["options"][0]
        self.assertEqual(
            sequence["courses"],
            ["CHEM 211", "CHEM 212", "CHEM 213", "CHEM 214"],
        )


if __name__ == "__main__":
    unittest.main()
