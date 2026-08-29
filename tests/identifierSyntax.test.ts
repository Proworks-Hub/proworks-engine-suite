// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { identifierSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The identifier contract, pinned.
//
// Written because I reported a defect here that does not exist: I read the
// character class `._:-` as dot, colon and hyphen and missed the underscore
// sitting between the dot and the colon. The validator has always accepted
// underscores, and the error message has always been accurate.
//
// The tests are worth having anyway, and this is the useful lesson from a
// wrong reading: the rule was legible only by squinting at a five-character
// class, and nothing anywhere asserted what it admitted. A rule nobody has
// written down as examples is a rule that gets re-derived by eye, which is how
// it got misread in the first place.
//
// Every character the message promises appears below as its own case, and so
// does every rule the message does NOT promise — because widening this class
// by accident is the failure that matters, and only the rejections catch it.
// ─────────────────────────────────────────────────────────────────────────────

const accepts = (value: string) => identifierSchema.safeParse(value).success;

describe("what an identifier admits", () => {
  it("accepts underscores, which the message has always promised", () => {
    // The specific claim I got wrong. Stated first so it cannot be lost again.
    expect(accepts("work_order")).toBe(true);
    expect(accepts("a_b")).toBe(true);
    expect(accepts("test_execution_id")).toBe(true);
  });

  it("accepts every other character the message names", () => {
    expect(accepts("abc")).toBe(true);
    expect(accepts("ABC")).toBe(true);
    expect(accepts("a1b2c3")).toBe(true);
    expect(accepts("a.b")).toBe(true);
    expect(accepts("a:b")).toBe(true);
    expect(accepts("a-b")).toBe(true);
    expect(accepts("hive.ksix.us-east")).toBe(true);
    expect(accepts("a.b:c-d_e")).toBe(true);
  });

  it("accepts a single character", () => {
    expect(accepts("a")).toBe(true);
    expect(accepts("0")).toBe(true);
  });
});

describe("what it refuses", () => {
  it("refuses an empty identifier", () => {
    expect(accepts("")).toBe(false);
  });

  it("enforces the first-character restriction", () => {
    // Alphanumeric first. Every punctuation character the class allows
    // elsewhere is checked here, because "starts alphanumeric" is exactly the
    // rule a widened class silently loses.
    for (const bad of ["_x", ".x", ":x", "-x"]) {
      expect(accepts(bad)).toBe(false);
    }
  });

  it("refuses characters outside the class", () => {
    // The rejections are what keep the class from widening unnoticed. Slash
    // and space are the two that would matter most: one makes an identifier
    // look like a path, the other makes it look like two.
    for (const bad of ["a b", "a/b", "a\\b", "a!b", "a@b", "a#b", "a%b", "a+b", "a=b", "a,b", "a;b"]) {
      expect(accepts(bad)).toBe(false);
    }
  });

  it("refuses newlines and tabs, including trailing ones", () => {
    // A trailing newline is the one that survives a config file and a copied
    // shell variable, and `$` alone would admit it in a multiline regex.
    for (const bad of ["a\nb", "a\tb", "a\n", "\na", "a\r\n"]) {
      expect(accepts(bad)).toBe(false);
    }
  });

  it("refuses unicode that merely looks alphanumeric", () => {
    expect(accepts("café")).toBe(false);
    expect(accepts("аbc")).toBe(false); // leading Cyrillic а, not Latin a
  });
});

describe("length", () => {
  it("accepts 128 characters", () => {
    expect(accepts("a".repeat(128))).toBe(true);
  });

  it("refuses 129", () => {
    // The bound is 1 + {0,127}. Asserted on both sides, because an off-by-one
    // here is invisible in review and only shows up on somebody's long id.
    expect(accepts("a".repeat(129))).toBe(false);
  });
});

describe("the message describes the rule it enforces", () => {
  it("names every character class it actually accepts", () => {
    // The check that would have caught a real mismatch, and the one this file
    // exists to institutionalise: assert the documentation against behaviour
    // rather than reading the regex.
    const message = identifierSchema.safeParse("!").error?.issues[0]?.message ?? "";
    for (const [word, sample] of [
      ["letters", "abc"],
      ["digits", "a123"],
      ["dot", "a.b"],
      ["colon", "a:b"],
      ["underscore", "a_b"],
      ["hyphen", "a-b"],
    ] as const) {
      expect(message).toContain(word);
      expect(accepts(sample)).toBe(true);
    }
  });
});
