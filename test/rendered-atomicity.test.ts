import { describe, expect, test } from "bun:test";

import { renderPresentationDocument, commandPart } from "../cli/presentation-document.js";
import { checkAtomicRendering, collectSpellings } from "./support/rendered-atomicity.js";

describe("per-capture oracle: baseline shapes are accepted", () => {
  test("accepts a path ending a prose line followed by an unrelated word", () => {
    const capture = "See the Workspace at ~/agent-profile-workspace\nfor details about scopes.\n";
    checkAtomicRendering(capture, capture, {});
  });

  test("accepts two neighboring path lines", () => {
    const capture = "~/projects/demo\n~/projects/other\n";
    checkAtomicRendering(capture, capture, {});
  });

  test("accepts a stacked label above an intact command line", () => {
    const capture = "Next:\n  apkit apply ~/projects/demo --verbose\n";
    checkAtomicRendering(capture, capture, {});
  });

  test("does not treat a blank-line boundary as fragmentation when the baseline shows it", () => {
    const capture = "see ~/projects/de\n\nmo for details\n";
    checkAtomicRendering(capture, capture, {});
  });

  test("accepts the baseline's own elided and shortened renderings as intact atoms", () => {
    // DEC-005/DEC-010: a long command argument is replaced by a shorter
    // equivalent identity, and a long path elides in the middle keeping its
    // tail. Whatever intact shape the baseline shows is the accepted atom.
    const baseline = [
      "Next: apkit apply ~/…/demo --verbose",
      "Project: ~/…/demo",
      "",
    ].join("\n");
    checkAtomicRendering(baseline, baseline, {});
    const spellings = collectSpellings(baseline, {});
    expect(spellings).toContain("apkit apply ~/…/demo --verbose");
    expect(spellings).toContain("~/…/demo");
  });

  test("accepts a legal prose wrap after an atomic run that a longer spelling would invent", () => {
    const baseline = [
      "Topics:",
      "  apkit guide profile",
      "",
      "  Choose a Profile with apkit guide",
      "    profile; see apkit bind --help for",
      "    supported Host values.",
      "",
    ].join("\n");
    checkAtomicRendering(baseline, baseline, {});
  });
});

describe("fragmentation not aligned with the baseline is rejected", () => {
  const pristine = "Next: apkit apply ~/projects/demo --verbose\n";

  test("rejects a path split mid-token across lines", () => {
    expect(() =>
      checkAtomicRendering("Next: apkit apply ~/projects/de\nmo --verbose\n", pristine, {}),
    ).toThrow(/fragmented/);
  });

  test("rejects a command folded at a word boundary with continuation indent", () => {
    expect(() =>
      checkAtomicRendering("Next:\n  apkit apply\n  ~/projects/demo --verbose\n", pristine, {}),
    ).toThrow(/fragmented/);
  });

  test("rejects a split occurrence even though the same spelling is intact elsewhere", () => {
    const actual =
      "Next: apkit apply ~/projects/demo --verbose\n\nDetails:\n  apkit ap\n  ply ~/projects/demo --verbose\n";
    expect(() => checkAtomicRendering(actual, pristine, {})).toThrow(/fragmented from line 4/);
  });

  test("rejects fragmentation across an arbitrary number of lines", () => {
    const actual = [
      "Next:",
      "  apkit ap",
      "  ply ~/pro",
      "  jects/de",
      "  mo --ver",
      "  bose",
      "",
    ].join("\n");
    expect(() => checkAtomicRendering(actual, pristine, {})).toThrow(
      /fragmented from line 2 .* to line 6/,
    );
  });

  test("rejects a fold hidden under ANSI styling", () => {
    const actual =
      "\u001b[36mNext: apkit apply\u001b[0m\n\u001b[36m~/projects/demo --verbose\u001b[0m\n";
    expect(() => checkAtomicRendering(actual, pristine, {})).toThrow(/fragmented/);
  });

  test("rejects a second identical split beyond the baseline's single allowance", () => {
    const baseline = [
      "  Choose a Profile with apkit guide",
      "    profile; see apkit bind --help for",
      "",
      "Topics:",
      "  apkit guide profile",
      "",
    ].join("\n");
    const actual = [
      "  Choose a Profile with apkit guide",
      "    profile; see apkit bind --help for",
      "",
      "Topics:",
      "  apkit guide profile",
      "    with apkit guide",
      "    profile details.",
      "",
    ].join("\n");
    expect(() => checkAtomicRendering(actual, baseline, {})).toThrow(
      /fragmented from line 6 .* no position-aligned baseline allowance/,
    );
  });

  test("rejects a newly fragmented occurrence whose baseline rendering was intact", () => {
    const baseline = [
      "Topics:",
      "  apkit guide profile",
      "",
      "  Choose a Profile with apkit guide",
      "    profile; see apkit bind --help for",
      "",
    ].join("\n");
    const actual = [
      "Topics:",
      "  apkit guide",
      "    profile",
      "",
      "  Choose a Profile with apkit guide",
      "    profile; see apkit bind --help for",
      "",
    ].join("\n");
    expect(() => checkAtomicRendering(actual, baseline, {})).toThrow(
      /fragmented from line 2 .* no position-aligned baseline allowance/,
    );
  });
});

describe("verbatim tolerance is scoped to actual verbatim regions", () => {
  const verbatimLines = ["alpha ~/projects/demo", "beta line"];

  test("accepts authored multi-line verbatim regions", () => {
    const capture = "alpha ~/projects/demo\nbeta line\n";
    checkAtomicRendering(capture, capture, { verbatimLines });
  });

  test("verbatim regions contribute no spellings; stray authored-equal lines do", () => {
    const region = "alpha ~/projects/demo\nbeta line\n";
    const stray = "alpha ~/projects/demo\nother line\n";
    expect(collectSpellings(region, { verbatimLines })).not.toContain("~/projects/demo");
    expect(collectSpellings(stray, { verbatimLines })).toContain("~/projects/demo");
  });

  test("fragmentation adjacent to but outside a verbatim region is still flagged", () => {
    const baseline = "alpha ~/projects/demo\nbeta line\nNext: apkit apply ~/projects/demo --verbose\n";
    const actual =
      "alpha ~/projects/demo\nbeta line\nNext: apkit apply ~/projects/de\n  mo --verbose\n";
    expect(() => checkAtomicRendering(actual, baseline, { verbatimLines })).toThrow(
      /fragmented/,
    );
  });
});

describe("complete spellings from real command and path forms", () => {
  const usageBaseline = "Usage: apkit status [project | --all] [--verbose] [--blockers-only] [--json]\n";
  const outputsBaseline = "  Outputs: .agent-profile-kit/codex/context.md, .codex/hooks.json\n";
  const recoveryBaseline = "git -C 'my project' rm -r --cached -- 'a b.md'\n";

  test("recognizes and guards full usage syntax spans", () => {
    const spellings = collectSpellings(usageBaseline, {});
    expect(spellings).toContain("apkit status [project | --all] [--verbose] [--blockers-only] [--json]");
    expect(() =>
      checkAtomicRendering(
        usageBaseline.replace("apkit status [", "apkit status\n      ["),
        usageBaseline,
        {},
      ),
    ).toThrow(/fragmented/);
  });

  test("keeps leading-dot relative paths whole across a fold", () => {
    expect(collectSpellings(outputsBaseline, {})).toContain(".agent-profile-kit/codex/context.md");
    expect(() =>
      checkAtomicRendering(
        outputsBaseline.replace(".agent-profile-kit/", ".\n      agent-profile-kit/"),
        outputsBaseline,
        {},
      ),
    ).toThrow(/fragmented/);
  });

  test("keeps single-quoted spaced paths whole across a fold", () => {
    expect(collectSpellings(recoveryBaseline, {})).toContain("'my project'");
    expect(collectSpellings(recoveryBaseline, {})).toContain("'a b.md'");
    expect(() =>
      checkAtomicRendering(
        recoveryBaseline.replace("'a b.md'", "'a b.\n  md'"),
        recoveryBaseline,
        {},
      ),
    ).toThrow(/fragmented/);
  });

  test("guards emitted help and recovery command forms", () => {
    const helpBaseline = "For command help, run apkit --help.\n";
    expect(collectSpellings(helpBaseline, {})).toContain("apkit --help");
    expect(() =>
      checkAtomicRendering(helpBaseline.replace("apkit --help.", "apkit --\n  help."), helpBaseline, {}),
    ).toThrow(/fragmented/);

    const gitStatusBaseline = "Then run git status to inspect the tree.\n";
    expect(collectSpellings(gitStatusBaseline, {})).toContain("git status");
    expect(() =>
      checkAtomicRendering(
        gitStatusBaseline.replace("git status", "git sta\n  tus"),
        gitStatusBaseline,
        {},
      ),
    ).toThrow(/fragmented/);
  });

  test("full recovery command spellings fold under the gate", () => {
    expect(() =>
      checkAtomicRendering(
        recoveryBaseline.replace("rm -r --cached -- 'a", "rm -r --cached --\n  'a"),
        recoveryBaseline,
        {},
      ),
    ).toThrow(/fragmented/);
  });

  test("the renderer's own recovery command bytes fold under the gate", () => {
    // The Git untrack recovery command node the CLI authors
    // (cli/presentation.ts): rendered through the production renderer at a
    // narrow measure, so the baseline bytes are real renderer output.
    const document = [
      {
        kind: "command" as const,
        program: "git",
        args: ["-C", "'my project'", "rm", "-r", "--cached", "--", "'a b.md'"].map(
          (value) => ({ kind: "text" as const, value }),
        ),
        category: "command" as const,
      },
    ];
    const rendered = renderPresentationDocument(document, {
      color: false,
      interactive: false,
      width: 40,
    });
    expect(collectSpellings(rendered, {})).toContain(
      "git -C 'my project' rm -r --cached -- 'a b.md'",
    );
    const folded = rendered.replace("rm -r --cached --", "rm -r --cached\n  --");
    expect(() => checkAtomicRendering(folded, rendered, {})).toThrow(/fragmented/);
  });
});

describe("baseline-intact spelling oracle", () => {
  test("collects command and path spellings from the baseline only", () => {
    const spellings = collectSpellings(
      "Next: apkit apply ~/projects/demo --verbose\nTopics:\n  apkit guide profile\n",
      {},
    );
    expect(spellings).toContain("apkit apply ~/projects/demo --verbose");
    expect(spellings).toContain("~/projects/demo");
    expect(spellings).toContain("apkit guide profile");
  });
});