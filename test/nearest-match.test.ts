import { describe, expect, test } from "bun:test";

import { nearestName } from "../cli/nearest-match.js";

describe("nearestName", () => {
  test("returns the unique name within the edit-distance threshold", () => {
    expect(nearestName("statss", ["status", "list", "apply"])).toBe("status");
  });

  test("prefers the smallest edit distance", () => {
    expect(nearestName("stat", ["list", "status", "stax"])).toBe("stax");
  });

  test("breaks distance ties lexicographically", () => {
    expect(nearestName("ban", ["bann", "bana", "bnna"])).toBe("bana");
  });

  test("returns undefined beyond the threshold", () => {
    expect(nearestName("completely-different", ["status", "list"])).toBeUndefined();
  });

  test("returns undefined with no candidates", () => {
    expect(nearestName("status", [])).toBeUndefined();
  });

  test("matches case-sensitively like the command-suggestion precedent", () => {
    expect(nearestName("STATUS", ["status"])).toBeUndefined();
  });
});
