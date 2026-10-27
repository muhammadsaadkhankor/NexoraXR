// Shared administrative-content detection — single source of truth for the
// ingest filter, retrieval filter, and narration validator.

export const ADMIN_RE = /\b(grading|grade scheme|syllabus|office hours?|office\b|email|e-mail|contact|course policy|policies|deadline|late work|attendance|schedule|assignment|assessment|project grade|exam dates?|midterm|final exam|textbook|plagiarism|academic integrity|prerequisite|logistics|ta\b|teaching assistant|instructor|professor\b.*@|announcement|canvas|blackboard|course structure|learning outcomes|what you('| wi)ll learn|lecture 1 introduction to the course)\b/i;

// True when a text is dominated by admin content (≥3 hits) or is a short
// admin-flavored fragment (<40 words and matches at all).
export function isAdminText(t) {
  const words = String(t || '').split(/\s+/).filter(Boolean);
  const hits = words.filter((w) => ADMIN_RE.test(w)).length;
  return hits >= 3 || (ADMIN_RE.test(t) && words.length < 40);
}

// Lighter check for narration — flags any paragraph that mentions admin topics
// at all (the validator decides how much is too much per section).
export const ADMIN_NARRATION = /\b(grading|assessment|assignments|office hours|deadline|syllabus|course structure|what you('| wi)ll learn|contact|email|exam dates?|attendance|policies|prerequisites?)\b/i;
