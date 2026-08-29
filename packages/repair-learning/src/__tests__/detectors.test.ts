// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BASELINE_DETECTORS,
  EXTENDED_DETECTORS,
  UNDETECTABLE_INVARIANTS,
  createInvariantClassifier,
  type Evidence,
  type InvariantCatalogEntry,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Extended invariant detection: 5 of 26 → 21 of 26, with the remaining 5 named.
// ─────────────────────────────────────────────────────────────────────────────

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../corpus/invariant-catalog.v2.json", import.meta.url)), "utf8"),
) as InvariantCatalogEntry[];

const all = [...BASELINE_DETECTORS, ...EXTENDED_DETECTORS];
const classifier = createInvariantClassifier({ catalog, detectors: all });

const ev = (over: Partial<Evidence> & { evidenceId: string }): Evidence =>
  ({
    kind: "log",
    locator: `test://${over.evidenceId}`,
    componentId: "hive.specialized.workorderiq",
    observedAt: "2026-08-29T10:00:00.000Z",
    sensitivity: "internal",
    summary: "e",
    facts: {},
    ...over,
  }) as Evidence;

const verdictOf = (invariantId: string, evidence: readonly Evidence[]) =>
  classifier.assess([invariantId], evidence)[0]!;

describe("coverage is accounted for, not merely large", () => {
  it("covers 21 of the catalog's 26 invariants", () => {
    const covered = new Set(all.map((d) => d.invariantId));
    expect(covered.size).toBe(21);
    expect(catalog).toHaveLength(26);
  });

  it("names every invariant it cannot detect, with a reason", () => {
    // A catalog where 21 are checked and 5 are openly unchecked is honest; one
    // where all 26 report HELD because nobody looked is not.
    const covered = new Set(all.map((d) => d.invariantId));
    const undetectable = new Set(Object.keys(UNDETECTABLE_INVARIANTS));
    const catalogIds = new Set(catalog.map((c) => c.id));

    const unaccounted = [...catalogIds].filter((id) => !covered.has(id) && !undetectable.has(id));
    expect(unaccounted).toEqual([]);
    expect(Object.values(UNDETECTABLE_INVARIANTS).every((r) => r.length > 30)).toBe(true);
  });

  it("does not claim to detect what it declared undetectable", () => {
    const covered = new Set(all.map((d) => d.invariantId));
    for (const id of Object.keys(UNDETECTABLE_INVARIANTS)) {
      expect(covered.has(id), id).toBe(false);
    }
  });

  it("still reports NOT_ASSESSED for the five it cannot decide", () => {
    for (const id of Object.keys(UNDETECTABLE_INVARIANTS)) {
      expect(verdictOf(id, [ev({ evidenceId: "e1" })]).verdict, id).toBe("NOT_ASSESSED");
    }
  });
});

describe("every detector returns null rather than HELD when its fact is absent", () => {
  it("assesses nothing from empty evidence", () => {
    // The rule that makes the whole classifier trustworthy. A detector
    // reporting HELD when it found nothing converts absence of evidence into
    // evidence of compliance.
    for (const detector of all) {
      expect(detector.detect([]), detector.name).toBeNull();
    }
  });

  it("assesses nothing from evidence carrying no relevant facts", () => {
    const irrelevant = [ev({ evidenceId: "e1", facts: { somethingElse: 42 } })];
    for (const detector of all) {
      expect(detector.detect(irrelevant), detector.name).toBeNull();
    }
  });
});

describe("governance order is distinct from governance existence", () => {
  it("finds an action that preceded the decision", () => {
    // AUTHORITY-001 asks whether a decision existed. This asks whether it came
    // first. A system that authorizes after acting has an audit trail and no
    // gate.
    const verdict = verdictOf("HIVE-INV-GOVERNANCE-ORDER-001", [
      ev({ evidenceId: "e_act", observedAt: "2026-08-29T10:00:00.000Z", facts: { consequential: true } }),
      ev({
        evidenceId: "e_gov",
        kind: "governance_decision",
        observedAt: "2026-08-29T10:00:05.000Z",
        facts: { permitted: true },
      }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("audit trail and no gate");
  });

  it("accepts a decision that came first", () => {
    expect(
      verdictOf("HIVE-INV-GOVERNANCE-ORDER-001", [
        ev({
          evidenceId: "e_gov",
          kind: "governance_decision",
          observedAt: "2026-08-29T10:00:00.000Z",
          facts: { permitted: true },
        }),
        ev({ evidenceId: "e_act", observedAt: "2026-08-29T10:00:05.000Z", facts: { consequential: true } }),
      ]).verdict,
    ).toBe("HELD");
  });
});

describe("ownership, duplication and version agreement", () => {
  it("finds a component writing another's entity", () => {
    const verdict = verdictOf("HIVE-INV-OWNERSHIP-001", [
      ev({
        evidenceId: "e1",
        componentId: "hive.constitutional.prime",
        facts: { persistedEntity: "work_order", entityOwner: "hive.specialized.workorderiq" },
      }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("which hive.specialized.workorderiq owns");
  });

  it("accepts the owner writing its own entity", () => {
    expect(
      verdictOf("HIVE-INV-OWNERSHIP-001", [
        ev({
          evidenceId: "e1",
          componentId: "hive.specialized.workorderiq",
          facts: { persistedEntity: "work_order", entityOwner: "hive.specialized.workorderiq" },
        }),
      ]).verdict,
    ).toBe("HELD");
  });

  it("finds one source producing two entities", () => {
    const verdict = verdictOf("HIVE-INV-NO-DUPLICATION-001", [
      ev({ evidenceId: "e1", facts: { createdFromSourceKey: "order-388" } }),
      ev({ evidenceId: "e2", facts: { createdFromSourceKey: "order-388" } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("produced 2 entities");
  });

  it("finds producer and consumer on different contract versions", () => {
    const verdict = verdictOf("HIVE-INV-VERSION-LINEAGE-001", [
      ev({ evidenceId: "e1", facts: { contractName: "workorder.intake", contractVersion: "1.2" } }),
      ev({ evidenceId: "e2", facts: { contractName: "workorder.intake", contractVersion: "2.0" } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("versions 1.2 and 2.0");
  });

  it("needs two sides before it judges version agreement", () => {
    expect(
      verdictOf("HIVE-INV-VERSION-LINEAGE-001", [
        ev({ evidenceId: "e1", facts: { contractName: "workorder.intake", contractVersion: "1.2" } }),
      ]).verdict,
    ).toBe("NOT_ASSESSED");
  });
});

describe("provenance and data minimization", () => {
  it("finds a derived value with no stated source", () => {
    const verdict = verdictOf("HIVE-INV-PROVENANCE-001", [
      ev({ evidenceId: "e1", facts: { isDerived: true } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("will eventually be treated as authoritative");
  });

  it("accepts a derived value naming its source", () => {
    expect(
      verdictOf("HIVE-INV-PROVENANCE-001", [
        ev({ evidenceId: "e1", facts: { isDerived: true, derivedFrom: "costiq.quote.v2" } }),
      ]).verdict,
    ).toBe("HELD");
  });

  it("finds protected evidence carrying extracted facts", () => {
    // The evidence schema already refuses this at capture. This detector
    // catches it if it arrives by another route, because a boundary enforced in
    // exactly one place is a boundary until somebody adds a second writer.
    const verdict = verdictOf("HIVE-INV-DATA-MINIMIZATION-001", [
      ev({ evidenceId: "e1", sensitivity: "restricted", facts: { ssnLastFour: "0000" } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
  });

  it("accepts protected evidence carrying only a reference", () => {
    expect(
      verdictOf("HIVE-INV-DATA-MINIMIZATION-001", [
        ev({ evidenceId: "e1", sensitivity: "restricted", facts: {} }),
      ]).verdict,
    ).toBe("HELD");
  });
});

describe("financial, inventory and resource arithmetic", () => {
  it("finds a monetary figure that changed across a hop", () => {
    // Compared to the cent. A tolerance here is how a rounding difference
    // becomes a reconciliation problem nobody can find.
    const verdict = verdictOf("HIVE-INV-FINANCIAL-INTEGRITY-001", [
      ev({ evidenceId: "e1", componentId: "hive.specialized.costiq", facts: { monetaryLabel: "unitCost", amountMinor: 4250 } }),
      ev({ evidenceId: "e2", componentId: "hive.specialized.workorderiq", facts: { monetaryLabel: "unitCost", amountMinor: 4249 } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("4249 and 4250");
  });

  it("finds stock that does not conserve", () => {
    // The classic failure: a reservation that decrements on-hand as well.
    // Caught as arithmetic rather than as a story about intent.
    const verdict = verdictOf("HIVE-INV-INVENTORY-001", [
      ev({ evidenceId: "e1", facts: { onHand: 100, available: 90, reserved: 4 } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("on-hand 100 != available 90 + reserved 4");
  });

  it("accepts conserved stock", () => {
    expect(
      verdictOf("HIVE-INV-INVENTORY-001", [
        ev({ evidenceId: "e1", facts: { onHand: 100, available: 90, reserved: 10 } }),
      ]).verdict,
    ).toBe("HELD");
  });

  it("finds a double-booked resource", () => {
    const verdict = verdictOf("HIVE-INV-RESOURCE-INTEGRITY-001", [
      ev({ evidenceId: "e1", facts: { resourceId: "laser-1", reservedForWindow: "2026-08-30T09:00/10:00" } }),
      ev({ evidenceId: "e2", facts: { resourceId: "laser-1", reservedForWindow: "2026-08-30T09:00/10:00" } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("reserved 2 times");
  });
});

describe("degradation, isolation and recovery", () => {
  it("finds a degraded component answering confidently", () => {
    // Silent degradation is worse than an outage, because nobody responds to it.
    const verdict = verdictOf("HIVE-INV-DEGRADED-001", [
      ev({ evidenceId: "e1", facts: { operatingDegraded: true } }),
      ev({ evidenceId: "e2", facts: { answeredSuccessfully: true } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("Silent degradation is worse than an outage");
  });

  it("accepts a degraded answer that says it is degraded", () => {
    expect(
      verdictOf("HIVE-INV-DEGRADED-001", [
        ev({ evidenceId: "e1", facts: { operatingDegraded: true } }),
        ev({ evidenceId: "e2", facts: { answeredSuccessfully: true, resultMarkedDegraded: true } }),
      ]).verdict,
    ).toBe("HELD");
  });

  it("reports an uncontained cascade as probable, not confirmed", () => {
    // A missing boundary declaration and a genuine cascade look the same from
    // here, and the confidence says so rather than overclaiming.
    const verdict = verdictOf("HIVE-INV-FAILURE-ISOLATION-001", [
      ev({ evidenceId: "e1", facts: { componentFailed: true, failedBecauseUpstreamFailed: true } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.confidence).toBe("probable");
  });

  it("finds a partial write that was neither compensated nor marked", () => {
    // A half-finished workflow that looks finished is the hardest kind of
    // failure to find later.
    const verdict = verdictOf("HIVE-INV-RECOVERY-001", [
      ev({ evidenceId: "e1", facts: { partialWriteOccurred: true } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
  });

  it("accepts a partial write that was compensated", () => {
    expect(
      verdictOf("HIVE-INV-RECOVERY-001", [
        ev({ evidenceId: "e1", facts: { partialWriteOccurred: true, compensated: true } }),
      ]).verdict,
    ).toBe("HELD");
  });

  it("accepts a partial write that was honestly marked incomplete", () => {
    expect(
      verdictOf("HIVE-INV-RECOVERY-001", [
        ev({ evidenceId: "e1", facts: { partialWriteOccurred: true, markedIncomplete: true } }),
      ]).verdict,
    ).toBe("HELD");
  });
});

describe("replay, identity and validation", () => {
  it("finds an unguarded replay", () => {
    // A recovery that causes a second incident is not a recovery.
    const verdict = verdictOf("HIVE-INV-NO-BLIND-REPLAY-001", [
      ev({ evidenceId: "e1", facts: { isReplay: true } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("is not a recovery");
  });

  it("accepts a replay into an idempotent consumer", () => {
    expect(
      verdictOf("HIVE-INV-NO-BLIND-REPLAY-001", [
        ev({ evidenceId: "e1", facts: { isReplay: true, consumerIsIdempotent: true } }),
      ]).verdict,
    ).toBe("HELD");
  });

  it("accepts an explicitly authorized replay", () => {
    expect(
      verdictOf("HIVE-INV-NO-BLIND-REPLAY-001", [
        ev({ evidenceId: "e1", facts: { isReplay: true, replayAuthorizedBy: "gd-9912" } }),
      ]).verdict,
    ).toBe("HELD");
  });

  it("finds a consequential action with no named actor", () => {
    // Distinct from AUTHORITY: this asks WHO, not WHETHER. An authorized action
    // by an unnamed actor is unattributable afterwards.
    const verdict = verdictOf("HIVE-INV-TRUSTED-IDENTITY-001", [
      ev({ evidenceId: "e1", facts: { consequential: true } }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("unattributable afterwards");
  });

  it("finds an action on unvalidated input", () => {
    expect(
      verdictOf("HIVE-INV-VALIDATION-001", [
        ev({ evidenceId: "e1", facts: { consequential: true, inputValidated: false } }),
      ]).verdict,
    ).toBe("VIOLATED");
  });

  it("finds an undeclared lifecycle transition", () => {
    const verdict = verdictOf("HIVE-INV-LIFECYCLE-001", [
      ev({
        evidenceId: "e1",
        facts: { transitionFrom: "draft", transitionTo: "shipped", transitionDeclared: false },
      }),
    ]);
    expect(verdict.verdict).toBe("VIOLATED");
    expect(verdict.detail).toContain("draft -> shipped is not a declared edge");
  });
});

describe("a realistic run assesses most of the catalog", () => {
  it("leaves far fewer invariants unassessed than the baseline set did", () => {
    // The point of the whole exercise. A run with rich evidence should be able
    // to reach a conclusion rather than deferring almost everything to a human.
    const evidence: Evidence[] = [
      ev({
        evidenceId: "e_gov",
        kind: "governance_decision",
        observedAt: "2026-08-29T10:00:00.000Z",
        facts: { permitted: true, correlationId: "cor_1", tenantId: "ksix" },
      }),
      ev({
        evidenceId: "e_act",
        observedAt: "2026-08-29T10:00:02.000Z",
        facts: {
          consequential: true,
          actorId: "steven",
          inputValidated: true,
          correlationId: "cor_1",
          tenantId: "ksix",
          persistedEntity: "work_order",
          entityOwner: "hive.specialized.workorderiq",
          createdFromSourceKey: "order-388",
          contractName: "workorder.intake",
          contractVersion: "1.2",
          isDerived: true,
          derivedFrom: "forgeiq.plan.v1",
          monetaryLabel: "unitCost",
          amountMinor: 4250,
          onHand: 100,
          available: 90,
          reserved: 10,
          transitionFrom: "draft",
          transitionTo: "planned",
          transitionDeclared: true,
          duplicateDelivered: true,
          duplicateSuppressed: true,
          operatingDegraded: false,
          answeredSuccessfully: true,
          componentFailed: false,
          partialWriteOccurred: false,
          isReplay: false,
          resourceId: "laser-1",
          reservedForWindow: "2026-08-30T09:00/10:00",
        },
      }),
      ev({
        evidenceId: "e_peer",
        componentId: "hive.specialized.costiq",
        observedAt: "2026-08-29T10:00:03.000Z",
        facts: {
          correlationId: "cor_1",
          tenantId: "ksix",
          contractName: "workorder.intake",
          contractVersion: "1.2",
          monetaryLabel: "unitCost",
          amountMinor: 4250,
        },
      }),
    ];

    const catalogIds = catalog.map((c) => c.id);
    const rich = classifier.assess(catalogIds, evidence);
    const unassessed = rich.filter((a) => a.verdict === "NOT_ASSESSED");

    const baselineOnly = createInvariantClassifier({ catalog, detectors: BASELINE_DETECTORS });
    const sparse = baselineOnly
      .assess(catalogIds, evidence)
      .filter((a) => a.verdict === "NOT_ASSESSED");

    expect(unassessed.length).toBeLessThan(sparse.length);
    // The five declared-undetectable plus anything whose facts this fixture
    // happens not to trigger.
    expect(unassessed.length).toBeLessThanOrEqual(9);
    expect(rich.filter((a) => a.verdict === "VIOLATED")).toEqual([]);
  });
});
