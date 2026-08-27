import { describe, expect, test } from "bun:test";

import {
  composeContextEnvelope,
  composeContextEnvelopeHeader,
  composeContextModuleBoundary,
} from "../adapters/context-envelope.js";
import { parseContextModule } from "../schemas/context-profile.js";

const PRECEDENCE =
  "Repository-owned project instructions, including AGENTS.md, take precedence when they conflict with this material.";

function moduleSource(id: string, body: string): string {
  return `---\nid: ${id}\ndependencies: []\n---\n${body}`;
}

describe("composeContextEnvelopeHeader", () => {
  test("emits compact Profile identity and repository-instruction precedence", () => {
    expect(composeContextEnvelopeHeader("engineering")).toBe(
      `# Agent Profile Kit Context — Profile: engineering\n${PRECEDENCE}`,
    );
  });
});

describe("composeContextEnvelope", () => {
  test("composes compact metadata followed by normalized module bodies", () => {
    const first = parseContextModule(
      moduleSource("communication", "# Communication and Behavior\nBe concise.\n"),
      "context/communication.md",
    );
    const second = parseContextModule(
      moduleSource("engineering", "# Engineering Principles\nShip small.\n"),
      "context/engineering.md",
    );
    expect(composeContextEnvelope("engineering", [first, second])).toBe(
      `# Agent Profile Kit Context — Profile: engineering\n${PRECEDENCE}\n\n` +
        "# Communication and Behavior\nBe concise.\n" +
        "# Engineering Principles\nShip small.\n",
    );
  });

  test("contains no YAML frontmatter or generated module boundary markers", () => {
    const first = parseContextModule(
      moduleSource("team-rules", "Stand-up at ten.\n"),
      "context/team-rules.md",
    );
    const composed = composeContextEnvelope("coding", [first]);
    expect(composed).not.toMatch(/^---/m);
    expect(composed).not.toContain("id:");
    expect(composed).not.toContain("dependencies:");
    expect(composed).not.toContain("<!--");
    expect(composed).toContain("Stand-up at ten.");
  });

  test("adds no separator between module bodies", () => {
    const first = parseContextModule(
      moduleSource("first", "Alpha.\n"),
      "context/first.md",
    );
    const second = parseContextModule(
      moduleSource("second", "Beta.\n"),
      "context/second.md",
    );
    const composed = composeContextEnvelope("coding", [first, second]);
    expect(composed).toContain("Alpha.\nBeta.\n");
    expect(composed.endsWith("Beta.\n")).toBe(true);
  });

  test("never glues a non-final body missing its trailing newline to the next module", () => {
    const unterminated = parseContextModule(
      moduleSource("unterminated", "Alpha."),
      "context/unterminated.md",
    );
    const second = parseContextModule(
      moduleSource("second", "Beta.\n"),
      "context/second.md",
    );
    const composed = composeContextEnvelope("coding", [unterminated, second]);
    expect(composed).toContain("Alpha.\nBeta.\n");
    expect(composed).not.toContain("Alpha.Beta.");
  });

  test("normalizes the final trailing newline sequence to exactly one newline", () => {
    const multiple = parseContextModule(
      moduleSource("trailing-many", "Content.\n\n\n"),
      "context/trailing-many.md",
    );
    const missing = parseContextModule(
      moduleSource("final-missing", "Last line."),
      "context/final-missing.md",
    );
    const manyComposed = composeContextEnvelope("coding", [multiple]);
    expect(manyComposed.endsWith("\n")).toBe(true);
    expect(manyComposed).not.toEndWith("\n\n");
    expect(composeContextEnvelope("coding", [missing]).endsWith("Last line.\n")).toBe(
      true,
    );
  });

  test("preserves empty-module selection producing only the compact envelope", () => {
    expect(composeContextEnvelope("coding", [])).toBe(
      `# Agent Profile Kit Context — Profile: coding\n${PRECEDENCE}\n`,
    );
  });
});

describe("composeContextModuleBoundary", () => {
  test("keeps complete per-module boundary markers for separate rule delivery", () => {
    const module = parseContextModule(
      moduleSource("communication", "Prefer concise communication.\n"),
      "context/communication.md",
    );
    expect(composeContextModuleBoundary(module)).toBe(
      "<!-- Context Module: communication -->\nPrefer concise communication.\n<!-- End Context Module: communication -->",
    );
  });
});
