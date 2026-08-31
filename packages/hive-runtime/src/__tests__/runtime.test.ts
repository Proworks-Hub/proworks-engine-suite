// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  architectureRuleSchema,
  blocksBuild,
  collaborationContractSchema,
  conformanceFindingSchema,
  deliverySemanticsSchema,
  isExpectedToReport,
  maturityLevelSchema,
  participantRuntimeSchema,
  resolveCapability,
  summarize,
  type ConformanceFinding,
  type ParticipantRuntime,
} from "../index.js";

const RUNTIME: ParticipantRuntime = participantRuntimeSchema.parse({
  identity: {
    stableId: "hive.example",
    instanceId: "instance.test",
    version: "1.0.0",
    environment: "test",
  },
  charter: {
    mission: "Demonstrate the standard.",
    classification: "SPECIALIZED",
    owner: "Architecture",
    owns: ["the demonstration"],
    doesNotOwn: ["anything anyone depends on"],
  },
  maturity: "IMPLEMENTED",
  runtimeState: "READY",
  collaboration: {
    offers: [
      {
        capabilityId: "example.open",
        version: "1.0.0",
        purpose: "Public.",
        requiresAuthorization: false,
        dataClasses: ["PUBLIC"],
        determinism: "DETERMINISTIC",
        sideEffect: "READ_ONLY",
        idempotent: true,
      },
      {
        capabilityId: "example.protected",
        version: "1.0.0",
        purpose: "Protected.",
        requiresAuthorization: true,
        dataClasses: ["CONFIDENTIAL"],
        determinism: "DETERMINISTIC",
        sideEffect: "FINANCIAL_CONSEQUENCE",
        idempotent: true,
      },
    ],
  },
});

describe("governance-first capability resolution (DEC-024)", () => {
  it("refuses a protected capability to an unauthorized caller", () => {
    expect(resolveCapability(RUNTIME, "example.protected", false)).toBeUndefined();
    expect(resolveCapability(RUNTIME, "example.protected", true)?.capabilityId).toBe(
      "example.protected",
    );
  });

  it("makes a protected capability indistinguishable from one that does not exist", () => {
    // The leak this prevents: a caller learning that `example.protected`
    // EXISTS has learned something from a system that refused them. Both
    // answers must be the same answer.
    const refused = resolveCapability(RUNTIME, "example.protected", false);
    const absent = resolveCapability(RUNTIME, "no.such.capability", false);
    expect(refused).toBe(absent);
  });

  it("leaves unprotected capabilities open, so the rule stays about protection", () => {
    expect(resolveCapability(RUNTIME, "example.open", false)?.capabilityId).toBe("example.open");
  });
});

describe("the collaboration contract", () => {
  it("refuses a runtime dependency that does not say what happens without it", () => {
    const result = collaborationContractSchema.safeParse({
      requires: [{ dependencyId: "eventiq", dependencyClass: "DEGRADABLE" }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("whenUnavailable");
  });

  it("exempts development dependencies, which are never present at runtime", () => {
    expect(
      collaborationContractSchema.safeParse({
        requires: [{ dependencyId: "vitest", dependencyClass: "DEVELOPMENT" }],
      }).success,
    ).toBe(true);
  });

  it("requires an authorization decision rather than defaulting one", () => {
    // No default on `requiresAuthorization`: a default of false makes "nobody
    // thought about it" look exactly like "deliberately open".
    const { offers } = RUNTIME.collaboration;
    const withoutDecision = { ...offers[0], requiresAuthorization: undefined };
    expect(collaborationContractSchema.safeParse({ offers: [withoutDecision] }).success).toBe(false);
  });
});

describe("maturity", () => {
  it("expects a report only from INTEGRATED upward", () => {
    // M4 is the first level meaning "proven through a real governed path",
    // which is the first point at which silence is a fault rather than an
    // accurate description of something never started.
    expect(isExpectedToReport("IMPLEMENTED")).toBe(false);
    expect(isExpectedToReport("INTEGRATED")).toBe(true);
    expect(isExpectedToReport("WORLD_CLASS_BENCHMARKED")).toBe(true);
    expect(isExpectedToReport("RESEARCH")).toBe(false);
  });

  it("keeps maturity and runtime state independent", () => {
    // A CERTIFIED engine can be STOPPED and an IMPLEMENTED one can be READY,
    // so neither may be derived from the other.
    expect(
      participantRuntimeSchema.safeParse({ ...RUNTIME, maturity: "CERTIFIED", runtimeState: "STOPPED" })
        .success,
    ).toBe(true);
  });

  it("covers all eight manifesto levels", () => {
    expect(maturityLevelSchema.options).toHaveLength(8);
  });
});

describe("delivery semantics", () => {
  it("offers no EXACTLY_ONCE, because nothing delivers it", () => {
    // The honest form is at-least-once plus an idempotent consumer, which is
    // what EFFECTIVELY_ONCE names. Offering the stronger word would let a
    // participant claim a guarantee no implementation can keep.
    expect(deliverySemanticsSchema.options).not.toContain("EXACTLY_ONCE");
    expect(deliverySemanticsSchema.options).toContain("EFFECTIVELY_ONCE");
  });
});

describe("architecture rules", () => {
  const rule = {
    id: "ARCH-TEST-EXAMPLE",
    source: "TR-001",
    rule: "An example.",
    severity: "ENGINEERING_GATE" as const,
    owner: ["Architecture"],
    verification: ["a test"],
    evidence: ["a report"],
  };

  it("requires a GOVERNED_GATE to name the policy Governance blocks under", () => {
    expect(architectureRuleSchema.safeParse({ ...rule, severity: "GOVERNED_GATE" }).success).toBe(
      false,
    );
    expect(
      architectureRuleSchema.safeParse({
        ...rule,
        severity: "GOVERNED_GATE",
        blockingPolicyId: "policy.architecture.review",
      }).success,
    ).toBe(true);
  });

  it("refuses an id that is not a stable ARCH identifier", () => {
    expect(architectureRuleSchema.safeParse({ ...rule, id: "no-control-center" }).success).toBe(false);
  });
});

describe("conformance findings", () => {
  const base = { ruleId: "ARCH-TEST-EXAMPLE", subjectId: "hive.example", observedAt: "2026-08-31" };

  it("refuses a failure that states no facts", () => {
    // A failure nobody can act on is noise, and noise trains people to skip
    // the report.
    expect(conformanceFindingSchema.safeParse({ ...base, status: "FAIL" }).success).toBe(false);
    expect(
      conformanceFindingSchema.safeParse({ ...base, status: "FAIL", facts: ["imports X"] }).success,
    ).toBe(true);
  });

  it("refuses NOT_APPLICABLE without a reason, which would be UNKNOWN relabelled", () => {
    expect(conformanceFindingSchema.safeParse({ ...base, status: "NOT_APPLICABLE" }).success).toBe(
      false,
    );
  });

  it("allows UNKNOWN with no facts, because not knowing is the finding", () => {
    expect(conformanceFindingSchema.safeParse({ ...base, status: "UNKNOWN" }).success).toBe(true);
  });

  it("counts UNKNOWN separately rather than folding it into a pass rate", () => {
    const findings = ["PASS", "UNKNOWN", "UNKNOWN"].map((status) =>
      conformanceFindingSchema.parse({ ...base, status }),
    );
    expect(summarize(findings)).toMatchObject({ PASS: 1, UNKNOWN: 2, FAIL: 0 });
  });
});

describe("what may block a build", () => {
  const fail = (over: Partial<ConformanceFinding>): ConformanceFinding =>
    conformanceFindingSchema.parse({
      ruleId: "ARCH-X",
      subjectId: "s",
      observedAt: "2026-08-31",
      status: "FAIL",
      facts: ["f"],
      ...over,
    });

  it("blocks only on a deterministic engineering gate", () => {
    expect(blocksBuild([fail({ severity: "ENGINEERING_GATE" })])).toBe(true);
    expect(blocksBuild([fail({ severity: "ADVISORY" })])).toBe(false);
  });

  it("does not let the Architecture Engine enforce a governed gate itself", () => {
    // A GOVERNED_GATE is Governance's call. Blocking on it here would be the
    // Architecture Engine exercising constitutional authority it does not hold.
    expect(blocksBuild([fail({ severity: "GOVERNED_GATE" })])).toBe(false);
  });

  it("does not block on a knowingly waived failure, but still reports it", () => {
    const waived = fail({ severity: "ENGINEERING_GATE", waiverAdrId: "ADR-CC-009" });
    expect(blocksBuild([waived])).toBe(false);
    expect(summarize([waived]).FAIL).toBe(1);
  });
});
