// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { adviceSchema } from "../advice.js";
import {
  adviceGrantsAuthority,
  ariaParticipatesInAuthorization,
  ariaUnavailabilityBlocksWork,
  createAria,
} from "../aria.js";

// ─────────────────────────────────────────────────────────────────────────────
// ARIA advises and does not authorize.
//
// Most of these tests are about what is ABSENT, which is unusual and correct
// here: the difference between an advisor and an authority is a difference in
// what can be called. A test that only checked ARIA gave good advice would pass
// just as happily on an ARIA that had quietly grown an `authorize`.
// ─────────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-08-29T22:00:00.000Z");
const aria = () => createAria({ now: () => AT });

const ref = (kind: "governance_decision" | "sentinel_finding" | "foundry_promotion", id: string) => ({
  sourceKind: kind,
  locator: id,
  observedAt: AT.toISOString(),
});

describe("ARIA has no authority surface", () => {
  it("exposes nothing that could permit, decide or execute", () => {
    // Absent by design, not omitted for now. An advisory engine becomes
    // load-bearing not by being given authority but by being consulted where
    // authority is decided, one caller at a time.
    const surface = Object.keys(aria()).sort();
    expect(surface).toEqual(["advise", "history", "name"]);
    for (const forbidden of ["authorize", "permit", "allow", "decide", "execute", "approve", "deny"]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it("states the three always-false guarantees", () => {
    expect(adviceGrantsAuthority()).toBe(false);
    // Separate from the above on purpose: "its advice does not authorize" and
    // "it is not asked whether to authorize" are different claims, and only
    // the second stops ARIA becoming a dependency of the authorization path.
    expect(ariaParticipatesInAuthorization()).toBe(false);
    // And the other direction: a Hive that stopped while its advisor was down
    // would have made the advisor required, and a required advisor is an
    // authority.
    expect(ariaUnavailabilityBlocksWork()).toBe(false);
  });

  it("produces advice with no field a caller could execute", () => {
    // No `action`, no `permitted`, no `decision`. Advice that arrives as an
    // executable instruction is an instruction.
    const result = aria().advise({
      question: "should this promotion be reviewed?",
      observations: { foundryPromotions: [ref("foundry_promotion", "chg_1.PRODUCTION")] },
      addressedTo: "human",
    });

    expect(result.advised).toBe(true);
    if (!result.advised) return;
    const keys = Object.keys(result.advice);
    for (const forbidden of ["action", "permitted", "decision", "approved", "execute"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("ARIA abstains rather than filling a silence", () => {
  it("abstains when it observed nothing, and says what it would need", () => {
    // The most important branch in the engine. Producing advice is what ARIA
    // is FOR, which makes it the component most tempted to invent some.
    const result = aria().advise({
      question: "is anything wrong?",
      observations: {},
      addressedTo: "human",
    });

    expect(result.advised).toBe(false);
    if (result.advised) return;
    expect(result.abstention.reason).toContain("Nothing was observed");
    expect(result.abstention.wouldNeed.length).toBeGreaterThan(0);
  });

  it("returns an abstention rather than nothing at all", () => {
    // An advisor that returns nothing is indistinguishable from one that is
    // broken, and the difference matters to whoever is waiting on it.
    const result = aria().advise({ question: "?", observations: {}, addressedTo: "human" });
    expect(result).toBeDefined();
    expect("abstention" in result).toBe(true);
  });

  it("records nothing in its history when it abstains", () => {
    const a = aria();
    a.advise({ question: "?", observations: {}, addressedTo: "human" });
    expect(a.history()).toHaveLength(0);
  });
});

describe("confidence follows the evidence", () => {
  it("is speculative on one observation, and names the gap", () => {
    const result = aria().advise({
      question: "is this a pattern?",
      observations: { sentinelFindings: [ref("sentinel_finding", "find_1")] },
      addressedTo: "sentinel",
    });

    expect(result.advised).toBe(true);
    if (!result.advised) return;
    expect(result.advice.confidence).toBe("speculative");
    expect(result.advice.uncertainty).toContain("not a pattern");
  });

  it("is well-supported on three, and then needs no uncertainty statement", () => {
    const result = aria().advise({
      question: "is this a pattern?",
      observations: {
        sentinelFindings: [ref("sentinel_finding", "find_1"), ref("sentinel_finding", "find_2")],
        governanceDecisions: [ref("governance_decision", "gd_1")],
      },
      addressedTo: "governance",
    });

    expect(result.advised).toBe(true);
    if (!result.advised) return;
    expect(result.advice.confidence).toBe("well-supported");
  });

  it("refuses advice that is unsure and will not say why", () => {
    // The schema, directly. Confidence without a stated gap asks the reader to
    // inherit ARIA's certainty rather than judge it — the same rule SentinelIQ
    // applies to findings.
    const parsed = adviceSchema.safeParse({
      adviceId: "advice_1",
      observation: "something",
      suggestion: "look at it",
      confidence: "suggestive",
      basedOn: [ref("sentinel_finding", "find_1")],
      addressedTo: "human",
      producedAt: AT.toISOString(),
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses advice citing nothing", () => {
    // Advice with no observation behind it is an opinion with a citation
    // field.
    const parsed = adviceSchema.safeParse({
      adviceId: "advice_1",
      observation: "something",
      suggestion: "look at it",
      confidence: "well-supported",
      basedOn: [],
      addressedTo: "human",
      producedAt: AT.toISOString(),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown field rather than dropping it", () => {
    // `.strict()`. A caller adding `permitted: true` gets an error, not advice
    // that quietly carries a permission.
    const parsed = adviceSchema.safeParse({
      adviceId: "advice_1",
      observation: "something",
      suggestion: "look at it",
      confidence: "well-supported",
      basedOn: [ref("sentinel_finding", "find_1")],
      addressedTo: "human",
      producedAt: AT.toISOString(),
      permitted: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ARIA's advice is reviewable as a body", () => {
  it("keeps what it has said", () => {
    // So its advice can be judged over time rather than one answer at a time —
    // an advisor nobody can audit is one nobody can calibrate.
    const a = aria();
    a.advise({
      question: "one",
      observations: { governanceDecisions: [ref("governance_decision", "gd_1")] },
      addressedTo: "human",
    });
    a.advise({
      question: "two",
      observations: { sentinelFindings: [ref("sentinel_finding", "find_1")] },
      addressedTo: "human",
    });

    expect(a.history()).toHaveLength(2);
    expect(a.history()[0]!.adviceId).not.toBe(a.history()[1]!.adviceId);
  });

  it("cites every observation it was given", () => {
    const a = aria();
    const result = a.advise({
      question: "what happened?",
      observations: {
        governanceDecisions: [ref("governance_decision", "gd_1")],
        sentinelFindings: [ref("sentinel_finding", "find_1")],
        foundryPromotions: [ref("foundry_promotion", "chg_1.VALIDATION")],
      },
      addressedTo: "human",
    });

    expect(result.advised).toBe(true);
    if (!result.advised) return;
    expect(result.advice.basedOn).toHaveLength(3);
    expect(result.advice.basedOn.map((o) => o.locator)).toContain("gd_1");
  });
});
