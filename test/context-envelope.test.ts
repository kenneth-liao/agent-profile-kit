import { describe, expect, test } from "bun:test";

import {
  composeContextEnvelope,
  composeContextEnvelopeHeader,
  composeContextModuleBoundary,
} from "../adapters/context-envelope.js";
import { generatedMarkdownNotice } from "../adapters/generated-notice.js";
import { parseContextModule } from "../schemas/context-profile.js";

const NOTICE = generatedMarkdownNotice();

const PRECEDENCE =
  "Repository-owned project instructions, including AGENTS.md, take precedence when they conflict with this material.";

// Under path identity (spec #593 DEC-004/005, #600) a Context Module's
// content is the file's complete bytes: frontmatter is neither read nor
// stripped, so module fixtures here are plain byte strings.
function moduleSource(_id: string, body: string): string {
  return body;
}

describe("composeContextEnvelopeHeader", () => {
  test("emits compact Profile identity, generated-source guidance, and repository-instruction precedence", () => {
    const header = composeContextEnvelopeHeader("engineering");
    expect(header).toBe(
      `# Agent Profile Kit Context — Profile: engineering\n${NOTICE}\n${PRECEDENCE}`,
    );
    expect(header.split("\n")[1]).toBe(NOTICE);
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
      `# Agent Profile Kit Context — Profile: engineering\n${NOTICE}\n${PRECEDENCE}\n\n` +
        "# Communication and Behavior\nBe concise.\n" +
        "# Engineering Principles\nShip small.\n",
    );
  });

  test("delivers module bytes as written after the generated header", () => {
    // User frontmatter is content (spec #593 DEC-005, #600): it travels
    // byte-for-byte, after the generated header, and never becomes the Host
    // file's frontmatter.
    const first = parseContextModule(
      "---\nid: communication\n---\n# Communication and Behavior\nBe concise.\n",
      "context/communication.md",
    );
    const second = parseContextModule(
      moduleSource("engineering", "# Engineering Principles\nShip small.\n"),
      "context/engineering.md",
    );
    const composed = composeContextEnvelope("engineering", [first, second]);
    expect(composed).toBe(
      `# Agent Profile Kit Context — Profile: engineering\n${NOTICE}\n${PRECEDENCE}\n\n` +
        "---\nid: communication\n---\n# Communication and Behavior\nBe concise.\n" +
        "# Engineering Principles\nShip small.\n",
    );
    expect(composed.indexOf("---")).toBeGreaterThan(composed.indexOf("# Agent Profile Kit Context"));
  });

  test("adds no per-module boundary markers beyond the notice", () => {
    const first = parseContextModule(
      moduleSource("team-rules", "Stand-up at ten.\n"),
      "context/team-rules.md",
    );
    const composed = composeContextEnvelope("coding", [first]);
    expect(composed).not.toMatch(/^---/m);
    expect(composed).not.toMatch(/<!-- (End )?Context Module:/);
    expect(composed.match(/<!--/g)).toEqual(["<!--"]);
    expect(composed.split(NOTICE).length - 1).toBe(1);
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
      `# Agent Profile Kit Context — Profile: coding\n${NOTICE}\n${PRECEDENCE}\n`,
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
