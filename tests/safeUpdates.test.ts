// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  autoPromotionSkipsGates,
  channelPromotionIsDeployment,
  createRolloutController,
  evaluateGate,
  foundryHasProductionDeploymentAuthority,
  pathFor,
  type CohortHealth,
  type HealthGate,
} from "@proworks-hub/foundry-evolutioniq";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 10 — safe autonomous updates and rollback.
//
// The six acceptance tests the directive names:
//
//   1. A maintenance change auto-canaries and auto-promotes when gates pass.
//   2. A major change cannot reach stable without beta verification and human
//      authorization.
//   3. A failing canary halts and rolls back.
//   4. Rollback restores last-known-good and preserves integrity.
//   5. An LTS tenant does not receive beta or stable-only versions.
//   6. Releases and rollbacks are auditable.
//
// THE TWO WALLS. Foundry's environment wall — SIMULATION and VALIDATION — is
// about where Foundry may APPLY a change, and this phase does not touch it. A
// release channel is about how far a VERSION has travelled toward general
// availability. Building the road does not open the gate, and the last group
// asserts both halves of that.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = () => new Date("2026-08-29T12:00:00.000Z");

const gate: HealthGate = {
  gateVersion: "g1",
  maxErrorRate: 0.02,
  maxP95LatencyMs: 300,
  maxQueueGrowthPerMinute: 10,
  minimumObservations: 100,
  observationWindowMs: 600_000,
};

const healthy = (over: Partial<CohortHealth> = {}): CohortHealth => ({
  observations: 5_000,
  errorRate: 0.005,
  p95LatencyMs: 210,
  queueGrowthPerMinute: 1,
  isolationAlerts: 0,
  integrityViolations: 0,
  observedForMs: 900_000,
  ...over,
});

const controller = (over: Record<string, unknown> = {}) =>
  createRolloutController({ now: NOW, ...over });

const begin = (
  c: ReturnType<typeof controller>,
  over: Record<string, unknown> = {},
) =>
  c.begin({
    rolloutId: "roll.1",
    engineId: "forgeiq",
    version: "0.20.0",
    changeClass: "minor",
    previousKnownGoodVersion: "0.19.0",
    gate,
    ...over,
  });

/** Walks a rollout to a named state, supplying whatever each step needs. */
function walkTo(
  c: ReturnType<typeof controller>,
  target: string,
  evidence: Record<string, unknown> = {},
): void {
  for (let i = 0; i < 12; i += 1) {
    if (c.get("roll.1")?.state === target) return;
    const result = c.advance("roll.1", "foundry", { health: healthy(), ...evidence } as never);
    if (!result.advanced) return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SHORT PATH
// ─────────────────────────────────────────────────────────────────────────────

describe("a maintenance change may travel without a signature", () => {
  it("takes the short path when policy allows it", () => {
    // Deliberate: a system where trivial fixes need a signature is one where
    // signatures stop meaning anything, because the person signing has stopped
    // reading.
    expect(pathFor("maintenance", true)).toEqual([
      "DRAFT",
      "SANDBOX",
      "VALIDATED",
      "CANARY",
      "STABLE",
    ]);
  });

  it("takes the long path when policy does not", () => {
    expect(pathFor("maintenance", false)).toContain("AWAITING_HUMAN_AUTHORIZATION");
  });

  it("keeps MINOR on the long path even so", () => {
    // A compatible capability addition is still a behaviour change somebody is
    // about to receive without asking.
    expect(pathFor("minor", true)).toContain("AWAITING_HUMAN_AUTHORIZATION");
  });

  it("reaches STABLE unattended when every gate passes", () => {
    const c = controller({ autoPromoteMaintenance: true });
    begin(c, { changeClass: "maintenance" });
    walkTo(c, "STABLE");
    expect(c.get("roll.1")?.state).toBe("STABLE");
    expect(c.get("roll.1")?.authorizedBy).toBeNull();
  });

  it("does not skip its gates on the way", () => {
    // The short path is shorter, not looser. CANARY is a proving ground rather
    // than a formality.
    const c = controller({ autoPromoteMaintenance: true });
    begin(c, { changeClass: "maintenance" });
    walkTo(c, "CANARY");
    expect(c.get("roll.1")?.state).toBe("CANARY");

    const tooEarly = c.advance("roll.1", "foundry", { health: healthy({ observations: 4 }) });
    expect(tooEarly.advanced).toBe(false);
    expect(autoPromotionSkipsGates()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE LONG PATH
// ─────────────────────────────────────────────────────────────────────────────

describe("a major change stops for a person", () => {
  it("halts at AWAITING_HUMAN_AUTHORIZATION and says so", () => {
    const c = controller();
    begin(c, { changeClass: "major" });
    walkTo(c, "AWAITING_HUMAN_AUTHORIZATION");
    expect(c.get("roll.1")?.state).toBe("AWAITING_HUMAN_AUTHORIZATION");

    const unattended = c.advance("roll.1", "foundry", { health: healthy() });
    expect(unattended.advanced).toBe(false);
    if (unattended.advanced) return;
    expect(unattended.requiresHuman).toBe(true);
  });

  it("advances when a named person and a reference are supplied", () => {
    const c = controller();
    begin(c, { changeClass: "major" });
    walkTo(c, "AWAITING_HUMAN_AUTHORIZATION");

    const result = c.advance("roll.1", "foundry", {
      health: healthy(),
      authorizedBy: "user.steven",
      authorizationRef: "gd.approve.1",
    });
    expect(result.advanced).toBe(true);
    expect(c.get("roll.1")?.state).toBe("STABLE");
    expect(c.get("roll.1")?.authorizedBy).toBe("user.steven");
  });

  it("goes through beta verification on the way", () => {
    const c = controller();
    begin(c, { changeClass: "major" });
    walkTo(c, "BETA_VERIFIED");
    const states = c.get("roll.1")?.history.map((h) => h.state) ?? [];
    expect(states).toContain("BETA");
    expect(states).toContain("BETA_VERIFIED");
  });

  it("refuses STABLE without authorization even if the path were changed", () => {
    // Belt and braces. The path already routes it through the human gate; this
    // refuses the case where somebody changes the path.
    const c = controller({ autoPromoteMaintenance: true });
    // A constitutional change on the short path is not reachable through
    // `pathFor`, so this asserts the guard rather than the routing.
    begin(c, { changeClass: "constitutional" });
    walkTo(c, "AWAITING_HUMAN_AUTHORIZATION");
    expect(c.advance("roll.1", "foundry", { health: healthy() }).advanced).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH GATES
// ─────────────────────────────────────────────────────────────────────────────

describe("a gate has three answers, not two", () => {
  it("holds on too little evidence", () => {
    // Not enough evidence is neither a pass nor a failure, and collapsing it
    // into either makes a rollout stall forever or promote on four requests.
    const verdict = evaluateGate(gate, healthy({ observations: 10 }));
    expect(verdict.verdict).toBe("hold");
  });

  it("holds until the window has elapsed", () => {
    expect(evaluateGate(gate, healthy({ observedForMs: 60_000 })).verdict).toBe("hold");
  });

  it("passes when everything held for the full window", () => {
    expect(evaluateGate(gate, healthy()).verdict).toBe("pass");
  });

  it("fails on any threshold", () => {
    expect(evaluateGate(gate, healthy({ errorRate: 0.2 })).verdict).toBe("fail");
    expect(evaluateGate(gate, healthy({ p95LatencyMs: 900 })).verdict).toBe("fail");
    expect(evaluateGate(gate, healthy({ queueGrowthPerMinute: 500 })).verdict).toBe("fail");
  });

  it("fails on ONE isolation alert regardless of sample size", () => {
    // A cross-tenant alarm is not a statistic to be accumulated. Checked
    // before the sample-size hold, so a single alert on a tiny cohort still
    // fails rather than waiting for more.
    const verdict = evaluateGate(gate, healthy({ observations: 3, isolationAlerts: 1 }));
    expect(verdict.verdict).toBe("fail");
    if (verdict.verdict !== "fail") return;
    expect(verdict.reasons.join(" ")).toMatch(/isolation/);
  });

  it("fails on one integrity violation the same way", () => {
    expect(evaluateGate(gate, healthy({ observations: 2, integrityViolations: 1 })).verdict).toBe(
      "fail",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 4. ROLLBACK
// ─────────────────────────────────────────────────────────────────────────────

describe("rollback is a capability, not an error path", () => {
  it("refuses to begin a rollout with nothing to go back to", () => {
    // Discovering there is no known-good version during an incident is
    // discovering it too late.
    const c = controller();
    const result = c.begin({
      rolloutId: "roll.2",
      engineId: "forgeiq",
      version: "0.20.0",
      changeClass: "minor",
      previousKnownGoodVersion: "",
      gate,
    });
    expect(result.began).toBe(false);
  });

  it("names what a failing gate means", () => {
    const c = controller({ autoPromoteMaintenance: true });
    begin(c, { changeClass: "maintenance" });
    walkTo(c, "CANARY");

    const failed = c.advance("roll.1", "foundry", { health: healthy({ errorRate: 0.5 }) });
    expect(failed.advanced).toBe(false);
    if (failed.advanced) return;
    expect(failed.reason).toMatch(/This is a rollback, not a hold/);
  });

  it("restores the last known good version", () => {
    const c = controller();
    begin(c);
    const result = c.rollback("roll.1", "canary error rate spiked", "prime");
    expect(result.rolledBack).toBe(true);
    expect(result.to).toBe("0.19.0");
    expect(c.get("roll.1")?.state).toBe("ROLLED_BACK");
    expect(c.get("roll.1")?.cohortPercent).toBe(0);
  });

  it("is idempotent, and the second call changes nothing", () => {
    // An incident response that fails on the second attempt is one somebody
    // has to reason about while it is on fire.
    //
    // Asserting only that the second call SUCCEEDS is not enough — a version
    // that re-ran the whole transition would also succeed, while appending a
    // second ROLLED_BACK entry to the history and re-firing the callback. A
    // mutation removing the short-circuit survived exactly that test.
    const rollbacks: string[] = [];
    const c = controller({ onRollback: (_r: unknown, reason: string) => rollbacks.push(reason) });
    begin(c);

    const first = c.rollback("roll.1", "spike", "prime");
    const historyAfterFirst = c.get("roll.1")?.history.length ?? 0;

    const second = c.rollback("roll.1", "spike", "prime");
    expect(first.rolledBack).toBe(true);
    expect(second.rolledBack).toBe(true);
    expect(second.to).toBe("0.19.0");

    expect(c.get("roll.1")?.history).toHaveLength(historyAfterFirst);
    expect(rollbacks).toHaveLength(1);
  });

  it("does not let a rolled-back release keep travelling, and says why", () => {
    // The refusal and its REASON. Without the explicit guard the state simply
    // is not on the path, which also refuses — but tells an operator their
    // state is unrecognised rather than that the release was pulled. A
    // mutation removing the guard survived a test that checked only the
    // boolean.
    const c = controller();
    begin(c);
    c.rollback("roll.1", "spike", "prime");
    const result = c.advance("roll.1", "foundry", { health: healthy() });
    expect(result.advanced).toBe(false);
    if (result.advanced) return;
    expect(result.reason).toMatch(/Correct it and start a new rollout/);
  });

  it("reports the rollback so somebody can act on it", () => {
    const onRollback = vi.fn();
    const c = controller({ onRollback });
    begin(c);
    c.rollback("roll.1", "spike", "prime");
    expect(onRollback).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CHANNELS AND PINNING
// ─────────────────────────────────────────────────────────────────────────────

describe("an instance gets what its channel promised", () => {
  it("does not send a stable release to an LTS instance", () => {
    // The instance chose a slower cadence and must not get the faster one
    // anyway.
    const c = controller();
    begin(c, { changeClass: "maintenance" });
    walkTo(c, "STABLE", { authorizedBy: "user.steven", authorizationRef: "gd.1" });

    const lts = c.eligible({ rolloutId: "roll.1", instanceChannel: "lts" });
    expect(lts.eligible).toBe(false);
    expect(lts.reason).toMatch(/slower cadence/);
    expect(c.eligible({ rolloutId: "roll.1", instanceChannel: "stable" }).eligible).toBe(true);
  });

  it("does not send a beta release to a stable instance", () => {
    const c = controller();
    begin(c);
    walkTo(c, "BETA");
    expect(c.eligible({ rolloutId: "roll.1", instanceChannel: "stable" }).eligible).toBe(false);
    expect(c.eligible({ rolloutId: "roll.1", instanceChannel: "beta" }).eligible).toBe(true);
  });

  it("does not silently upgrade a pinned instance", () => {
    // Pinning is a decision somebody made. A rollout that overrode it would
    // make the pin a suggestion.
    const c = controller();
    begin(c, { changeClass: "maintenance" });
    walkTo(c, "STABLE", { authorizedBy: "user.steven", authorizationRef: "gd.1" });

    const pinned = c.eligible({
      rolloutId: "roll.1",
      instanceChannel: "stable",
      pinnedVersion: "0.19.0",
    });
    expect(pinned.eligible).toBe(false);
    expect(pinned.reason).toMatch(/pinned to 0.19.0/);
  });

  it("offers nothing from a rolled-back release", () => {
    const c = controller();
    begin(c, { changeClass: "maintenance" });
    walkTo(c, "STABLE", { authorizedBy: "user.steven", authorizationRef: "gd.1" });
    c.rollback("roll.1", "regression", "prime");
    expect(c.eligible({ rolloutId: "roll.1", instanceChannel: "stable" }).eligible).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COHORTS, SENTINEL, AND THE AUDIT TRAIL
// ─────────────────────────────────────────────────────────────────────────────

describe("expansion is gated and the whole thing is auditable", () => {
  it("expands only on a passing gate", () => {
    const c = controller();
    begin(c);
    expect(c.expand("roll.1", 25, healthy()).advanced).toBe(true);
    expect(c.get("roll.1")?.cohortPercent).toBe(25);
    expect(c.expand("roll.1", 50, healthy({ errorRate: 0.5 })).advanced).toBe(false);
    expect(c.get("roll.1")?.cohortPercent).toBe(25);
  });

  it("refuses to shrink a cohort through expand", () => {
    const c = controller();
    begin(c);
    c.expand("roll.1", 50, healthy());
    expect(c.expand("roll.1", 10, healthy()).advanced).toBe(false);
  });

  it("honours a Sentinel quarantine on EVERY advance", () => {
    // Checked each time. Checking only at the start would let a release that
    // became suspicious mid-rollout keep travelling.
    let quarantined: string[] = [];
    const c = controller({ quarantined: () => quarantined });
    begin(c);
    expect(c.advance("roll.1", "foundry", { health: healthy() }).advanced).toBe(true);

    quarantined = ["forgeiq"];
    const blocked = c.advance("roll.1", "foundry", { health: healthy() });
    expect(blocked.advanced).toBe(false);
    if (blocked.advanced) return;
    expect(blocked.reason).toMatch(/quarantined/);
  });

  it("keeps every transition with who and why", () => {
    const c = controller();
    begin(c);
    c.advance("roll.1", "foundry", { health: healthy() });
    c.rollback("roll.1", "regression in nesting", "prime");

    const history = c.get("roll.1")?.history ?? [];
    expect(history[0]?.state).toBe("DRAFT");
    expect(history.at(-1)?.state).toBe("ROLLED_BACK");
    expect(history.at(-1)?.by).toBe("prime");
    expect(history.at(-1)?.reason).toMatch(/regression in nesting/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO WALLS
// ─────────────────────────────────────────────────────────────────────────────

describe("building the road did not open the gate", () => {
  it("leaves Foundry's environment wall exactly where it was", () => {
    // A release reaching STABLE is a version marked fit for instances that
    // choose to adopt it. It is not Foundry deploying anything, and Foundry's
    // promotion targets are unchanged.
    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
    expect(channelPromotionIsDeployment()).toBe(false);
  });

  it("installs nothing when a release reaches STABLE", () => {
    const c = controller({ autoPromoteMaintenance: true });
    begin(c, { changeClass: "maintenance" });
    walkTo(c, "STABLE");
    expect(c.get("roll.1")?.state).toBe("STABLE");

    for (const forbidden of ["deploy", "install", "apply", "push"]) {
      expect(Object.keys(c)).not.toContain(forbidden);
    }
  });
});
