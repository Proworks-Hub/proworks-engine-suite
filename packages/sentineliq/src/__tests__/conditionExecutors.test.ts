// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  AI_CAPABILITY_CLASSES,
  CONDITION_LEVELS,
  EXECUTORS,
  RUNG_CAPABILITY,
  applyPosture,
  dispatchContainment,
  emptyLedger,
  expiredContainments,
  postureFor,
  postureIsMonotone,
  releaseContainment,
  requestDeescalation,
  requestContainment,
  standingContainments,
  type ContainmentAction,
  type ContainmentExecutorPort,
  type ExecutionOutcome,
  type OperationRequest,
} from "../index.js";

const action = (overrides?: Partial<ContainmentAction>): ContainmentAction => {
  const built = requestContainment({
    actionId: "act-1",
    rung: "segment",
    reason: "lateral movement",
    evidenceRefs: ["ev-1"],
    scopeRef: "lane-7",
    ttlSeconds: 3_600,
    executedBy: "fabric",
    charteredAuthorityRef: "charter-1",
    governanceAuthorized: true,
  });
  if (!built.ok) throw new Error(built.reason);
  return { ...built.action, ...overrides };
};

const outcome = (actionId: string, executor: ExecutionOutcome["executor"], expiresAt: string | null = null): ExecutionOutcome => ({
  actionId,
  executor,
  applied: true,
  detail: "applied",
  restorationCriteria: "lift when the incident closes or the TTL lapses",
  expiresAt,
  blastRadiusEstimate: "one lane",
});

const port = (
  executor: ExecutionOutcome["executor"],
  supportedRungs: readonly ContainmentAction["rung"][],
  behaviour?: { applied?: boolean; expiresAt?: string | null; releaseOk?: boolean },
): ContainmentExecutorPort => ({
  executor,
  supportedRungs,
  apply: (a) => ({ ...outcome(a.actionId, executor, behaviour?.expiresAt ?? null), applied: behaviour?.applied ?? true, detail: behaviour?.applied === false ? "executor refused" : "applied" }),
  release: () => ({ released: behaviour?.releaseOk ?? true, detail: behaviour?.releaseOk === false ? "cannot lift" : "lifted" }),
});

describe("§19 condition effects — a posture, not an action", () => {
  it("GATE: every constraint tightens or holds as the level rises — nothing loosens", () => {
    for (let i = 0; i < CONDITION_LEVELS.length; i++) {
      for (let j = i + 1; j < CONDITION_LEVELS.length; j++) {
        const check = postureIsMonotone(CONDITION_LEVELS[i]!, CONDITION_LEVELS[j]!);
        expect(check.monotone, `${CONDITION_LEVELS[i]} -> ${CONDITION_LEVELS[j]}: ${check.violations.join("; ")}`).toBe(true);
      }
    }
  });
  it("deny-by-default is the FLOOR: even GREEN fails closed on unknown", () => {
    expect(postureFor("GREEN").failClosedOnUnknown).toBe(true);
  });
  it("trust TTL shortens monotonically and RECOVERY withholds every AI capability", () => {
    expect(postureFor("GREEN").maxTrustTtlSeconds).toBeGreaterThan(postureFor("YELLOW").maxTrustTtlSeconds);
    expect(postureFor("YELLOW").maxTrustTtlSeconds).toBeGreaterThan(postureFor("ORANGE").maxTrustTtlSeconds);
    expect(postureFor("RECOVERY").withheldAiCapabilities).toHaveLength(AI_CAPABILITY_CLASSES.length);
    expect(postureFor("RECOVERY").recoveryOnly).toBe(true);
    expect(postureFor("RED").productionChangeFrozen).toBe(true);
  });
  it("Sentinel computes the posture and names who applies it — it applies nothing itself", () => {
    const posture = postureFor("ORANGE");
    expect(posture.appliedBy).toEqual(["security-iq", "neural-fabric", "model-runtime"]);
    expect(posture.appliedBy).not.toContain("sentinel");
  });
});

describe("§19 applying a posture — every refusal is named", () => {
  const request = (overrides?: Partial<OperationRequest>): OperationRequest => ({
    actionClass: "read",
    routeClass: "intra-instance",
    stepUpSatisfied: true,
    checksEvaluable: true,
    isRecoveryPurposed: false,
    trustEvidenceAgeSeconds: 10,
    ...overrides,
  });
  it("a clean request under GREEN passes", () => {
    expect(applyPosture(postureFor("GREEN"), request()).permitted).toBe(true);
  });
  it("ORANGE denies cross-instance and collective routes, naming the reason", () => {
    const verdict = applyPosture(postureFor("ORANGE"), request({ routeClass: "cross-instance" }));
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.refusals[0]).toContain("route class cross-instance is denied");
  });
  it("GATE: an unevaluable check fails closed at EVERY level", () => {
    for (const level of CONDITION_LEVELS) {
      const verdict = applyPosture(postureFor(level), request({ checksEvaluable: null, isRecoveryPurposed: true }));
      expect(verdict.permitted, level).toBe(false);
    }
  });
  it("stale trust evidence is refused against the level's ceiling", () => {
    expect(applyPosture(postureFor("GREEN"), request({ trustEvidenceAgeSeconds: 1_000 })).permitted).toBe(true);
    const yellow = applyPosture(postureFor("YELLOW"), request({ trustEvidenceAgeSeconds: 1_000 }));
    expect(yellow.permitted).toBe(false);
    if (!yellow.permitted) expect(yellow.refusals.some((r) => r.includes("exceeds the 900s ceiling"))).toBe(true);
  });
  it("RECOVERY permits recovery-purposed work through the emergency lane and refuses the rest", () => {
    const recovery = applyPosture(
      postureFor("RECOVERY"),
      request({ isRecoveryPurposed: true, routeClass: "emergency", actionClass: "privileged", stepUpSatisfied: true, trustEvidenceAgeSeconds: 10 }),
    );
    expect(recovery.permitted).toBe(true);
    const ordinary = applyPosture(postureFor("RECOVERY"), request({ routeClass: "emergency" }));
    expect(ordinary.permitted).toBe(false);
    if (!ordinary.permitted) expect(ordinary.refusals[0]).toContain("recovery-only");
  });
});

describe("§19 de-escalation — time does not restore trust", () => {
  it("GATE: there is no elapsed-time path back; evidence and Governance are required", () => {
    const denied = requestDeescalation({
      from: "RED",
      to: "GREEN",
      governanceAuthorizationRef: undefined,
      reattestationEvidenceRefs: [],
      openIncidentIds: ["inc-1"],
    });
    expect(denied.permitted).toBe(false);
    if (denied.permitted) return;
    expect(denied.reason).toContain("not elapsed time");
    expect(denied.missing).toContain("Governance authorization");
    expect(denied.missing).toContain("re-attestation evidence");
    expect(denied.missing.some((m) => m.includes("inc-1"))).toBe(true);
  });
  it("with authorization, re-attestation and no open incidents, de-escalation is permitted", () => {
    const ok = requestDeescalation({
      from: "RED",
      to: "YELLOW",
      governanceAuthorizationRef: "gov-1",
      reattestationEvidenceRefs: ["attest-1"],
      openIncidentIds: [],
    });
    expect(ok.permitted).toBe(true);
  });
  it("tightening is not this function's job", () => {
    const wrong = requestDeescalation({
      from: "GREEN",
      to: "RED",
      governanceAuthorizationRef: "gov-1",
      reattestationEvidenceRefs: [],
      openIncidentIds: [],
    });
    expect(wrong.permitted).toBe(false);
  });
});

describe("§23 executors — Sentinel requests, mechanisms execute", () => {
  it("GATE: sentinel is not in the executor vocabulary", () => {
    expect([...EXECUTORS]).toEqual(["security-iq", "fabric", "host-adapter"]);
    expect(EXECUTORS as readonly string[]).not.toContain("sentinel");
  });
  it("dispatch selects a capable, bound executor deterministically", () => {
    const ledger = emptyLedger();
    const { result } = dispatchContainment(action(), [port("fabric", ["segment"])], ledger);
    expect(result.state).toBe("executed");
    if (result.state !== "executed") return;
    expect(result.outcome.executor).toBe("fabric");
    expect(result.outcome.restorationCriteria.length).toBeGreaterThan(0);
  });
  it("GATE: nothing bound means UNEXECUTABLE — the incident learns the containment did not happen", () => {
    const { result } = dispatchContainment(action(), [port("security-iq", ["revoke"])], emptyLedger());
    expect(result.state).toBe("unexecutable");
    if (result.state !== "unexecutable") return;
    expect(result.reason).toContain("did NOT happen");
    expect(result.capableExecutors).toEqual(["fabric"]);
    expect(result.boundExecutors).toEqual(["security-iq"]);
  });
  it("observe has no executor class at all — it is not a mechanism action", () => {
    expect(RUNG_CAPABILITY.observe).toEqual([]);
    const { result } = dispatchContainment(action({ rung: "observe" }), [port("fabric", ["observe"])], emptyLedger());
    expect(result.state).toBe("unexecutable");
    if (result.state === "unexecutable") expect(result.reason).toContain("not a mechanism action");
  });
  it("an executor refusal is reported, not swallowed", () => {
    const { result, ledger } = dispatchContainment(action(), [port("fabric", ["segment"], { applied: false })], emptyLedger());
    expect(result.state).toBe("refused-by-executor");
    expect(standingContainments(ledger)).toHaveLength(0); // nothing recorded as standing
  });
  it("GATE: dispatch is idempotent — a retry returns the first outcome and applies nothing twice", () => {
    let applyCount = 0;
    const counting: ContainmentExecutorPort = {
      executor: "fabric",
      supportedRungs: ["segment"],
      apply: (a) => {
        applyCount += 1;
        return outcome(a.actionId, "fabric");
      },
      release: () => ({ released: true, detail: "lifted" }),
    };
    const first = dispatchContainment(action(), [counting], emptyLedger());
    const second = dispatchContainment(action(), [counting], first.ledger);
    expect(first.result.state).toBe("executed");
    expect(second.result.state).toBe("already-applied");
    expect(applyCount).toBe(1);
  });
  it("standing containments are visible so an operator sees what the Hive is doing to itself", () => {
    const { ledger } = dispatchContainment(action(), [port("fabric", ["segment"])], emptyLedger());
    expect(standingContainments(ledger).map((o) => o.actionId)).toEqual(["act-1"]);
  });
  it("release lifts it; an unbound executor means the containment is STILL IN FORCE and says so", () => {
    const { ledger } = dispatchContainment(action(), [port("fabric", ["segment"])], emptyLedger());
    const orphaned = releaseContainment("act-1", "incident closed", [], ledger);
    expect(orphaned.released).toBe(false);
    expect(orphaned.detail).toContain("STILL IN FORCE");
    const lifted = releaseContainment("act-1", "incident closed", [port("fabric", ["segment"])], ledger);
    expect(lifted.released).toBe(true);
    expect(standingContainments(lifted.ledger)).toHaveLength(0);
  });
  it("an executor that cannot release reports it rather than pretending", () => {
    const stubborn = port("fabric", ["segment"], { releaseOk: false });
    const { ledger } = dispatchContainment(action(), [stubborn], emptyLedger());
    const attempt = releaseContainment("act-1", "done", [stubborn], ledger);
    expect(attempt.released).toBe(false);
    expect(standingContainments(attempt.ledger)).toHaveLength(1); // still standing
  });
  it("expiry is computed against an explicit instant and lapses nothing itself", () => {
    const { ledger } = dispatchContainment(action(), [port("fabric", ["segment"], { expiresAt: "2026-08-30T11:00:00Z" })], emptyLedger());
    expect(expiredContainments(ledger, "2026-08-30T10:00:00Z")).toHaveLength(0);
    const due = expiredContainments(ledger, "2026-08-30T12:00:00Z");
    expect(due).toHaveLength(1);
    // Reporting what SHOULD lapse does not lapse it — releasing is the
    // executor's act.
    expect(standingContainments(ledger)).toHaveLength(1);
  });
});

// ─── guards ─────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("guards — condition effects and executors", () => {
  const dir = join(process.cwd(), "packages", "sentineliq", "src", "v2");
  const files = ["conditionEffects.ts", "executors.ts"].map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  it("no clock reads — instants are supplied", () => {
    for (const f of files) {
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)/.test(f.text), f.name).toBe(false);
    }
  });
  it("no executor implementation ships here — ports only", () => {
    const executors = files.find((f) => f.name === "executors.ts")!;
    expect(/"sentinel"/.test(executors.text)).toBe(false);
    // No network, no process control, no filesystem: this module dispatches.
    expect(/fetch\(|child_process|node:fs/.test(executors.text)).toBe(false);
  });
  it("de-escalation takes no elapsed-time parameter", () => {
    const conditions = files.find((f) => f.name === "conditionEffects.ts")!;
    expect(/elapsedSeconds|sinceSeconds|cooldown/.test(conditions.text)).toBe(false);
  });
});
