/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  costBasisSchema,
  costComponentSchema,
  costPolicySchema,
  costRateSchema,
  decimalStringSchema,
} from "../costModel.js";
import {
  IMMUTABLE_STATUSES,
  costActualSnapshotSchema,
  costEstimateSchema,
  costScenarioSchema,
  isImmutable,
  reconciliationDiscrepancy,
  statusTransitionAllowed,
} from "../costEstimate.js";
import {
  SOURCE_STRENGTH,
  ageInDays,
  gradeEvidence,
  isFallback,
  provenanceSchema,
  type CostEvidenceQuality,
} from "../provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// The domain model's rules, as opposed to its shapes.
//
// A schema that merely describes fields is documentation. The tests below are
// about the constraints that stop the model expressing something incoherent:
// a quantity with no unit, a priced line with no basis, an approved estimate
// becoming editable, an actual measured against a moving target.
// ─────────────────────────────────────────────────────────────────────────────

const scope = { instanceId: "hive.ksix", tenantId: "ksix" };

const provenance = {
  sourceKind: "OBSERVED_TRANSACTION" as const,
  sourceRef: "receipt:9931",
  sourceSystem: "receiptiq",
  observedAt: "2026-06-01T00:00:00.000Z",
  caveats: [],
  unitConverted: false,
};

const rate = {
  rateId: "rate.steel",
  scope,
  amount: "2.45",
  currency: "GBP",
  perUnit: "kg",
  appliesTo: "MATERIAL" as const,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  provenance,
};

describe("amounts cross the boundary as strings", () => {
  it("accepts decimal strings", () => {
    for (const good of ["0", "12.34", "-5", "+0.001", ".5", "1000000.000001"]) {
      expect(decimalStringSchema.safeParse(good).success).toBe(true);
    }
  });

  it("refuses JSON numbers", () => {
    // A JSON number has already been through a binary float by the time zod
    // sees it. Accepting one would reintroduce exactly the error this engine
    // exists to remove.
    expect(decimalStringSchema.safeParse(12.34).success).toBe(false);
    expect(decimalStringSchema.safeParse(0).success).toBe(false);
  });

  it("refuses text that is not a decimal", () => {
    for (const bad of ["", "abc", "1e5", "1,000", "NaN", "Infinity", "1.2.3"]) {
      expect(decimalStringSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("a component cannot express something incoherent", () => {
  const base = {
    componentId: "c1",
    kind: "MATERIAL" as const,
    label: "Corten sheet",
    quantity: "12.5",
    quantityUnit: "kg",
    basisId: "basis.steel",
    amount: "30.63",
    currency: "GBP",
    included: true,
    notes: [],
  };

  it("accepts a well-formed line", () => {
    expect(costComponentSchema.safeParse(base).success).toBe(true);
  });

  it("refuses a quantity with no unit", () => {
    // A number with no unit is the shape that produces answers a thousand
    // times wrong.
    const { quantityUnit, ...without } = base;
    void quantityUnit;
    const result = costComponentSchema.safeParse(without);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("no meaning");
  });

  it("refuses a priced line with no basis", () => {
    // An unpriced line costed silently at zero makes a total that is
    // confidently too low. Either something priced it, or its kind says so.
    const { basisId, ...without } = base;
    void basisId;
    const result = costComponentSchema.safeParse(without);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("confidently too low");
  });

  it("allows an UNPRICED line to have no basis, because that is the point", () => {
    const { basisId, ...without } = base;
    void basisId;
    expect(costComponentSchema.safeParse({ ...without, kind: "UNPRICED" }).success).toBe(true);
  });

  it("defaults included to true, so a forgotten flag over-counts", () => {
    // Over-counting gets noticed. Under-counting quietly makes a quote too
    // cheap, which is the error that reaches a customer.
    const { included, ...without } = base;
    void included;
    const parsed = costComponentSchema.parse(without);
    expect(parsed.included).toBe(true);
  });

  it("refuses unknown fields", () => {
    expect(costComponentSchema.safeParse({ ...base, marginPercent: "20" }).success).toBe(false);
  });
});

describe("a rate must say what it is per", () => {
  it("accepts a rate with a unit", () => {
    expect(costRateSchema.safeParse(rate).success).toBe(true);
  });

  it("refuses a rate with no unit", () => {
    // "£12" is not a rate. "£12 per kg" is. The unit requirement is what makes
    // the check possible where a rate meets a quantity.
    const { perUnit, ...without } = rate;
    void perUnit;
    expect(costRateSchema.safeParse(without).success).toBe(false);
  });

  it("carries provenance, always", () => {
    const { provenance: p, ...without } = rate;
    void p;
    expect(costRateSchema.safeParse(without).success).toBe(false);
  });
});

describe("a basis remembers what it did not choose", () => {
  it("keeps rejected candidates with reasons", () => {
    // "Why is this number what it is" is usually really "why is it not the
    // other number", and that is only answerable if the alternatives survived.
    const basis = {
      basisId: "basis.steel",
      scope,
      subject: { objectType: "material", objectId: "corten-1.8", ownedBy: "inventoryiq" },
      appliesTo: "MATERIAL" as const,
      selectedRate: rate,
      rejected: [
        {
          rate: { ...rate, rateId: "rate.steel.spot", provenance: { ...provenance, sourceKind: "FORECAST" as const } },
          reason: "Forecast rates are not accepted by this policy.",
        },
      ],
      determinedAt: "2026-08-30T00:00:00.000Z",
      wasFallback: false,
    };
    const parsed = costBasisSchema.parse(basis);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0]!.reason).toContain("not accepted");
  });
});

describe("evidence quality is computed, not asserted", () => {
  const quality = (over: Partial<CostEvidenceQuality> = {}): CostEvidenceQuality => ({
    coverage: 100,
    freshness: 90,
    sourceStrength: 90,
    sampleSufficiency: 90,
    normalization: 90,
    assumptionLoad: 90,
    validatedVariance: 90,
    weakest: [],
    ...over,
  });

  it("grades strong evidence as strong", () => {
    expect(gradeEvidence(quality())).toBe("STRONG");
  });

  it("treats coverage as a floor, not an average", () => {
    // Half a cost being unpriced cannot be offset by the other half having
    // excellent sources. The answer is still missing half the money.
    expect(gradeEvidence(quality({ coverage: 40 }))).toBe("INSUFFICIENT");
    expect(gradeEvidence(quality({ coverage: 70 }))).toBe("ADEQUATE");
    expect(gradeEvidence(quality({ coverage: 70, freshness: 20, sourceStrength: 20 }))).toBe("WEAK");
  });

  it("does not penalise never having validated", () => {
    // Absence is absence. An engine that has never validated should not be
    // scored as though it validated badly — nor rewarded for it.
    const never = gradeEvidence(quality({ validatedVariance: null }));
    const badly = gradeEvidence(quality({ validatedVariance: 0 }));
    expect(never).toBe("STRONG");
    expect(badly).not.toBe("STRONG");
  });

  it("orders source strength so a contract beats a guess", () => {
    expect(SOURCE_STRENGTH.CONTRACT).toBeGreaterThan(SOURCE_STRENGTH.OBSERVED_TRANSACTION);
    expect(SOURCE_STRENGTH.OBSERVED_TRANSACTION).toBeGreaterThan(SOURCE_STRENGTH.SUPPLIER_QUOTE);
    expect(SOURCE_STRENGTH.MANUAL_OVERRIDE).toBeGreaterThan(SOURCE_STRENGTH.FALLBACK_DEFAULT);
    // The cliff: a person's judgement versus nobody's.
    expect(SOURCE_STRENGTH.MANUAL_OVERRIDE - SOURCE_STRENGTH.FALLBACK_DEFAULT).toBeGreaterThan(15);
  });

  it("identifies a fallback for what it is", () => {
    expect(isFallback({ ...provenance, sourceKind: "FALLBACK_DEFAULT" })).toBe(true);
    expect(isFallback(provenance)).toBe(false);
  });
});

describe("age is measured against a supplied instant, never a clock", () => {
  it("floors to whole days", () => {
    // Evidence 23 hours old is zero days old. Rounding up would make freshness
    // jitter across a boundary nothing actually crossed.
    const now = new Date("2026-06-01T23:00:00.000Z");
    expect(ageInDays(provenance, now)).toBe(0);
    expect(ageInDays(provenance, new Date("2026-06-02T00:00:00.000Z"))).toBe(1);
    expect(ageInDays(provenance, new Date("2026-07-01T00:00:00.000Z"))).toBe(30);
  });

  it("refuses evidence with an unusable date rather than assuming it is fresh", () => {
    expect(() => ageInDays({ ...provenance, observedAt: "whenever" }, new Date())).toThrow(/wrong guess/);
  });

  it("takes now as an argument, so replay can supply the original instant", () => {
    // The predictability contract: canonical output must not depend on wall
    // time. Nothing in the domain reads a clock.
    expect(ageInDays.length).toBe(2);
  });
});

describe("an approved estimate is a historical fact", () => {
  it("knows which statuses are frozen", () => {
    expect(isImmutable("DRAFT")).toBe(false);
    for (const s of IMMUTABLE_STATUSES) expect(isImmutable(s)).toBe(true);
  });

  it("REFUSES any path back to DRAFT from approved", () => {
    // The rule the whole engine rests on. A quote said £4,200 to a customer; a
    // variance six months later is meaningless if the baseline moved.
    const verdict = statusTransitionAllowed("APPROVED", "DRAFT");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("rewrites history");
  });

  it("allows a candidate back to draft, because nothing was promised yet", () => {
    expect(statusTransitionAllowed("CANDIDATE", "DRAFT").allowed).toBe(true);
  });

  it("allows approval to be superseded but never edited", () => {
    expect(statusTransitionAllowed("APPROVED", "SUPERSEDED").allowed).toBe(true);
    expect(statusTransitionAllowed("APPROVED", "RETIRED").allowed).toBe(false);
  });

  it("treats superseded and retired as terminal", () => {
    for (const to of ["DRAFT", "CANDIDATE", "APPROVED"] as const) {
      expect(statusTransitionAllowed("SUPERSEDED", to).allowed).toBe(false);
      expect(statusTransitionAllowed("RETIRED", to).allowed).toBe(false);
    }
  });
});

describe("an actual is measured against a pinned version", () => {
  it("requires an estimate version, not just an estimate id", () => {
    // Comparing actuals against "the current estimate" measures drift in the
    // estimate as well as in reality, and reports the sum as performance.
    const snapshot = {
      snapshotId: "snap-1",
      scope,
      subject: { objectType: "work_order", objectId: "wo-1", ownedBy: "workorderiq" },
      againstEstimate: { estimateId: "est-1", version: 3 },
      components: [],
      quantityProduced: "10",
      quantityUnit: "each",
      totalCost: "500.00",
      currency: "GBP",
      completedAt: "2026-08-30T00:00:00.000Z",
      complete: true,
      missingKinds: [],
    };
    expect(costActualSnapshotSchema.safeParse(snapshot).success).toBe(true);

    const withoutVersion = { ...snapshot, againstEstimate: { estimateId: "est-1" } };
    expect(costActualSnapshotSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe("a scenario overlays and never mutates", () => {
  it("names a pinned baseline and its overrides as data", () => {
    // Overrides are data, not functions: an executable override could not be
    // serialised and could not be replayed.
    const scenario = {
      scenarioId: "scn-1",
      scope,
      label: "Alternative supplier",
      baseline: { estimateId: "est-1", version: 2 },
      overrides: [
        { target: "RATE" as const, targetRef: "rate.steel", value: "2.10", rationale: "Quote from supplier B" },
      ],
      createdAt: "2026-08-30T00:00:00.000Z",
    };
    expect(costScenarioSchema.safeParse(scenario).success).toBe(true);
  });

  it("refuses a scenario that changes nothing", () => {
    const scenario = {
      scenarioId: "scn-1",
      scope,
      label: "Nothing",
      baseline: { estimateId: "est-1", version: 2 },
      overrides: [],
      createdAt: "2026-08-30T00:00:00.000Z",
    };
    expect(costScenarioSchema.safeParse(scenario).success).toBe(false);
  });
});

describe("components reconcile with the total", () => {
  const add = (a: string, b: string) => String(Number(a) + Number(b));
  const subtract = (a: string, b: string) => String(Number(a) - Number(b));

  it("reports zero when the parts add up", () => {
    const estimate = {
      totalCost: "30",
      components: [
        { included: true, amount: "10" },
        { included: true, amount: "20" },
      ],
    } as never;
    expect(reconciliationDiscrepancy(estimate, add, subtract)).toBe("0");
  });

  it("excludes memo components from the sum", () => {
    // A comparison figure sitting alongside the real one must not be added.
    const estimate = {
      totalCost: "30",
      components: [
        { included: true, amount: "10" },
        { included: true, amount: "20" },
        { included: false, amount: "999" },
      ],
    } as never;
    expect(reconciliationDiscrepancy(estimate, add, subtract)).toBe("0");
  });

  it("reports the discrepancy rather than a boolean", () => {
    // So the caller can tell a rounding artefact from a fault.
    const estimate = {
      totalCost: "31",
      components: [{ included: true, amount: "10" }, { included: true, amount: "20" }],
    } as never;
    expect(reconciliationDiscrepancy(estimate, add, subtract)).toBe("1");
  });
});

describe("policy travels with the estimate", () => {
  it("records rounding, precision, sources and freshness", () => {
    // Two estimates that differ only by rounding stage are genuinely
    // different, and one that did not record its policy cannot be reproduced.
    const policy = {
      policyId: "pol.default",
      policyVersion: "1.0.0",
      currency: "GBP",
      roundingMode: "HALF_EVEN" as const,
      roundingStage: "TOTAL" as const,
      roundingScale: null,
      calculationScale: 8,
      acceptedSources: ["CONTRACT", "OBSERVED_TRANSACTION"],
      allowFallback: false,
      freshnessWindowDays: 90,
      minimumSampleSize: 3,
    };
    expect(costPolicySchema.safeParse(policy).success).toBe(true);
  });
});

describe("provenance round-trips", () => {
  it("survives serialisation without loss", () => {
    const parsed = provenanceSchema.parse(provenance);
    expect(provenanceSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("refuses unknown fields", () => {
    expect(provenanceSchema.safeParse({ ...provenance, confidence: 0.9 }).success).toBe(false);
  });
});

describe("an estimate is self-contained", () => {
  it("carries its own policy, method version and fingerprint", () => {
    // Reproducing it must need nothing that could have changed since.
    const estimate = {
      estimateId: "est-1",
      version: 1,
      scope,
      subject: { objectType: "product", objectId: "firepit-24", ownedBy: "forgeiq" },
      status: "APPROVED" as const,
      method: { methodId: "DIRECT_JOB", methodVersion: "1.0.0" },
      policy: {
        policyId: "pol.default",
        policyVersion: "1.0.0",
        currency: "GBP",
        roundingMode: "HALF_EVEN" as const,
        roundingStage: "TOTAL" as const,
        roundingScale: null,
        calculationScale: 8,
        acceptedSources: ["CONTRACT"],
        allowFallback: false,
        freshnessWindowDays: 90,
        minimumSampleSize: 3,
      },
      components: [],
      quantity: "1",
      quantityUnit: "each",
      totalCost: "0",
      unitCost: "0",
      currency: "GBP",
      unpricedAmount: "0",
      assumptions: [],
      evidenceQuality: {
        coverage: 100,
        freshness: 100,
        sourceStrength: 100,
        sampleSufficiency: 100,
        normalization: 100,
        assumptionLoad: 100,
        validatedVariance: null,
        weakest: [],
      },
      fingerprint: "sha256:abc",
      computedAt: "2026-08-30T00:00:00.000Z",
    };
    expect(costEstimateSchema.safeParse(estimate).success).toBe(true);
  });

  it("requires a method VERSION, not just an id", () => {
    // Without it an old estimate cannot be replayed, because the code that
    // made it no longer exists in reproducible form.
    const bad = { methodId: "DIRECT_JOB" };
    expect(costEstimateSchema.safeParse({ method: bad }).success).toBe(false);
  });
});
