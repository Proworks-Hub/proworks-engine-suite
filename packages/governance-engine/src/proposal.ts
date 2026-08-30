// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  engineOpinionSchema,
  foundryReportSchema,
  humanDecisionSchema,
  proposalSchema,
  requiresHumanAuthorization,
  sentinelOpinionSchema,
  type EngineOpinion,
  type FoundryReport,
  type HumanDecision,
  type Proposal,
  type ProposalState,
  type SentinelOpinion,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The human decision gate.
//
// Lives in the governance engine because it is the same question that package
// already owns — may this happen — asked at the one point where the answer is
// reserved for a person. It does not replace `authorize`: Governance policy
// still decides whether a change is permitted at all, and this decides whether
// the human step that policy requires has actually been taken, by someone
// entitled to take it.
//
// WHAT MACHINES MAY DO HERE
//
// Everything except decide. Propose, triage, build, validate, gather opinions,
// assemble the package, and mark it ready. `assemble` is fully automatable and
// is meant to be: a system that made humans do the preparation would get
// skipped under deadline.
//
// THREE REFUSALS THAT ARE THE POINT
//
//   SELF-APPROVAL. The approver may not be the proposer, and may not be the
//   engine the change affects. An engine proposing an expansion of its own
//   authority and then approving it under a service identity would otherwise
//   be a complete, valid, auditable path to unlimited self-grant.
//
//   UNSCOPED APPROVAL. "Approved" alone is refused. A year later nobody can
//   tell whether the person agreed to the change, the version, or the rollout.
//
//   STALE APPROVAL. An approval names an artifact digest. Rebuild it and the
//   approval no longer reaches it — which is the quiet version of shipping
//   something nobody agreed to.
//
// WHAT IT DOES NOT DO
//
// It does not deploy, promote or release. `RELEASE_PIPELINE` is a state
// meaning "handed on", and what happens next is Foundry's wall and the
// collective repository, both unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionPackage {
  readonly proposal: Proposal;
  readonly state: ProposalState;
  readonly engineOpinions: readonly EngineOpinion[];
  readonly sentinelOpinion: SentinelOpinion | null;
  readonly foundryReport: FoundryReport | null;
  readonly decision: HumanDecision | null;
  readonly history: readonly { state: ProposalState; at: string; by: string; reason: string }[];
}

export interface ReadinessVerdict {
  readonly ready: boolean;
  /** Everything missing, not just the first. A gate that reports one gap at a
   * time turns preparation into a guessing game. */
  readonly missing: readonly string[];
  readonly blocked: boolean;
  readonly blockReason?: string;
}

export type ProposalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface ProposalRegistry {
  /** Records a proposal. Anything may propose. */
  propose(input: unknown): ProposalResult<DecisionPackage>;

  /** Attaches one engine's advisory view. */
  addOpinion(proposalId: string, opinion: unknown): ProposalResult<DecisionPackage>;

  /** Attaches Sentinel's separate assessment. */
  addSentinelOpinion(proposalId: string, opinion: unknown): ProposalResult<DecisionPackage>;

  /** Attaches what Foundry built. Moves the proposal to VALIDATED. */
  addFoundryReport(proposalId: string, report: unknown): ProposalResult<DecisionPackage>;

  /** Whether the package is complete enough to put in front of a person. */
  readiness(proposalId: string): ReadinessVerdict;

  /**
   * Records a person's decision.
   *
   * Refuses a self-approval, an unscoped one, and one taken before the package
   * is ready.
   */
  decide(
    proposalId: string,
    decision: unknown,
    approver: { id: string; kind: "human" | "engine" | "service" },
  ): ProposalResult<DecisionPackage>;

  /**
   * Whether an approval still covers what is about to ship.
   *
   * Called with the digest of the artifact actually being released. A
   * different digest reopens the proposal.
   */
  approvalCovers(proposalId: string, artifactDigest: string): { covers: boolean; reason: string };

  get(proposalId: string): DecisionPackage | null;
  all(): readonly DecisionPackage[];
}

export interface ProposalRegistryOptions {
  readonly now?: () => Date;
  /**
   * Engines whose opinion is required before a decision.
   *
   * A host's policy, not a hard-coded list — different deployments have
   * different engines. Sentinel is required separately and is not configurable
   * here, because a deployment that could switch off the safety opinion would
   * be a deployment that could switch off safety.
   */
  readonly requiredOpinionsFrom?: readonly string[];
  readonly onStateChange?: (pkg: DecisionPackage, from: ProposalState) => void;
}

export function createProposalRegistry(
  options: ProposalRegistryOptions = {},
): ProposalRegistry {
  const now = options.now ?? (() => new Date());
  const required = options.requiredOpinionsFrom ?? [];
  const packages = new Map<string, DecisionPackage>();

  const move = (
    pkg: DecisionPackage,
    state: ProposalState,
    by: string,
    reason: string,
  ): DecisionPackage => {
    const next: DecisionPackage = {
      ...pkg,
      state,
      history: [...pkg.history, { state, at: now().toISOString(), by, reason }],
    };
    packages.set(next.proposal.proposalId, next);
    options.onStateChange?.(next, pkg.state);
    return next;
  };

  const readinessOf = (pkg: DecisionPackage): ReadinessVerdict => {
    const missing: string[] = [];

    if (!pkg.foundryReport) missing.push("a Foundry report");
    // Sentinel's opinion is required and is not on the configurable list. A
    // deployment that could switch off the safety opinion would be one that
    // could switch off safety.
    if (!pkg.sentinelOpinion) missing.push("a Sentinel assessment");

    for (const engineId of required) {
      if (!pkg.engineOpinions.some((o) => o.engineId === engineId)) {
        missing.push(`an opinion from ${engineId}`);
      }
    }

    const blockReason = pkg.sentinelOpinion?.blockReason;
    if (blockReason) {
      // A block is not an objection to be weighed. Three supportive engines do
      // not outvote a constitutional finding.
      return { ready: false, missing, blocked: true, blockReason };
    }

    return { ready: missing.length === 0, missing, blocked: false };
  };

  return {
    propose(input) {
      const parsed = proposalSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, reason: `Not a valid proposal: ${JSON.stringify(parsed.error.flatten())}` };
      }
      if (packages.has(parsed.data.proposalId)) {
        return { ok: false, reason: `Proposal ${parsed.data.proposalId} already exists.` };
      }

      // A revision must name what it revises, and that proposal must exist and
      // must have been rejected. Otherwise "revision" is a word attached to a
      // resubmission, and the reviewer who rejected it has no way to know they
      // are reading it again.
      if (parsed.data.revises) {
        const prior = packages.get(parsed.data.revises);
        if (!prior) {
          return { ok: false, reason: `This revises ${parsed.data.revises}, which does not exist.` };
        }
        if (prior.state !== "REJECTED") {
          return {
            ok: false,
            reason: `This revises ${parsed.data.revises}, which is ${prior.state} rather than REJECTED. A revision replaces something that was turned down; anything else is a second proposal.`,
          };
        }
      }

      const pkg: DecisionPackage = {
        proposal: parsed.data,
        state: "PROPOSED",
        engineOpinions: [],
        sentinelOpinion: null,
        foundryReport: null,
        decision: null,
        history: [
          {
            state: "PROPOSED",
            at: now().toISOString(),
            by: parsed.data.proposerId,
            reason: parsed.data.problem,
          },
        ],
      };
      packages.set(pkg.proposal.proposalId, pkg);
      return { ok: true, value: pkg };
    },

    addOpinion(proposalId, opinion) {
      const pkg = packages.get(proposalId);
      if (!pkg) return { ok: false, reason: `No proposal ${proposalId}.` };
      if (pkg.decision) {
        return {
          ok: false,
          reason: "This proposal has been decided. An opinion arriving after the decision is a reason to reopen it, not a field to append to it.",
        };
      }

      const parsed = engineOpinionSchema.safeParse(opinion);
      if (!parsed.success) {
        return { ok: false, reason: `Not a valid opinion: ${JSON.stringify(parsed.error.flatten())}` };
      }

      // One opinion per engine. A second would either be an update nobody can
      // see, or two votes from one engine.
      const others = pkg.engineOpinions.filter((o) => o.engineId !== parsed.data.engineId);
      const next: DecisionPackage = { ...pkg, engineOpinions: [...others, parsed.data] };
      packages.set(proposalId, next);
      return { ok: true, value: move(next, "OPINION_ASSEMBLY", parsed.data.engineId, "opinion recorded") };
    },

    addSentinelOpinion(proposalId, opinion) {
      const pkg = packages.get(proposalId);
      if (!pkg) return { ok: false, reason: `No proposal ${proposalId}.` };
      const parsed = sentinelOpinionSchema.safeParse(opinion);
      if (!parsed.success) {
        return { ok: false, reason: `Not a valid Sentinel opinion: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const next: DecisionPackage = { ...pkg, sentinelOpinion: parsed.data };
      packages.set(proposalId, next);
      return { ok: true, value: next };
    },

    addFoundryReport(proposalId, report) {
      const pkg = packages.get(proposalId);
      if (!pkg) return { ok: false, reason: `No proposal ${proposalId}.` };
      const parsed = foundryReportSchema.safeParse(report);
      if (!parsed.success) {
        return { ok: false, reason: `Not a valid Foundry report: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const next: DecisionPackage = { ...pkg, foundryReport: parsed.data };
      packages.set(proposalId, next);
      return { ok: true, value: move(next, "VALIDATED", "foundry", parsed.data.recommendationBasis) };
    },

    readiness(proposalId) {
      const pkg = packages.get(proposalId);
      if (!pkg) return { ready: false, missing: ["the proposal itself"], blocked: false };
      return readinessOf(pkg);
    },

    decide(proposalId, decision, approver) {
      const pkg = packages.get(proposalId);
      if (!pkg) return { ok: false, reason: `No proposal ${proposalId}.` };
      if (pkg.decision) {
        return { ok: false, reason: `Proposal ${proposalId} was already decided.` };
      }

      const parsed = humanDecisionSchema.safeParse(decision);
      if (!parsed.success) {
        return { ok: false, reason: `Not a valid decision: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const d = parsed.data;

      // ── A person, and not just anyone ────────────────────────────────────
      if (approver.kind !== "human") {
        return {
          ok: false,
          reason: `A ${approver.kind} may not take a decision reserved for a person. Machines prepare; people decide.`,
        };
      }
      if (approver.id !== d.approverId) {
        return {
          ok: false,
          reason: "The caller's identity and the decision's approver do not match. A decision recorded on somebody else's behalf is unattributable.",
        };
      }

      // ── Self-approval, both ways ─────────────────────────────────────────
      if (d.approverId === pkg.proposal.proposerId) {
        return {
          ok: false,
          reason: "The proposer may not approve their own proposal. No component satisfies its own required human approval, and the rule does not stop applying because the proposer is a person.",
        };
      }
      if (d.approverId === d.scopeAuthorized.engineId) {
        return {
          ok: false,
          reason: "The engine being changed may not approve the change to itself.",
        };
      }

      // ── The package has to be complete ───────────────────────────────────
      const readiness = readinessOf(pkg);
      if (d.decision === "approved") {
        if (readiness.blocked) {
          return { ok: false, reason: `Sentinel has blocked this proposal: ${readiness.blockReason}` };
        }
        if (!readiness.ready) {
          return {
            ok: false,
            reason: `The decision package is not ready. Missing: ${readiness.missing.join("; ")}.`,
          };
        }
        // The approval is bound to what was actually built. An approval naming
        // a digest nobody produced is an approval for nothing.
        if (d.scopeAuthorized.artifactDigest !== pkg.foundryReport?.artifactDigest) {
          return {
            ok: false,
            reason: "The approved digest does not match what Foundry built. An approval names an artifact, not an intention.",
          };
        }
        if (
          requiresHumanAuthorization(pkg.proposal.changeClass) &&
          d.scopeAuthorized.changeClass !== pkg.proposal.changeClass
        ) {
          return {
            ok: false,
            reason: `The approval is scoped to a ${d.scopeAuthorized.changeClass} change and the proposal is ${pkg.proposal.changeClass}. Approving a smaller thing than was proposed is how scope quietly widens.`,
          };
        }
      }

      const next: DecisionPackage = { ...pkg, decision: d };
      packages.set(proposalId, next);
      return {
        ok: true,
        value: move(next, d.decision === "approved" ? "APPROVED" : "REJECTED", d.approverId, d.reason),
      };
    },

    approvalCovers(proposalId, artifactDigest) {
      const pkg = packages.get(proposalId);
      if (!pkg) return { covers: false, reason: `No proposal ${proposalId}.` };
      if (!pkg.decision || pkg.decision.decision !== "approved") {
        return { covers: false, reason: "This proposal has no approval." };
      }
      if (pkg.decision.scopeAuthorized.artifactDigest !== artifactDigest) {
        // Reopened rather than merely refused: the approval is now known to be
        // stale, and leaving it marked APPROVED would let a later reader
        // believe the current artifact was agreed to.
        move(
          pkg,
          "AWAITING_HUMAN_AUTHORIZATION",
          "system",
          `The artifact changed from ${pkg.decision.scopeAuthorized.artifactDigest} to ${artifactDigest}.`,
        );
        return {
          covers: false,
          reason:
            `The approval names artifact ${pkg.decision.scopeAuthorized.artifactDigest} and this is ${artifactDigest}. ` +
            "A person who approved a build approved that build; the proposal is reopened rather than carried across.",
        };
      }
      return { covers: true, reason: `Approved by ${pkg.decision.approverId} for ${pkg.decision.scopeAuthorized.version}.` };
    },

    get: (proposalId) => packages.get(proposalId) ?? null,
    all: () => [...packages.values()],
  };
}

/**
 * Whether reaching RELEASE_PIPELINE deploys anything.
 *
 * Always false. It is a state meaning "handed on". What happens next is
 * Foundry's promotion wall and the collective repository, both unchanged, and
 * neither of them installs anything either.
 */
export function approvalDeploys(): false {
  return false;
}
