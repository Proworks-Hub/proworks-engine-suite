/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import type { Lane } from "../../domain/lanes.js";
import {
  POSTURES,
  evidenceSurvivesEveryLevel,
  isLoosening,
  laneTreatment,
  mayTransition,
  postureMayGrantAccess,
  resolvePosture,
  stricter,
  type CachedPosture,
  type ConditionLevel,
} from "../posture.js";
import {
  QUARANTINE_STATES,
  assessContainment,
  evaluateImmuneSignal,
  forensicPathIntact,
  immuneSignalMayWiden,
  immuneSignalSchema,
  lanePermitted,
  mayRelease,
  type ImmuneSignal,
  type QuarantineState,
} from "../quarantine.js";
import {
  bootstrapStillJustified,
  constitutionalRecoveryPath,
  governanceStateSchema,
  mayRouteUpgrade,
  requiredApprovalsFor,
  sentinelMayRemoveRecoveryPath,
  upgradeRequestSchema,
  type GovernanceState,
  type UpgradeRequest,
} from "../governedUpgrade.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// The rule that inverts the ordinary instinct: an unreachable security system
// makes the Fabric stricter, not more permissive.
// ─────────────────────────────────────────────────────────────────────────────

describe("an unreachable Sentinel tightens the Fabric", () => {
  it("uses the live level when security is reachable", () => {
    const r = resolvePosture("GREEN", null, true, T0);
    expect(r.level).toBe("GREEN");
    expect(r.fromCache).toBe(false);
  });

  it("RAISES the level when security is unreachable, even with a valid cache", () => {
    // The cache is evidence about the past, and an unreachable authority makes
    // the present less certain than the past was.
    const cached: CachedPosture = {
      level: "GREEN",
      assertedAt: T0,
      assertedBy: "sentinel",
      expiresAt: at(300),
    };
    const r = resolvePosture(null, cached, false, at(60));
    expect(r.level).toBe("YELLOW");
    expect(r.fromCache).toBe(true);
    expect(r.reason).toContain("less certain than the past was");
  });

  it("keeps a cached level that is ALREADY stricter", () => {
    const cached: CachedPosture = { level: "RED", assertedAt: T0, assertedBy: "sentinel", expiresAt: at(300) };
    expect(resolvePosture(null, cached, false, at(60)).level).toBe("RED");
  });

  it("falls back to the FAIL-SAFE level when the cache expires, not the last known one", () => {
    // "It was green ten minutes ago" is not evidence about now.
    const cached: CachedPosture = { level: "GREEN", assertedAt: T0, assertedBy: "sentinel", expiresAt: at(300) };
    const r = resolvePosture(null, cached, false, at(301));
    expect(r.level).toBe("ORANGE");
    expect(r.reason).toContain("is not evidence about now");
  });

  it("falls back to fail-safe when nothing is known at all", () => {
    const r = resolvePosture(null, null, false, T0);
    expect(r.level).toBe("ORANGE");
    expect(r.reason).toContain('"nobody has told us there is a problem" is not evidence');
  });

  it("treats the cache expiry as exclusive", () => {
    const cached: CachedPosture = { level: "GREEN", assertedAt: T0, assertedBy: "s", expiresAt: at(300) };
    expect(resolvePosture(null, cached, false, at(299)).fromCache).toBe(true);
    expect(resolvePosture(null, cached, false, at(300)).fromCache).toBe(false);
  });

  it("ignores a live report while security is unreachable", () => {
    // A "live" level from an unreachable authority is a stale one.
    expect(resolvePosture("GREEN", null, false, T0).level).toBe("ORANGE");
  });
});

describe("posture restricts and never grants", () => {
  it("never grants access at any level", () => {
    // An engine whose emergency mode could widen access would be an engine
    // where declaring an emergency is an attack.
    expect(postureMayGrantAccess()).toBe(false);
  });

  it("keeps evidence and health alive at EVERY level, including RED", () => {
    // An incident the operators cannot see is worse than one they cannot stop.
    expect(evidenceSurvivesEveryLevel()).toBe(true);
    expect(laneTreatment("RED", "EVIDENCE")).toBe("NORMAL");
    expect(laneTreatment("RED", "HEALTH")).toBe("NORMAL");
  });

  it("suspends bulk lanes before essential ones", () => {
    expect(laneTreatment("ORANGE", "STREAM")).toBe("SUSPENDED");
    expect(laneTreatment("ORANGE", "COMMAND")).toBe("RESTRICTED");
  });

  it("shortens trust TTLs as the level rises", () => {
    const levels: ConditionLevel[] = ["GREEN", "YELLOW", "ORANGE", "RED"];
    const ttls = levels.map((l) => POSTURES[l].trustTtlSeconds);
    expect(ttls).toEqual([...ttls].sort((a, b) => b - a));
  });

  it("stops cross-instance traffic from ORANGE upward", () => {
    expect(POSTURES.YELLOW.crossInstancePermitted).toBe(true);
    expect(POSTURES.ORANGE.crossInstancePermitted).toBe(false);
    expect(POSTURES.RED.crossInstancePermitted).toBe(false);
  });

  it("makes RECOVERY stricter than YELLOW", () => {
    // A system that has just been compromised has not earned the benefit of
    // the doubt.
    expect(stricter("RECOVERY", "YELLOW")).toBe("RECOVERY");
    expect(isLoosening("RECOVERY", "YELLOW")).toBe(true);
  });
});

describe("tightening is free; relaxing needs authority", () => {
  it("permits tightening with no authorization at all", () => {
    // Requiring approval to become safer is how a system stays unsafe during
    // the minutes that matter.
    const r = mayTransition("GREEN", "RED", null);
    expect(r.permitted).toBe(true);
    expect(r.reason).toContain("costs availability and grants nothing");
  });

  it("REFUSES an unauthorized relax", () => {
    const r = mayTransition("RED", "YELLOW", null);
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("one bad signal away from being an attack");
  });

  it("permits an authorized relax", () => {
    expect(mayTransition("ORANGE", "YELLOW", "dec-1").permitted).toBe(true);
  });

  it("REFUSES RED straight to GREEN even with authority", () => {
    // RECOVERY exists to be passed through.
    const r = mayTransition("RED", "GREEN", "dec-1");
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("RECOVERY exists to be passed through");
  });

  it("treats staying at the same level as not a loosening", () => {
    expect(mayTransition("ORANGE", "ORANGE", null).permitted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("containment is graduated, and the forensic path is never cut", () => {
  it("keeps the forensic path in EVERY state, including FORENSIC", () => {
    // Cutting a compromised workload off entirely destroys the evidence needed
    // to know whether anything else is affected.
    for (const state of Object.keys(QUARANTINE_STATES) as QuarantineState[]) {
      expect(forensicPathIntact(state)).toBe(true);
    }
  });

  it("keeps evidence flowing in every containment state", () => {
    for (const state of Object.keys(QUARANTINE_STATES) as QuarantineState[]) {
      expect(lanePermitted(state, "EVIDENCE")).toBe(true);
    }
  });

  it("narrows what is permitted as containment tightens", () => {
    const counts = (["OBSERVE", "RESTRICT", "ISOLATE", "FORENSIC"] as QuarantineState[]).map(
      (s) => QUARANTINE_STATES[s].lanesPermitted.length,
    );
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("stops a contained workload originating traffic from ISOLATE onward", () => {
    expect(QUARANTINE_STATES.RESTRICT.mayOriginate).toBe(true);
    expect(QUARANTINE_STATES.ISOLATE.mayOriginate).toBe(false);
    expect(QUARANTINE_STATES.RECOVERY.mayOriginate).toBe(false);
  });

  it("blocks commands under RESTRICT while keeping reads", () => {
    expect(lanePermitted("RESTRICT", "COMMAND")).toBe(false);
    expect(lanePermitted("RESTRICT", "QUERY")).toBe(true);
  });
});

describe("what a containment costs besides containing", () => {
  it("says OBSERVE costs nothing, so there is no reason to delay it", () => {
    const e = assessContainment("suspect", "OBSERVE", [{ nodeId: "a", hasAlternative: false }]);
    expect(e.seversUnrelated).toBe(false);
    expect(e.note).toContain("no reason to delay entering it");
  });

  it("reports no collateral when every dependant has an alternative", () => {
    const e = assessContainment("suspect", "ISOLATE", [
      { nodeId: "a", hasAlternative: true },
      { nodeId: "b", hasAlternative: true },
    ]);
    expect(e.seversUnrelated).toBe(false);
    expect(e.note).toContain("This is the containment to reach for");
  });

  it("NAMES who would be stranded, before the decision", () => {
    // Hesitation during an incident is what containment exists to remove, so
    // the cost is stated up front rather than discovered after.
    const e = assessContainment("suspect", "ISOLATE", [
      { nodeId: "z-billing", hasAlternative: false },
      { nodeId: "a-orders", hasAlternative: false },
      { nodeId: "spare", hasAlternative: true },
    ]);
    expect(e.collateral).toEqual(["a-orders", "z-billing"]);
    expect(e.note).toContain("the operator's trade to make");
  });
});

describe("release requires fresh evidence, and recovery cannot be skipped", () => {
  it("REFUSES release straight from FORENSIC", () => {
    // Releasing something nobody has seen work.
    const v = mayRelease({
      from: "FORENSIC",
      freshTrustEvidenceRef: "att-1",
      highRisk: false,
      governanceDecisionRef: null,
    });
    expect(v.released).toBe(false);
    if (!v.released) expect(v.reason).toContain("releasing something nobody has seen work");
  });

  it("REFUSES release straight from ISOLATE", () => {
    expect(
      mayRelease({ from: "ISOLATE", freshTrustEvidenceRef: "att-1", highRisk: false, governanceDecisionRef: null })
        .released,
    ).toBe(false);
  });

  it("REFUSES release with no fresh trust evidence", () => {
    const v = mayRelease({
      from: "RECOVERY",
      freshTrustEvidenceRef: null,
      highRisk: false,
      governanceDecisionRef: null,
    });
    expect(v.released).toBe(false);
    if (!v.released) expect(v.reason).toContain("Trust from before the incident is not evidence about after it");
  });

  it("REFUSES a high-risk release with no governance decision", () => {
    const v = mayRelease({
      from: "RECOVERY",
      freshTrustEvidenceRef: "att-1",
      highRisk: true,
      governanceDecisionRef: null,
    });
    expect(v.released).toBe(false);
    if (!v.released) expect(v.missing).toContain("a governance decision for a high-risk release");
  });

  it("releases from RECOVERY with fresh evidence", () => {
    expect(
      mayRelease({ from: "RECOVERY", freshTrustEvidenceRef: "att-1", highRisk: false, governanceDecisionRef: null })
        .released,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const signal = (over: Record<string, unknown> = {}): ImmuneSignal =>
  immuneSignalSchema.parse({
    signalId: "sig-1",
    threatRef: "threat-9",
    requestedAction: "RESTRICT",
    affectedNodeIds: ["suspect"],
    confidence: 90,
    evidenceRefs: ["ev-1"],
    authorizationRef: null,
    urgency: "PROMPT",
    expiresAt: at(600),
    rollbackCriteria: "Lift when the indicator clears for one hour.",
    correlationId: "cor-1",
    causationId: null,
    ...over,
  });

const policy = { preApprovedActions: ["OBSERVE", "RESTRICT"] as ImmuneSignal["requestedAction"][], minimumConfidence: 70 };

describe("Sentinel requests; the Fabric executes only what policy permits", () => {
  it("acts on an explicitly authorized signal", () => {
    const o = evaluateImmuneSignal(signal({ requestedAction: "ISOLATE", authorizationRef: "dec-1" }), policy, T0);
    expect(o.act).toBe(true);
    if (o.act) expect(o.reason).toContain("Sentinel decided it and Governance permitted it");
  });

  it("acts on a pre-approved restricting action with standing policy", () => {
    const o = evaluateImmuneSignal(signal(), policy, T0);
    expect(o.act).toBe(true);
    if (o.act) expect(o.reason).toContain("hesitating costs a live compromise");
  });

  it("REFUSES an unauthorized action that is not pre-approved", () => {
    // A threat existing does not create authority to act on it.
    const o = evaluateImmuneSignal(signal({ requestedAction: "QUARANTINE_ZONE" }), policy, T0);
    expect(o.act).toBe(false);
    if (!o.act) expect(o.reason).toContain("does not create authority to act on it");
  });

  it("REFUSES a low-confidence signal acting on standing policy alone", () => {
    // A noisy detector becoming a denial of service.
    const o = evaluateImmuneSignal(signal({ confidence: 20 }), policy, T0);
    expect(o.act).toBe(false);
    if (!o.act) expect(o.reason).toContain("noisy detector becomes a denial of service");
  });

  it("still acts on a low-confidence signal that carries authorization", () => {
    expect(evaluateImmuneSignal(signal({ confidence: 5, authorizationRef: "dec-1" }), policy, T0).act).toBe(true);
  });

  it("REFUSES an expired signal", () => {
    const o = evaluateImmuneSignal(signal(), policy, at(601));
    expect(o.act).toBe(false);
    if (!o.act) expect(o.reason).toContain("may already have been resolved");
  });

  it("requires rollback criteria on every signal", () => {
    const { rollbackCriteria, ...without } = signal();
    expect(immuneSignalSchema.safeParse(without).success).toBe(false);
  });

  it("never widens access", () => {
    // "Declare an incident" must not be the shortest route to more access.
    expect(immuneSignalMayWiden()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const bootstrap = (over: Partial<GovernanceState> = {}): GovernanceState =>
  governanceStateSchema.parse({
    stateId: "gov-1",
    phase: "BOOTSTRAP",
    requiredApprovals: 1,
    enrolledOperatorIds: ["founder"],
    exitCriteria: "A second trusted operator is enrolled and verified.",
    enteredAt: T0,
    authorizingDecisionRef: "dec-bootstrap",
    ...over,
  });

const multi = (operators: string[]): GovernanceState =>
  governanceStateSchema.parse({
    stateId: "gov-2",
    phase: "MULTI_OPERATOR",
    requiredApprovals: 2,
    enrolledOperatorIds: operators,
    exitCriteria: null,
    enteredAt: T0,
    authorizingDecisionRef: "dec-multi",
  });

const upgrade = (over: Partial<UpgradeRequest> = {}): UpgradeRequest =>
  upgradeRequestSchema.parse({
    upgradeId: "up-1",
    targetComponent: "neural-fabric-pulse",
    artifactRef: "oci://registry/pulse@sha256:abc",
    artifactSignature: "sig",
    signedBy: "release-key",
    risk: "CRITICAL",
    approvals: ["founder"],
    sandboxEvidenceRef: "sbx-1",
    rollbackPlanRef: "rb-1",
    requestedAt: T0,
    ...over,
  });

describe("bootstrap is a governance state that cannot outlive its reason", () => {
  it("REFUSES a bootstrap phase with no exit criteria", () => {
    // Otherwise it is a permanent exception with a temporary-sounding name.
    expect(
      governanceStateSchema.safeParse({
        stateId: "g",
        phase: "BOOTSTRAP",
        requiredApprovals: 1,
        enrolledOperatorIds: ["a"],
        exitCriteria: null,
        enteredAt: T0,
        authorizingDecisionRef: "d",
      }).success,
    ).toBe(false);
  });

  it("REFUSES a bootstrap phase with more than one operator enrolled", () => {
    expect(
      governanceStateSchema.safeParse({
        stateId: "g",
        phase: "BOOTSTRAP",
        requiredApprovals: 1,
        enrolledOperatorIds: ["a", "b"],
        exitCriteria: "x",
        enteredAt: T0,
        authorizingDecisionRef: "d",
      }).success,
    ).toBe(false);
  });

  it("permits one approval for a critical change while one operator is enrolled", () => {
    const r = requiredApprovalsFor(bootstrap(), "CRITICAL");
    expect(r.required).toBe(1);
    expect(r.reason).toContain("a fact about the population rather than a permission somebody granted");
  });

  it("TIGHTENS automatically once a second operator is enrolled", () => {
    // No setting changes. The threshold is derived from the population, because
    // a configured one is a number somebody has to remember to raise.
    expect(requiredApprovalsFor(multi(["a", "b"]), "CRITICAL").required).toBe(2);
    expect(requiredApprovalsFor(multi(["a", "b", "c", "d", "e"]), "CRITICAL").required).toBe(3);
  });

  it("still needs only one approval for a routine change", () => {
    expect(requiredApprovalsFor(multi(["a", "b", "c"]), "ROUTINE").required).toBe(1);
  });

  it("DETECTS a bootstrap state that has outlived its reason", () => {
    // The schema refuses this shape, so it cannot arrive by parsing. It can
    // arrive from a host that builds the object directly — which the exported
    // type permits — and the check exists for exactly that path. Cast
    // deliberately, because the point is to exercise the defence the schema
    // normally makes unnecessary.
    const stale = {
      stateId: "gov-stale",
      phase: "BOOTSTRAP",
      requiredApprovals: 1,
      enrolledOperatorIds: ["founder", "second"],
      exitCriteria: "A second trusted operator is enrolled and verified.",
      enteredAt: T0,
      authorizingDecisionRef: "dec-bootstrap",
    } as GovernanceState;

    const v = bootstrapStillJustified(stale);
    expect(v.mayRemain).toBe(false);
    if (!v.mayRemain) {
      expect(v.reason).toContain("no longer holds");
      expect(v.requiredAction).toContain("the phase does not get to outlive its reason");
    }
  });

  it("REFUSES to route an upgrade while the governance state is stale", () => {
    const stale = {
      stateId: "gov-stale",
      phase: "BOOTSTRAP",
      requiredApprovals: 1,
      enrolledOperatorIds: ["founder", "second"],
      exitCriteria: "A second trusted operator is enrolled and verified.",
      enteredAt: T0,
      authorizingDecisionRef: "dec-bootstrap",
    } as GovernanceState;

    const v = mayRouteUpgrade(upgrade({ approvals: ["founder", "second"] }), stale, false);
    expect(v.mayProceed).toBe(false);
    if (!v.mayProceed) expect(v.missing.join()).toContain("the governance state is stale");
  });

  it("says bootstrap still describes reality with one operator", () => {
    const v = bootstrapStillJustified(bootstrap());
    expect(v.mayRemain).toBe(true);
    if (v.mayRemain) expect(v.reason).toContain("It ends when:");
  });
});

describe("an upgrade travels as a signed reference and is fully checked", () => {
  it("routes a properly approved critical upgrade", () => {
    expect(mayRouteUpgrade(upgrade(), bootstrap(), false).mayProceed).toBe(true);
  });

  it("REFUSES duplicate approvals counted as two", () => {
    // A threshold satisfiable by one person approving twice is not a threshold.
    const v = mayRouteUpgrade(upgrade({ approvals: ["a", "a"] }), multi(["a", "b"]), false);
    expect(v.mayProceed).toBe(false);
    if (!v.mayProceed) expect(v.missing.join()).toContain("duplicates do not count");
  });

  it("REFUSES an approval from someone not enrolled", () => {
    const v = mayRouteUpgrade(upgrade({ approvals: ["stranger"] }), bootstrap(), false);
    expect(v.mayProceed).toBe(false);
    if (!v.mayProceed) expect(v.missing.join()).toContain("is not an approval");
  });

  it("REFUSES a critical upgrade with no sandbox evidence", () => {
    const v = mayRouteUpgrade(upgrade({ sandboxEvidenceRef: null }), bootstrap(), false);
    expect(v.mayProceed).toBe(false);
    if (!v.mayProceed) expect(v.missing.join()).toContain("evidence rather than authorization");
  });

  it("REFUSES a critical upgrade with no rollback plan", () => {
    const v = mayRouteUpgrade(upgrade({ rollbackPlanRef: null }), bootstrap(), false);
    expect(v.mayProceed).toBe(false);
    if (!v.mayProceed) expect(v.missing.join()).toContain("a decision that cannot be revisited");
  });

  it("reports EVERY unmet requirement in one pass", () => {
    const v = mayRouteUpgrade(
      upgrade({ approvals: [], sandboxEvidenceRef: null, rollbackPlanRef: null }),
      bootstrap(),
      false,
    );
    expect(v.mayProceed).toBe(false);
    if (!v.mayProceed) expect(v.missing.length).toBeGreaterThanOrEqual(3);
  });

  it("REFUSES while Sentinel has paused, and calls it a pause not a veto", () => {
    const v = mayRouteUpgrade(upgrade(), bootstrap(), true);
    expect(v.mayProceed).toBe(false);
    if (!v.mayProceed) expect(v.missing.join()).toContain("a pause and not a veto");
  });

  it("requires the SAME critical upgrade to clear a higher bar after bootstrap exits", () => {
    // §34.9's certification test, directly.
    const request = upgrade({ approvals: ["founder"] });
    expect(mayRouteUpgrade(request, bootstrap(), false).mayProceed).toBe(true);
    expect(mayRouteUpgrade(request, multi(["founder", "second"]), false).mayProceed).toBe(false);
  });
});

describe("the humans always have a way back in", () => {
  it("never lets Sentinel remove the recovery path", () => {
    // A security system that can permanently lock out its owners has become
    // the threat it was built to contain.
    expect(sentinelMayRemoveRecoveryPath()).toBe(false);
  });

  it("always offers a recovery path, with its requirements stated", () => {
    const path = constitutionalRecoveryPath();
    expect(path.available).toBe(true);
    expect(path.requirements.length).toBeGreaterThanOrEqual(4);
    expect(path.note).toContain("has become the threat it was built to contain");
  });

  it("requires the recovery channel to be separate from the compromised one", () => {
    expect(constitutionalRecoveryPath().requirements.join()).toContain("separate from the compromised one");
  });

  it("requires quorum rather than a single senior identity once operators exist", () => {
    expect(constitutionalRecoveryPath().requirements.join()).toContain(
      "quorum approval rather than a single senior identity",
    );
  });
});
