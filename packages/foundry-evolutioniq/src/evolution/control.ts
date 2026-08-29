// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { DriftFinding, RepairCandidate, ScoredRepair } from "@proworks-hub/repair-learning";

// ─────────────────────────────────────────────────────────────────────────────
// Evolution Control: the candidate change lifecycle, and the promotion wall.
//
// THE WALL IS THE POINT OF THIS MODULE
//
// Everything else Foundry does — inspect, diagnose, spawn, mutate, test,
// validate, learn — happens inside a sandbox and is reversible. This is the one
// place where something could leave, and it does not.
//
// `promote()` accepts SIMULATION and VALIDATION. It refuses STAGING and
// PRODUCTION unconditionally, with no parameter, flag or authority class that
// changes the answer. Not "requires more approval" — refused. Production
// promotion is a separate authority class that does not exist yet, and the
// correct representation of an authority that does not exist is a function that
// says no rather than a code path nobody has exercised.
//
// Foundry Charter §18: "Development authority does not automatically authorize
// deployment." §13: material behavioural changes "require applicable human
// authorization. Foundry may prepare the work without possessing authority to
// approve it."
//
// So Foundry V1 can autonomously do this:
//
//   inspect → diagnose → create mission → spawn bot → generate candidate
//   → modify sandbox → test → validate → learn
//
// And not this:
//
//   deploy material changes to production
//
// MATERIAL CHANGE IS ITS OWN CLASSIFICATION
//
// §22 distinguishes AUTONOMOUS_REPAIR, SUPERVISED_REPAIR and MATERIAL_CHANGE,
// and adds that "a Material Change must not be deployed as a repair merely
// because tests pass". So classification happens before promotion is even
// considered, and a material change cannot be promoted autonomously anywhere —
// including in a sandbox, because the classification is about what the change
// IS, not about where it would land.
// ─────────────────────────────────────────────────────────────────────────────

export const changeStateSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "VALIDATED",
  "REJECTED",
  /** Applied in a sandbox or validation environment. */
  "PROMOTED",
  "REVERTED",
  /** Held: it is a material change and needs human authorization. */
  "AWAITING_HUMAN_AUTHORIZATION",
]);
export type ChangeState = z.infer<typeof changeStateSchema>;

/** Directive §22's repair levels. */
export const repairLevelSchema = z.enum([
  /** Foundry may apply it itself, in a sandbox. */
  "AUTONOMOUS_REPAIR",
  /** A human must be watching. */
  "SUPERVISED_REPAIR",
  /** Changes behaviour materially. Human authorization, always. */
  "MATERIAL_CHANGE",
]);
export type RepairLevel = z.infer<typeof repairLevelSchema>;

export interface ClassifiedChange {
  readonly level: RepairLevel;
  readonly because: readonly string[];
}

/**
 * What makes a change material.
 *
 * Deliberately generous — when in doubt this classifies UP, because the cost of
 * calling a trivial change material is a human glancing at it, and the cost of
 * calling a material change trivial is a behavioural change nobody approved.
 */
export function classifyChange(input: {
  candidate: RepairCandidate;
  filesChanged: number;
  componentsTouched: number;
  contractsTouched: number;
  testsRemoved: number;
  dependenciesTouched: number;
}): ClassifiedChange {
  const because: string[] = [];

  if (input.contractsTouched > 0) {
    because.push(
      `touches ${input.contractsTouched} contract(s), which changes what other engines may rely on`,
    );
  }
  if (input.dependenciesTouched > 0) {
    because.push("changes dependencies, which is a supply-chain surface");
  }
  if (input.testsRemoved > 0) {
    because.push(`removes ${input.testsRemoved} test(s)`);
  }
  if (input.candidate.risk === "SEVERE" || input.candidate.risk === "HIGH") {
    because.push(`is declared ${input.candidate.risk} risk`);
  }
  if (input.candidate.reversibility === "NOT_APPLICABLE") {
    because.push("cannot be reversed");
  }
  if (input.componentsTouched > 1) {
    because.push(`spans ${input.componentsTouched} components`);
  }
  if (
    input.candidate.proposedActions.some(
      (a) => a.target === "authority_grant" || a.target === "tenant_check",
    )
  ) {
    because.push("touches an authority grant or a tenant boundary");
  }

  if (because.length > 0) return { level: "MATERIAL_CHANGE", because };

  if (input.filesChanged > 5 || input.candidate.risk === "MODERATE") {
    return {
      level: "SUPERVISED_REPAIR",
      because: [`${input.filesChanged} file(s) at ${input.candidate.risk} risk`],
    };
  }

  return {
    level: "AUTONOMOUS_REPAIR",
    because: ["small, low-risk, reversible, single-component, touches no contract or protection"],
  };
}

export interface CandidateChange {
  readonly changeId: string;
  readonly missionId: string;
  readonly candidateId: string;
  readonly state: ChangeState;
  readonly level: RepairLevel;
  readonly classification: ClassifiedChange;
  readonly workspaceId: string;
  readonly baseRevision: string;
  /** Where it has been applied, if anywhere. */
  readonly promotedTo: string | null;
  readonly history: readonly { state: ChangeState; at: string; by: string; reason: string }[];
}

export type PromotionTarget = "SIMULATION" | "VALIDATION" | "STAGING" | "PRODUCTION";

export type PromotionVerdict =
  | { readonly promoted: true; readonly change: CandidateChange }
  | { readonly promoted: false; readonly reason: string; readonly requiresAuthority: string | null };

/**
 * Environments Foundry V1 may promote into. Two, and they are both sandboxes.
 *
 * Written as a `Set` of exactly two strings rather than as "not production",
 * because a denylist grows a hole the moment somebody adds an environment.
 */
const PROMOTABLE: ReadonlySet<PromotionTarget> = new Set<PromotionTarget>(["SIMULATION", "VALIDATION"]);

export interface EvolutionControl {
  /** Registers a change produced by a mission. */
  register(input: {
    changeId: string;
    missionId: string;
    candidateId: string;
    workspaceId: string;
    baseRevision: string;
    classification: ClassifiedChange;
  }): { registered: true; change: CandidateChange } | { registered: false; reason: string };

  submit(changeId: string, by: string): { ok: boolean; reason: string };

  /** Records the validation verdict. */
  recordValidation(
    changeId: string,
    outcome: { accepted: boolean; reason: string; score?: ScoredRepair },
    by: string,
  ): { ok: boolean; reason: string };

  /**
   * Promotes a validated change.
   *
   * THE WALL. Refuses STAGING and PRODUCTION with no override.
   */
  promote(changeId: string, target: PromotionTarget, by: string): PromotionVerdict;

  revert(changeId: string, why: string, by: string): { ok: boolean; reason: string };

  /** Records a drift finding as an improvement opportunity. */
  recordDrift(finding: DriftFinding): void;
  /** Drift findings that have not yet produced a mission. */
  openDrift(): readonly DriftFinding[];
  /** Marks a drift finding as addressed by a mission. */
  addressDrift(findingId: string, missionId: string): { ok: boolean; reason: string };

  get(changeId: string): CandidateChange | null;
  all(): readonly CandidateChange[];
}

export interface EvolutionControlOptions {
  now?: () => Date;
  onPromotion?: (change: CandidateChange, target: PromotionTarget) => void;
  onPromotionRefused?: (changeId: string, target: PromotionTarget, reason: string) => void;
}

export function createEvolutionControl(options: EvolutionControlOptions = {}): EvolutionControl {
  const now = options.now ?? (() => new Date());
  const changes = new Map<string, CandidateChange>();
  const drift = new Map<string, { finding: DriftFinding; missionId: string | null }>();

  const move = (
    change: CandidateChange,
    state: ChangeState,
    by: string,
    reason: string,
    extra: Partial<CandidateChange> = {},
  ): CandidateChange => {
    const updated: CandidateChange = {
      ...change,
      state,
      history: [...change.history, { state, at: now().toISOString(), by, reason }],
      ...extra,
    };
    changes.set(change.changeId, updated);
    return updated;
  };

  return {
    register(input) {
      if (changes.has(input.changeId)) {
        return { registered: false, reason: `Change ${input.changeId} already exists.` };
      }

      const change: CandidateChange = {
        changeId: input.changeId,
        missionId: input.missionId,
        candidateId: input.candidateId,
        state: "DRAFT",
        level: input.classification.level,
        classification: input.classification,
        workspaceId: input.workspaceId,
        baseRevision: input.baseRevision,
        promotedTo: null,
        history: [],
      };

      changes.set(input.changeId, change);
      return { registered: true, change };
    },

    submit(changeId, by) {
      const change = changes.get(changeId);
      if (!change) return { ok: false, reason: `No change ${changeId}.` };
      if (change.state !== "DRAFT") {
        return { ok: false, reason: `Change ${changeId} is ${change.state}, not DRAFT.` };
      }
      move(change, "SUBMITTED", by, "Submitted for validation.");
      return { ok: true, reason: "Submitted." };
    },

    recordValidation(changeId, outcome, by) {
      const change = changes.get(changeId);
      if (!change) return { ok: false, reason: `No change ${changeId}.` };
      if (change.state !== "SUBMITTED") {
        return { ok: false, reason: `Change ${changeId} is ${change.state}, not SUBMITTED.` };
      }

      if (!outcome.accepted) {
        move(change, "REJECTED", by, outcome.reason);
        return { ok: true, reason: "Recorded as rejected." };
      }

      // A material change that passed validation is still held. §22: "A
      // Material Change must not be deployed as a repair merely because tests
      // pass." Passing is necessary and is not sufficient.
      if (change.level === "MATERIAL_CHANGE") {
        move(
          change,
          "AWAITING_HUMAN_AUTHORIZATION",
          by,
          `Validated, and held: ${change.classification.because.join("; ")}. A material change is not deployed merely because tests pass.`,
        );
        return { ok: true, reason: "Validated and held for human authorization." };
      }

      move(change, "VALIDATED", by, outcome.reason);
      return { ok: true, reason: "Validated." };
    },

    promote(changeId, target, by) {
      const change = changes.get(changeId);
      if (!change) {
        return { promoted: false, reason: `No change ${changeId}.`, requiresAuthority: null };
      }

      // ── THE WALL ────────────────────────────────────────────────────────
      //
      // Checked first, before state, before level, before anything. A refusal
      // that came after a state check would report "change is not VALIDATED"
      // for a production attempt, which tells the caller to fix the wrong
      // thing.
      if (!PROMOTABLE.has(target)) {
        const reason =
          `Foundry V1 does not promote to ${target}. It promotes to SIMULATION and VALIDATION only. ` +
          "Development authority does not automatically authorize deployment (Charter §18), and Foundry may prepare " +
          "work without possessing authority to approve it (§13). There is no flag, parameter or authority class here " +
          "that changes this answer.";
        options.onPromotionRefused?.(changeId, target, reason);
        return {
          promoted: false,
          reason,
          requiresAuthority:
            "A Governance-controlled production deployment authority class, which does not exist yet.",
        };
      }

      if (change.state === "AWAITING_HUMAN_AUTHORIZATION") {
        return {
          promoted: false,
          reason: `Change ${changeId} is a ${change.level} awaiting human authorization: ${change.classification.because.join("; ")}.`,
          requiresAuthority: "Human constitutional authority (Charter §13).",
        };
      }

      if (change.state !== "VALIDATED") {
        return {
          promoted: false,
          reason: `Change ${changeId} is ${change.state}. Only a VALIDATED change is promoted.`,
          requiresAuthority: null,
        };
      }

      const promoted = move(change, "PROMOTED", by, `Promoted to ${target}.`, { promotedTo: target });
      options.onPromotion?.(promoted, target);
      return { promoted: true, change: promoted };
    },

    revert(changeId, why, by) {
      const change = changes.get(changeId);
      if (!change) return { ok: false, reason: `No change ${changeId}.` };
      if (change.state !== "PROMOTED") {
        return { ok: false, reason: `Change ${changeId} is ${change.state}, not PROMOTED.` };
      }
      move(change, "REVERTED", by, why, { promotedTo: null });
      return { ok: true, reason: "Reverted." };
    },

    recordDrift(finding) {
      if (drift.has(finding.findingId)) return;
      drift.set(finding.findingId, { finding, missionId: null });
    },

    openDrift: () =>
      [...drift.values()].filter((d) => d.missionId === null).map((d) => d.finding),

    addressDrift(findingId, missionId) {
      const entry = drift.get(findingId);
      if (!entry) return { ok: false, reason: `No drift finding ${findingId}.` };
      if (entry.missionId !== null) {
        return { ok: false, reason: `Already addressed by mission ${entry.missionId}.` };
      }
      drift.set(findingId, { ...entry, missionId });
      return { ok: true, reason: `Addressed by mission ${missionId}.` };
    },

    get: (changeId) => changes.get(changeId) ?? null,
    all: () => [...changes.values()],
  };
}

/**
 * Foundry Charter §18: "Repair does not automatically authorize feature
 * expansion."
 *
 * Always false. A mission authorized to fix something has not thereby been
 * authorized to improve it, and the drift between the two is how a repair
 * becomes a rewrite that nobody approved.
 */
export function repairAuthorizesFeatureExpansion(_change: CandidateChange): false {
  return false;
}

/**
 * Foundry V1 holds no production deployment authority.
 *
 * Always false, and exported so a caller wondering whether some configuration
 * could enable it finds a function that says no rather than searching for a
 * flag. The same shape as `healthGrantsAuthority()` in Foundation and
 * `absorbsAuthorityFrom()` in Sentinel.
 */
export function foundryHasProductionDeploymentAuthority(): false {
  return false;
}
