import { describe, expect, test } from "bun:test";

import { parseBunJunitEvidence } from "./support/junit-evidence.js";

/**
 * Bun's junit reporter is the runner's structured evidence output. This
 * boundary owns one concern: extracting the per-file executed evidence (file
 * path, test count, failure count, skip count) from one bun-produced junit
 * XML document. It accepts exactly the structure bun 1.4 emits, decodes the
 * standard XML attribute references, and fails closed — any malformed,
 * unexpected, or non-bun document throws instead of yielding partial data,
 * so a caller can never mistake unparseable evidence for executed coverage.
 */

const bunDocument = (suites: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="bun test" tests="2" failures="0" skipped="0" time="0.003">`,
    suites,
    `</testsuites>`,
  ].join("\n");

describe("bun junit evidence: extraction", () => {
  test("extracts per-file evidence from a well-formed bun document", () => {
    const document = bunDocument(
      [
        `  <testsuite name="a.test.ts" file="test/a.test.ts" tests="2" assertions="2" failures="0" skipped="0" time="0.001" hostname="x">`,
        `    <testcase name="passes" classname="" time="0.00001" file="test/a.test.ts" line="2" assertions="1" />`,
        `  </testsuite>`,
        `  <testsuite name="b.test.ts" file="test/b.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.0001" hostname="x">`,
        `    <testcase name="also passes" classname="" time="0.00001" file="test/b.test.ts" line="2" assertions="1" />`,
        `  </testsuite>`,
      ].join("\n"),
    );
    const evidence = parseBunJunitEvidence(document);
    expect(evidence.suites).toHaveLength(2);
    expect(evidence.suites[0]).toEqual({
      file: "test/a.test.ts",
      tests: 2,
      failures: 0,
      skipped: 0,
    });
    expect(evidence.suites[1]?.file).toBe("test/b.test.ts");
  });

  test("decodes standard and numeric character references in attributes exactly once", () => {
    const document = bunDocument(
      [
        `  <testsuite name="q&quot;&amp;&lt;&gt;&apos;" file="test/&#65;.test.ts" tests="1" failures="0" skipped="0" time="0.0" hostname="x">`,
        `    <testcase name="&#x41;&amp;B" classname="" time="0" file="test/A.test.ts" line="2" assertions="1" />`,
        `  </testsuite>`,
      ].join("\n"),
    );
    const evidence = parseBunJunitEvidence(document);
    expect(evidence.suites[0]?.file).toBe("test/A.test.ts");
    expect(evidence.suites[0]?.tests).toBe(1);
    // An attribute that encodes an ampersand (`&amp;lt;` is the escaped form
    // of the literal text `&lt;`) must decode once, not twice: the escaped
    // file name contains `&lt;`, not `<`.
    const escaped = bunDocument(
      `  <testsuite name="x" file="test/&amp;lt;name.test.ts" tests="1" failures="0" skipped="0" time="0.0" hostname="x"></testsuite>`,
    );
    expect(parseBunJunitEvidence(escaped).suites[0]?.file).toBe("test/&lt;name.test.ts");
    const ampersand = bunDocument(
      `  <testsuite name="x" file="test/a&amp;b.test.ts" tests="1" failures="0" skipped="0" time="0.0" hostname="x"></testsuite>`,
    );
    expect(parseBunJunitEvidence(ampersand).suites[0]?.file).toBe("test/a&b.test.ts");
  });

  test("counts only root-level suites when describe blocks nest further testsuite elements", () => {
    const document = bunDocument(
      [
        `  <testsuite name="a.test.ts" file="test/a.test.ts" tests="29" assertions="11" failures="0" skipped="28" time="0.01" hostname="x">`,
        `    <testsuite name="describe block" file="test/a.test.ts" line="70" tests="17" assertions="11" failures="0" skipped="16" time="0.006" hostname="x">`,
        `      <testcase name="runs" classname="describe block" time="0.006" file="test/a.test.ts" line="75" assertions="11" />`,
        `      <testcase name="filtered out" classname="describe block" time="0" file="test/a.test.ts" line="71" assertions="0">`,
        `        <skipped />`,
        `      </testcase>`,
        `    </testsuite>`,
        `  </testsuite>`,
      ].join("\n"),
    );
    const evidence = parseBunJunitEvidence(document);
    expect(evidence.suites).toHaveLength(1);
    expect(evidence.suites[0]).toEqual({
      file: "test/a.test.ts",
      tests: 29,
      failures: 0,
      skipped: 28,
    });
  });

  test("skips over testcase children including self-closing and text-bearing elements", () => {
    const document = bunDocument(
      [
        `  <testsuite name="a.test.ts" file="test/a.test.ts" tests="3" assertions="2" failures="1" skipped="1" time="0.0" hostname="x">`,
        `    <testcase name="passing with &quot;quotes&quot; &amp; &lt;brackets&gt;" classname="" time="0.000026" file="test/a.test.ts" line="2" assertions="1" />`,
        `    <testcase name="skipped" classname="" time="0" file="test/a.test.ts" line="3" assertions="0">`,
        `      <skipped />`,
        `    </testcase>`,
        `    <testcase name="failing" classname="" time="0.0002" file="test/a.test.ts" line="4" assertions="1">`,
        `      <failure type="AssertionError" message="Expected: 2&#10;Received: 1">AssertionError: detail &#38; text</failure>`,
        `    </testcase>`,
        `  </testsuite>`,
      ].join("\n"),
    );
    const evidence = parseBunJunitEvidence(document);
    expect(evidence.suites).toHaveLength(1);
    expect(evidence.suites[0]).toEqual({
      file: "test/a.test.ts",
      tests: 3,
      failures: 1,
      skipped: 1,
    });
  });
});

describe("bun junit evidence: fail closed", () => {
  test("rejects empty, non-XML, and non-bun documents", () => {
    for (const malformed of ["", "   \n", "not xml at all", "<other-root/>"]) {
      expect(() => parseBunJunitEvidence(malformed), JSON.stringify(malformed)).toThrow();
    }
  });

  test("rejects documents with unbalanced or malformed tags", () => {
    for (const malformed of [
      "<testsuites><testsuite file=\"a\" tests=\"1\"",
      "<testsuites><testsuite file='a' tests=1></testsuite></testsuites>",
      "<testsuites><testsuite></unexpected></testsuite></testsuites>",
      "<testsuites>stray < broken</testsuites>",
      "<testsuites><testsuite file=\"a\" tests=\"1\" unclosed=\"</testsuite></testsuites>",
    ]) {
      expect(() => parseBunJunitEvidence(malformed), JSON.stringify(malformed)).toThrow();
    }
  });

  test("rejects a testsuite element missing a required numeric attribute", () => {
    const malformed = bunDocument(
      `  <testsuite name="a.test.ts" file="test/a.test.ts" tests="1" failures="0" time="0.0" hostname="x"></testsuite>`,
    );
    expect(() => parseBunJunitEvidence(malformed)).toThrow(/skipped/);
  });

  test("rejects a testsuite element missing the file attribute", () => {
    const malformed = bunDocument(
      `  <testsuite name="a.test.ts" tests="1" failures="0" skipped="0" time="0.0" hostname="x"></testsuite>`,
    );
    expect(() => parseBunJunitEvidence(malformed)).toThrow(/file/);
  });

  test("rejects non-integer evidence counts", () => {
    const suite = (overrides: string): string =>
      bunDocument(
        `  <testsuite name="a.test.ts" file="test/a.test.ts" tests="1" failures="0" skipped="0" time="0.0" hostname="x">${""}</testsuite>`.replace(
          'tests="1" failures="0" skipped="0"',
          overrides,
        ),
      );
    for (const [attributes, attribute] of [
      [`tests="" failures="0" skipped="0"`, "tests"],
      [`tests="1.5" failures="0" skipped="0"`, "tests"],
      [`tests="1.0" failures="0" skipped="0"`, "tests"],
      [`tests="1e2" failures="0" skipped="0"`, "tests"],
      [`tests="+1" failures="0" skipped="0"`, "tests"],
      [`tests="1" failures="" skipped="0"`, "failures"],
      [`tests="1" failures="1e2" skipped="0"`, "failures"],
      [`tests="1" failures="0" skipped=""`, "skipped"],
      [`tests="1" failures="0" skipped="1.0"`, "skipped"],
      [`tests="1" failures="0" skipped="1e2"`, "skipped"],
    ] as const) {
      expect(() => parseBunJunitEvidence(suite(attributes)), attributes).toThrow(
        new RegExp(attribute),
      );
    }
  });
});