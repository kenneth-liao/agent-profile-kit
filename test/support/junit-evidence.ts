/**
 * One concern: extract per-file executed evidence from one junit XML document
 * produced by Bun's test reporter. The parser accepts exactly the structure
 * the qualified runner emits (testsuites root, testsuite elements with
 * `file`, `tests`, `failures`, `skipped` attributes, testcase children with
 * optional self-closing or text-bearing children). Standard and numeric XML
 * character references are decoded; an unrecognized reference survives
 * undecoded, which can only make the evidence fail to match a selection and
 * therefore fail closed. Anything structurally else — malformed markup, an
 * unexpected root, a missing or non-integer required attribute — throws, so callers can
 * fail closed: unparseable evidence must never be mistaken for executed
 * required coverage.
 */

interface TestsuiteEvidence {
  readonly file: string;
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
}

export interface BunJunitEvidence {
  readonly suites: readonly TestsuiteEvidence[];
}

type Tag =
  | { readonly kind: "open"; readonly name: string; readonly attributes: ReadonlyMap<string, string>; readonly selfClosing: boolean }
  | { readonly kind: "close"; readonly name: string };

const NAME_PATTERN = /[A-Za-z_][\w.:-]*/;
const REQUIRED_ATTRIBUTES = ["file", "tests", "failures", "skipped"] as const;

/** Decode the character references the runner emits inside quoted attributes. */
function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) {
    return value;
  }
  return value.replace(/&(?:#\d+|#x[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    const numeric = entity.slice(1, -1);
    const code = numeric.startsWith("#x") || numeric.startsWith("#X")
      ? Number.parseInt(numeric.slice(2), 16)
      : Number.parseInt(numeric.slice(1), 10);
    if (!Number.isFinite(code)) {
      throw new Error(`bun junit evidence: unsupported character reference '${entity}'`);
    }
    return String.fromCodePoint(code);
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
    if (index >= source.length) break;
    const nameMatch = NAME_PATTERN.exec(source.slice(index));
    if (nameMatch === null || nameMatch.index !== 0) {
      throw new Error(`bun junit evidence: malformed attribute near '${source.slice(index, index + 20)}'`);
    }
    const name = nameMatch[0];
    index += name.length;
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
    if (source[index] !== "=") {
      throw new Error(`bun junit evidence: attribute '${name}' has no value`);
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`bun junit evidence: attribute '${name}' is not quoted`);
    }
    const end = source.indexOf(quote, index + 1);
    if (end === -1) {
      throw new Error(`bun junit evidence: attribute '${name}' is unterminated`);
    }
    attributes.set(name, decodeXmlEntities(source.slice(index + 1, end)));
    index = end + 1;
  }
  return attributes;
}

interface ParsedTag {
  readonly open: boolean;
  readonly selfClosing: boolean;
  readonly name: string;
  readonly attributes: Map<string, string>;
}

/** Tokenize one '<...>' tag. Text content between tags is structural padding. */
function parseTag(tagSource: string): { readonly open: boolean; readonly close: boolean; readonly selfClosing: boolean; readonly name: string; readonly attributes: Map<string, string> } {
  const body = tagSource.slice(1, -1);
  const isClose = body.startsWith("/");
  const selfClosing = body.endsWith("/");
  const nameSource = isClose ? body.slice(1) : selfClosing ? body.slice(0, -1) : body;
  const nameMatch = NAME_PATTERN.exec(nameSource);
  if (nameMatch === null || nameMatch.index !== 0) {
    throw new Error(`bun junit evidence: malformed tag '${tagSource.slice(0, 40)}'`);
  }
  const name = nameMatch[0];
  const attributes = isClose ? new Map<string, string>() : parseAttributes(nameSource.slice(name.length));
  return { open: !isClose, close: isClose, selfClosing, name, attributes };
}

function attributeNumber(attributes: Map<string, string>, name: string, where: string): number {
  const raw = attributes.get(name);
  if (raw === undefined) {
    throw new Error(`bun junit evidence: testsuite element is missing the '${name}' attribute ${where}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`bun junit evidence: testsuite '${name}' must be a non-negative integer, got '${raw}' ${where}`);
  }
  return value;
}

/**
 * Parse one bun junit document. Only `<testsuite>` elements carry evidence;
 * `<testcase>` and its `<skipped>`/`<failure>` children are verified for
 * well-formed nesting and skipped over. The root must be `testsuites`.
 */
export function parseBunJunitEvidence(xml: string): BunJunitEvidence {
  if (xml.trim().length === 0) {
    throw new Error("bun junit evidence: document is empty");
  }
  const suites: TestsuiteEvidence[] = [];
  let rootSeen = false;
  const stack: string[] = [];
  let index = 0;
  while (index < xml.length) {
    // The declaration and any processing instructions precede the root.
    if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index);
      if (end === -1) throw new Error("bun junit evidence: unterminated processing instruction");
      index = end + 2;
      continue;
    }
    const tagStart = xml.indexOf("<", index);
    if (tagStart === -1) break;
    const text = xml.slice(index, tagStart);
    if (text.trim().length > 0 && stack.length > 0) {
      // Character data inside known children (e.g. <failure> text) is
      // tolerated; stray text at the document or testsuites level is not.
      if (stack[stack.length - 1] === "testsuites") {
        throw new Error("bun junit evidence: unexpected character data inside the testsuites element");
      }
    }
    const tagEnd = xml.indexOf(">", tagStart);
    if (tagEnd === -1) {
      throw new Error("bun junit evidence: unterminated tag");
    }
    if (xml.slice(tagStart, tagStart + 4) === "<!--") {
      const commentEnd = xml.indexOf("-->", tagStart);
      if (commentEnd === -1) throw new Error("bun junit evidence: unterminated comment");
      index = commentEnd + 3;
      continue;
    }
    const tag = parseTag(xml.slice(tagStart, tagEnd + 1));
    if (!rootSeen) {
      if (!tag.open || tag.selfClosing || tag.name !== "testsuites") {
        throw new Error(`bun junit evidence: expected a <testsuites> root element, got '${tag.name}'`);
      }
      rootSeen = true;
      // The root's own counts are validated for structural integrity but not
      // carried: per-file suites are the evidence consumers gate on.
      attributeNumber(tag.attributes, "tests", "on the root element");
      stack.push("testsuites");
    } else if (tag.close) {
      if (stack[stack.length - 1] !== tag.name) {
        throw new Error(`bun junit evidence: mismatched closing tag '${tag.name}'`);
      }
      stack.pop();
    } else if (tag.open) {
      if (tag.name === "testsuite" && stack[stack.length - 1] === "testsuites") {
        // Only direct children of the root carry per-file evidence: bun nests
        // describe blocks as further testsuite elements whose counts are
        // subsets of their parent file's suite, so counting them would
        // double-count executed and skipped tests.
        const file = tag.attributes.get("file");
        if (file === undefined) {
          throw new Error("bun junit evidence: testsuite element is missing the 'file' attribute");
        }
        suites.push({
          file: decodeXmlEntities(file),
          tests: attributeNumber(tag.attributes, "tests", `for '${decodeXmlEntities(file)}'`),
          failures: attributeNumber(tag.attributes, "failures", `for '${decodeXmlEntities(file)}'`),
          skipped: attributeNumber(tag.attributes, "skipped", `for '${decodeXmlEntities(file)}'`),
        });
      }
      if (!tag.selfClosing) {
        stack.push(tag.name);
      }
    }
    index = tagEnd + 1;
  }
  if (!rootSeen) {
    throw new Error("bun junit evidence: no <testsuites> root element found");
  }
  if (stack.length !== 0) {
    throw new Error(`bun junit evidence: unclosed element '${stack[stack.length - 1]}'`);
  }
  return { suites };
}