import { describe, it, expect } from "vitest";
import { parseQuestions, formatAnswers } from "../../../src/cli/questions.js";

describe("questions unit tests", () => {
  describe("parseQuestions", () => {
    it("parses numbered questions with defaults and varying numbering styles", () => {
      const markdown = `
# Questions for human

1. Which cache layer should the helper use?
   Default: memory

2) Should telemetry be enabled?
   DEFAULT: false

3. Which database host?
`;
      const questions = parseQuestions(markdown);
      expect(questions).toEqual([
        {
          id: "Q1",
          text: "Which cache layer should the helper use?",
          default: "memory",
        },
        {
          id: "Q2",
          text: "Should telemetry be enabled?",
          default: "false",
        },
        {
          id: "Q3",
          text: "Which database host?",
        },
      ]);
    });

    it("handles markdown with no numbered items", () => {
      const markdown = `
# Clarification needed
Please choose a cache layer and database host.
`;
      const questions = parseQuestions(markdown);
      expect(questions).toEqual([]);
    });

    it("parses multi-line question text and defaults", () => {
      const markdown = `
1. What is the preferred
   architecture for the auth service?
   Default: monolithic JWT
`;
      const questions = parseQuestions(markdown);
      expect(questions).toHaveLength(1);
      expect(questions[0].id).toBe("Q1");
      expect(questions[0].text).toBe("What is the preferred\n   architecture for the auth service?");
      expect(questions[0].default).toBe("monolithic JWT");
    });

    it("handles empty string", () => {
      expect(parseQuestions("")).toEqual([]);
    });

    it("handles question without default marker", () => {
      const markdown = `1. What port?`;
      expect(parseQuestions(markdown)).toEqual([
        {
          id: "Q1",
          text: "What port?",
        },
      ]);
    });
  });

  describe("formatAnswers", () => {
    it("formats answers overriding defaults and falling back when omitted", () => {
      const questions = [
        { id: "Q1", text: "Which cache?", default: "memory" },
        { id: "Q2", text: "Enable telemetry?", default: "false" },
        { id: "Q3", text: "Port number?", default: "8080" },
      ];
      const answers = [
        { id: "Q1", text: "redis" },
        { id: "Q3", text: "3000" },
      ];

      const formatted = formatAnswers(questions, answers);
      expect(formatted).toBe(
        "Q1: Which cache?\nAnswer: redis\n\nQ2: Enable telemetry?\nAnswer: false\n\nQ3: Port number?\nAnswer: 3000"
      );
    });

    it("stores answer text containing 'Default:' verbatim", () => {
      const questions = [{ id: "Q1", text: "What is your preference?" }];
      const answers = [{ id: "Q1", text: "I prefer Default: none" }];

      const formatted = formatAnswers(questions, answers);
      expect(formatted).toBe("Q1: What is your preference?\nAnswer: I prefer Default: none");
    });

    it("returns empty string when both questions and answers are empty", () => {
      expect(formatAnswers([], [])).toBe("");
    });

    it("formats answers when questions array is empty", () => {
      const answers = [{ id: "Q1", text: "standalone" }];
      expect(formatAnswers([], answers)).toBe("Q1: standalone");
    });
  });
});
