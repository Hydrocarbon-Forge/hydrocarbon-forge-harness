import type { Question } from "../contracts/index.js";

/**
 * Parses questions from markdown text (e.g. QUESTIONS.md).
 * Numbered items (`^\s*\d+[.)]\s+`) are questions, with ids Q1, Q2 in order.
 * A `Default:` marker inside an item (case-insensitive) sets `default`, and
 * the text before it is `text`.
 */
export function parseQuestions(markdown: string): Question[] {
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let currentItem: string[] | null = null;

  for (const line of lines) {
    const match = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (match) {
      if (currentItem !== null) {
        items.push(currentItem.join("\n"));
      }
      currentItem = [match[1]];
    } else if (currentItem !== null) {
      currentItem.push(line);
    }
  }
  if (currentItem !== null) {
    items.push(currentItem.join("\n"));
  }

  const questions: Question[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    const id = `Q${i + 1}`;
    const defMatch = raw.match(/\bdefault:\s*/i);
    if (defMatch && defMatch.index !== undefined) {
      const text = raw.slice(0, defMatch.index).trim();
      const defVal = raw.slice(defMatch.index + defMatch[0].length).trim();
      questions.push({
        id,
        text,
        default: defVal,
      });
    } else {
      questions.push({
        id,
        text: raw.trim(),
      });
    }
  }

  return questions;
}

/**
 * Formats answered questions into the plain text value for the `answers` variable
 * in `assets/prompts/planner/answers.md`.
 */
export function formatAnswers(
  questions: Question[],
  answers: Array<{ id: string; text: string }>
): string {
  const ansMap = new Map(answers.map((a) => [a.id, a.text]));

  if (questions.length === 0) {
    if (answers.length === 0) return "";
    return answers.map((a) => `${a.id}: ${a.text}`).join("\n\n");
  }

  const sections: string[] = [];
  for (const q of questions) {
    const ansText = ansMap.get(q.id) ?? q.default ?? "";
    sections.push(`${q.id}: ${q.text}\nAnswer: ${ansText}`);
  }
  return sections.join("\n\n");
}
