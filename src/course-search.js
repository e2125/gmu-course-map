function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

export function getCourseSearchRank(course, query) {
  const text = normalizedText(query);
  if (!text) return 0;

  const code = normalizedText(course.code);
  const title = normalizedText(course.title);
  const description = normalizedText(course.description);
  const prerequisiteText = normalizedText(course.prerequisite_text);

  if (code === text) return 0;
  if (code.startsWith(text)) return 1;
  if (title.startsWith(text)) return 2;
  if (code.includes(text) || title.includes(text)) return 3;
  if (description.includes(text)) return 4;
  if (prerequisiteText.includes(text)) return 5;
  return null;
}

export function searchCourses(courses, query, compareCodes, limit = 60) {
  const text = normalizedText(query);
  if (!text) return courses.slice(0, limit);

  return courses
    .map((course) => ({ course, rank: getCourseSearchRank(course, text) }))
    .filter((result) => result.rank !== null)
    .sort((first, second) =>
      first.rank - second.rank || compareCodes(first.course.code, second.course.code),
    )
    .slice(0, limit)
    .map((result) => result.course);
}
