// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { acceptsConsequentialWork } from "@proworks-hub/contracts";
import type { AuthorityEnvelope, Governance, GovernanceDecision } from "@proworks-hub/contracts";
import {
  classifyChange,
  createEvolutionControl,
  foundryHasProductionDeploymentAuthority,
} from "@proworks-hub/foundry-evolutioniq";
import { createSentinelIq } from "@proworks-hub/sentineliq";
import { repairCandidateSchema } from "@proworks-hub/repair-learning";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel observes what Governance decided and what Foundry promoted.
//
// This could not be built before the previous commit, and the reason is worth
// keeping: there was no decision stream to watch. Governance was never asked,
// so it never decided; Foundry recorded promotions nobody read. Feeding
// Sentinel then would have meant inventing its inputs, which is how an
// observer ends up watching a fixture.
//
// WHAT SENTINEL IS FOR HERE
//
// Not to re-decide. Governance decides and Foundry promotes; Sentinel records
// that they did, and raises a finding when the SHAPE of what happened is wrong
// — a denial nobody can trace, a promotion that skipped validation. §17: an
// independent observer, which means it must be able to see things the acting
// engines would not report about themselves.
//
// WHY THE OBSERVERS ARE HERE AND NOT IN THE ENGINES
//
// Same reason as the Sentinel binding: Governance, Foundry and Sentinel are
// platform-tier peers, and peers communicate through events, not imports. A
// host wraps and observes. Neither engine changed.
// ─────────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-08-29T21:00:00.000Z");
const TENANT = { organizationId: "ksix", roles: [] as string[] };

const evidence = (locator: string) => [
  { sourceKind: "audit_record" as const, locator, observedAt: AT.toISOString() },
];

/**
 * Wraps Governance so Sentinel sees every decision.
 *
 * A decorator, not a replacement. It cannot change the decision — it returns
 * exactly what Governance returned — which is the property that makes it safe
 * to put an observer on the authorization path at all.
 */
function observedGovernance(
  inner: Governance,
  sentinel: ReturnType<typeof createSentinelIq>,
): Governance {
  let n = 0;
  return {
    async authorize(envelope: AuthorityEnvelope): Promise<GovernanceDecision> {
      const decision = await inner.authorize(envelope);
      n += 1;

      // A DENIED decision with no decisionId cannot be reviewed or appealed,
      // and cannot be told apart from a fault. AuditIQ refuses to record one;
      // Sentinel raises a finding when Governance produces one.
      if (decision.decision === "DENIED" && !decision.decisionId) {
        sentinel.observe({
          findingId: `find_untraceable_denial_${n}`,
          kind: "audit_integrity",
          severity: "moderate",
          confidence: "confirmed",
          subject: { kind: "engine", id: "hive.constitutional.governance", tenant: TENANT },
          summary: `A denial of "${envelope.requestedAction}" carries no decisionId, so it cannot be reviewed or appealed.`,
          evidence: evidence(`governance.${envelope.requestId}`),
          observedAt: AT.toISOString(),
        });
      }

      return decision;
    },
  };
}

const candidate = repairCandidateSchema.parse({
  repairCandidateId: "rc_ow_1",
  diagnosisId: "OW-1",
  repairClass: "CODE_DEFECT",
  description: "A bounded correction.",
  targetComponents: ["hive.platform.eventiq"],
  affectedResources: ["eventiq/src/eventiq.ts"],
  proposedActions: [
    { verb: "modify", target: "code", subject: "a guard", rationale: "it was wrong" },
  ],
  expectedEffect: "The guard is correct.",
  risk: "LOW",
  blastRadius: "ENGINE",
  reversibility: "REVERSIBLE",
  requiredAuthority: ["human.constitutional.authority"],
  requiredValidators: ["forbidden-shortcut"],
  rollbackPlan: "Revert.",
  forbiddenShortcutsChecked: true,
  authoredBy: "human.steven",
  authoredAt: "2026-08-29T21:00:00.000Z",
});

const classification = classifyChange({
  candidate,
  filesChanged: 1,
  componentsTouched: 1,
  contractsTouched: 0,
  testsRemoved: 0,
  dependenciesTouched: 0,
});

describe("Sentinel observes Governance", () => {
  it("raises a finding on a denial nobody can trace", async () => {
    const sentinel = createSentinelIq({ now: () => AT });
    const governance = observedGovernance(
      {
        authorize: async () => ({
          decision: "DENIED" as const,
          reason: "no",
          conditions: [],
          decidedAt: AT.toISOString(),
        }),
      },
      sentinel,
    );

    await governance.authorize({
      requestId: "req_1",
      actorId: "foundry",
      tenant: TENANT,
      purpose: "Open a mission.",
      requestedAction: "correct",
      delegationChain: [],
      riskClass: "routine",
      issuedAt: AT.toISOString(),
    });

    const findings = sentinel.find({ subjectId: "hive.constitutional.governance" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.finding.summary).toContain("cannot be reviewed");
  });

  it("stays quiet when the denial is traceable", async () => {
    // The control. Without it, "raises a finding on a denial" is equally
    // consistent with an observer that raises a finding on everything.
    const sentinel = createSentinelIq({ now: () => AT });
    const governance = observedGovernance(
      {
        authorize: async () => ({
          decision: "DENIED" as const,
          reason: "no",
          conditions: [],
          decisionId: "gd-traceable",
          decidedAt: AT.toISOString(),
        }),
      },
      sentinel,
    );

    await governance.authorize({
      requestId: "req_2",
      actorId: "foundry",
      tenant: TENANT,
      purpose: "Open a mission.",
      requestedAction: "correct",
      delegationChain: [],
      riskClass: "routine",
      issuedAt: AT.toISOString(),
    });

    expect(sentinel.count()).toBe(0);
  });

  it("returns the decision unchanged, because an observer does not decide", async () => {
    // The property that makes it safe to put Sentinel on the authorization
    // path: it can see everything and change nothing.
    const sentinel = createSentinelIq({ now: () => AT });
    const original: GovernanceDecision = {
      decision: "PERMITTED",
      reason: "within scope",
      conditions: [],
      decisionId: "gd-1",
      decidedAt: AT.toISOString(),
    };
    const governance = observedGovernance({ authorize: async () => original }, sentinel);

    const seen = await governance.authorize({
      requestId: "req_3",
      actorId: "foundry",
      tenant: TENANT,
      purpose: "Open a mission.",
      requestedAction: "correct",
      delegationChain: [],
      riskClass: "routine",
      issuedAt: AT.toISOString(),
    });

    expect(seen).toEqual(original);
  });
});

describe("Sentinel observes Foundry promotions", () => {
  /**
   * Watches promotions through the hooks Evolution Control already exposes.
   *
   * `onPromotion` and `onPromotionRefused` were written into
   * `EvolutionControlOptions` and, like the SentinelWatch port, nothing was
   * listening. This is the listener.
   */
  const watched = (sentinel: ReturnType<typeof createSentinelIq>) => {
    let n = 0;
    return createEvolutionControl({
      now: () => AT,
      onPromotion: (change, target) => {
        n += 1;
        sentinel.observe({
          findingId: `find_promotion_${n}`,
          kind: "engine_health",
          severity: "informational",
          confidence: "confirmed",
          subject: { kind: "deployment", id: `${change.changeId}.${target}`, tenant: TENANT },
          summary: `Change ${change.changeId} promoted to ${target} as a ${change.level}.`,
          evidence: evidence(`evolution.${change.changeId}`),
          observedAt: AT.toISOString(),
        });
      },
      onPromotionRefused: (changeId, target, reason) => {
        n += 1;
        // A refused PRODUCTION promotion is the wall doing its job, and worth
        // recording at a severity somebody reviews: an attempt to reach
        // production is the event this whole apparatus exists around.
        sentinel.observe({
          findingId: `find_refused_${n}`,
          kind: "constitutional_violation",
          severity: target === "PRODUCTION" ? "high" : "low",
          confidence: "confirmed",
          subject: { kind: "deployment", id: `${changeId}.${target}`, tenant: TENANT },
          summary: `Promotion of ${changeId} to ${target} was refused: ${reason.slice(0, 200)}`,
          evidence: evidence(`evolution.${changeId}`),
          observedAt: AT.toISOString(),
        });
      },
    });
  };

  const register = (evolution: ReturnType<typeof createEvolutionControl>) => {
    evolution.register({
      changeId: "chg_ow_1",
      missionId: "MIS-OW-1",
      candidateId: candidate.repairCandidateId,
      workspaceId: "ws_1",
      baseRevision: "f4ce105",
      classification,
    });
    evolution.submit("chg_ow_1", "foundry");
    evolution.recordValidation("chg_ow_1", { accepted: true, reason: "green" }, "foundry");
  };

  it("records a permitted promotion", () => {
    const sentinel = createSentinelIq({ now: () => AT });
    const evolution = watched(sentinel);
    register(evolution);

    expect(evolution.promote("chg_ow_1", "VALIDATION", "foundry").promoted).toBe(true);

    const findings = sentinel.find({});
    expect(findings).toHaveLength(1);
    expect(findings[0]!.finding.summary).toContain("promoted to VALIDATION");
  });

  it("raises a HIGH finding when something reaches for production", () => {
    // The wall refusing is not a failure — it is the control working. But an
    // attempt to reach production is exactly the event an independent observer
    // should be able to see without Foundry choosing to mention it.
    const sentinel = createSentinelIq({ now: () => AT });
    const evolution = watched(sentinel);
    register(evolution);

    expect(evolution.promote("chg_ow_1", "PRODUCTION", "human.steven").promoted).toBe(false);

    const findings = sentinel.find({ atLeastSeverity: "high" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.finding.summary).toContain("PRODUCTION");
    expect(findings[0]!.finding.kind).toBe("constitutional_violation");

    // And the wall is unchanged by being watched.
    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
  });

  it("keeps the record after the fact, because Sentinel has no delete", () => {
    // Every disposition stays queryable, including resolved ones. Being wrong
    // in public is the point; so is being right in public.
    const sentinel = createSentinelIq({ now: () => AT });
    const evolution = watched(sentinel);
    register(evolution);

    evolution.promote("chg_ow_1", "PRODUCTION", "human.steven");
    evolution.promote("chg_ow_1", "VALIDATION", "foundry");

    expect(sentinel.count()).toBe(2);
    const surface = Object.keys(sentinel);
    for (const forbidden of ["delete", "suppress", "dismiss", "clear"]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it("reports its own health, so the observer can be observed", () => {
    // §17 requires Sentinel to remain independently observable. An overwatch
    // system that cannot be watched has exempted itself.
    const sentinel = createSentinelIq({ now: () => AT });
    const evolution = watched(sentinel);
    register(evolution);
    evolution.promote("chg_ow_1", "PRODUCTION", "human.steven");

    const health = sentinel.health();
    expect(health.openFindings).toBe(1);
    expect(health.unresolvedCatastrophic).toBe(0);
    // "unknown", because no host supplied a self-assessment — and it is a
    // real member of the vocabulary now rather than a value cast past the
    // type. Unknown is not healthy, which is the whole point.
    expect(health.state).toBe("unknown");
    expect(acceptsConsequentialWork(health.state)).toBe(false);
  });
});
