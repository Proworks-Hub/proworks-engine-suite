// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { isSynchronousOnly } from "@proworks-hub/contracts";

import type { PrimeExecutionContext } from "../context.js";

// ─────────────────────────────────────────────────────────────────────────────
// PRIME NEXUS — the command chamber.
//
// Nexus answers one question: given work that is ALREADY authorized, which
// permitted step happens next?
//
// The emphasis is the whole design. Nexus selects; it does not permit. Every
// refusal below exists because the alternative is a chamber that, faced with a
// missing authorization, quietly decides the work may proceed anyway — which is
// how an orchestrator becomes an authorizer without anybody deciding it should.
//
// WHAT NEXUS MAY NOT DO, AND WHY IT IS STRUCTURAL RATHER THAN DOCUMENTED
//
// Nexus has no engine handles, no store, and no publisher. It is handed a
// state and returns a decision. It cannot create a work order or reserve
// material because it is holding nothing that could — the prohibition is the
// absence of the capability, not a rule about using it.
//
// DEGRADATION IS NOT PERMISSION
//
// The subtle failure this chamber exists to prevent: an engine is unavailable,
// the dependency cannot be checked, and "cannot check" becomes "no objection".
// Unchecked is not satisfied. A dependency Nexus could not evaluate blocks,
// and says so.
// ─────────────────────────────────────────────────────────────────────────────

/** What Nexus concluded. Every outcome names a reason. */
export type NexusOutcome =
  | "proceed"
  | "waiting"
  | "blocked"
  | "refused"
  | "completed";

export interface StepDependency {
  readonly stepId: string;
  /**
   * Whether the prerequisite is satisfied.
   *
   * `null` means UNKNOWN — the engine could not be reached, the check timed
   * out. Deliberately not a boolean: a boolean forces the caller to answer
   * "no" or "yes" when the truth is "could not tell", and "could not tell"
   * collapsing into "yes" is the failure this whole type exists for.
   */
  readonly satisfied: boolean | null;
  readonly detail?: string;
}

export interface CandidateStep {
  readonly stepId: string;
  /** Prerequisites that must be satisfied first. */
  readonly dependsOn?: readonly StepDependency[];
  /**
   * The named operation this step performs, when it maps to one.
   *
   * Checked against the constitutional synchronous-only list. A step naming
   * `authorize` and declaring itself asynchronous is refused.
   */
  readonly operation?: string;
  /** Whether the caller intends to run this step asynchronously. */
  readonly asynchronous?: boolean;
  /** Whether the step requires a validated authorization to run. */
  readonly requiresAuthorization?: boolean;
  /** A synchronous validation result. `null` means it has not been run. */
  readonly validationPassed?: boolean | null;
}

export interface NexusDecision {
  readonly outcome: NexusOutcome;
  /** The step to run. Present only when the outcome is `proceed`. */
  readonly stepId: string | null;
  readonly reason: string;
  /** Which prerequisites were consulted, and what they said. */
  readonly evidence: readonly string[];
  /** The context, unchanged. Nexus propagates; it does not enrich. */
  readonly context: PrimeExecutionContext;
}

export interface PrimeNexus {
  readonly chamber: "nexus";
  /**
   * Chooses the next permitted step.
   *
   * Deterministic: the same authorized state yields the same decision, because
   * an orchestrator whose answer depends on when it was asked cannot be
   * reasoned about after an incident.
   */
  next(input: {
    context: PrimeExecutionContext;
    steps: readonly CandidateStep[];
    completedStepIds?: readonly string[];
  }): NexusDecision;

  /** Whether a step may lawfully run asynchronously. Never true for the eight. */
  mayRunAsynchronously(step: CandidateStep): boolean;
}

export function createPrimeNexus(): PrimeNexus {
  const decide = (
    outcome: NexusOutcome,
    stepId: string | null,
    reason: string,
    evidence: readonly string[],
    context: PrimeExecutionContext,
  ): NexusDecision => ({ outcome, stepId, reason, evidence, context });

  return {
    chamber: "nexus",

    mayRunAsynchronously(step) {
      if (step.operation !== undefined && isSynchronousOnly(step.operation)) return false;
      return true;
    },

    next({ context, steps, completedStepIds = [] }) {
      const done = new Set(completedStepIds);
      const evidence: string[] = [];

      const remaining = steps.filter((s) => !done.has(s.stepId));
      if (remaining.length === 0) {
        return decide(
          "completed",
          null,
          "Every declared step is complete.",
          [`completed: ${completedStepIds.join(", ") || "none"}`],
          context,
        );
      }

      // Steps are considered in declared order. Nexus does not reorder work to
      // find something runnable — that would be choosing a different workflow
      // from the authorized one and calling it progress.
      for (const step of remaining) {
        // ── The synchronous-only wall ─────────────────────────────────────
        //
        // Checked FIRST, before authorization and before dependencies. A step
        // that would publish "may I authorize?" is refused whatever else is
        // true about it, and refusing it late would mean the other checks had
        // already treated it as a legitimate candidate.
        if (step.asynchronous === true && step.operation !== undefined && isSynchronousOnly(step.operation)) {
          return decide(
            "refused",
            null,
            `Step ${step.stepId} performs "${step.operation}", which may never be performed asynchronously. ` +
              "Publishing a request for permission and continuing is acting without an answer, not asking for one.",
            [...evidence, `synchronous-only: ${step.operation}`],
            context,
          );
        }

        // ── Authorization ─────────────────────────────────────────────────
        //
        // Nexus cannot supply this. A step requiring authorization without one
        // blocks; it does not proceed with a note.
        if (step.requiresAuthorization === true && context.authorizationRef === undefined) {
          return decide(
            "blocked",
            null,
            `Step ${step.stepId} requires an authorization and the execution context carries none. ` +
              "Nexus propagates authority and does not create it (Charter §13).",
            [...evidence, `authorization: absent`],
            context,
          );
        }

        // ── Synchronous validation ────────────────────────────────────────
        //
        // `null` — not run — blocks exactly as `false` does. Unvalidated is not
        // validated.
        if (step.validationPassed === false || step.validationPassed === null) {
          const state = step.validationPassed === null ? "was not run" : "failed";
          return decide(
            "blocked",
            null,
            `Step ${step.stepId} is gated on a synchronous validation that ${state}. ` +
              "An unrun validation blocks for the same reason a failed one does: neither is a pass.",
            [...evidence, `validation: ${state}`],
            context,
          );
        }

        // ── Dependencies ──────────────────────────────────────────────────
        const unsatisfied = (step.dependsOn ?? []).filter((d) => d.satisfied !== true);
        if (unsatisfied.length > 0) {
          const unknown = unsatisfied.filter((d) => d.satisfied === null);
          for (const d of unsatisfied) {
            evidence.push(
              `dependency ${d.stepId}: ${d.satisfied === null ? "UNKNOWN" : "not satisfied"}${d.detail ? ` (${d.detail})` : ""}`,
            );
          }
          return decide(
            "waiting",
            null,
            unknown.length > 0
              ? `Step ${step.stepId} depends on ${unknown.map((d) => d.stepId).join(", ")}, which could not be evaluated. ` +
                "Unchecked is not satisfied, so this waits rather than proceeding."
              : `Step ${step.stepId} is waiting on ${unsatisfied.map((d) => d.stepId).join(", ")}.`,
            evidence,
            context,
          );
        }

        for (const d of step.dependsOn ?? []) evidence.push(`dependency ${d.stepId}: satisfied`);
        return decide(
          "proceed",
          step.stepId,
          `Step ${step.stepId} is next: every declared prerequisite is satisfied and its authorization is present.`,
          evidence,
          { ...context, stepId: step.stepId },
        );
      }

      // Unreachable while `remaining` is non-empty, and kept rather than
      // asserted away: a loop that can fall through should say what it means.
      return decide("blocked", null, "No step could be selected.", evidence, context);
    },
  };
}
