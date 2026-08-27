/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — Terminal rules (pure)
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.8.
 *
 * Deterministic helpers used by the Terminal use case and by callers that
 * want to check terminal-readiness without committing.
 *
 *  - `canComplete(trackedSteps)` — gates `work_order.completed` emission
 *  - `canCancel(currentMilestone)` — gates `work_order.cancelled` emission
 *  - `summarizeSteps(trackedSteps)` — aggregate counts + active-minute sum
 *
 * All pure, no I/O. Same module boundary pattern as `milestoneRules.ts`
 * (Tracking §3.7).
 */

import type { TrackedStep } from "../tracking/trackingTypes.js";
import type { Milestone } from "../tracking/trackingTypes.js";
import type { StepSummary } from "./terminalTypes.js";

// ---------- canComplete ----------

export type CanCompleteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly incompleteStepIds: ReadonlyArray<string>;
    };

/**
 * A work order may complete iff every non-optional step is in the
 * `completed` state. Optional steps do NOT gate completion — a shop can
 * legitimately ship a WO without running every upsell step.
 */
export function canComplete(
  trackedSteps: ReadonlyArray<TrackedStep>
): CanCompleteResult {
  const incomplete = trackedSteps
    .filter((s) => !s.optional && s.state !== "completed")
    .map((s) => s.stepId);

  if (incomplete.length === 0) {
    return { ok: true };
  }
  return { ok: false, incompleteStepIds: incomplete };
}

// ---------- canCancel ----------

/**
 * A work order may be cancelled from any milestone EXCEPT `completed`.
 * Once a WO is done, there's nothing meaningful to cancel — the business
 * action there is a refund / return / rework, not a cancellation.
 *
 * Note that `cancelled` itself isn't a Milestone value (milestones are
 * progress checkpoints for active WOs). The Terminal module's
 * `already_terminal` guard covers the already-cancelled case separately,
 * driven by `currentTerminalState`, not by `currentMilestone`.
 */
export function canCancel(currentMilestone: Milestone): boolean {
  return currentMilestone !== "completed";
}

// ---------- summarizeSteps ----------

/**
 * Aggregate counts + active-minute total. No behavior; just a reducer.
 * Kept separate from `canComplete` so the use case can include the summary
 * in `work_order.cancelled` payloads (which do NOT require canComplete).
 */
export function summarizeSteps(
  trackedSteps: ReadonlyArray<TrackedStep>
): StepSummary {
  let completedRequired = 0;
  let incompleteRequired = 0;
  let completedOptional = 0;
  let skippedOptional = 0;
  let totalActiveMinutes = 0;

  for (const step of trackedSteps) {
    totalActiveMinutes += step.accumulatedActiveMinutes;

    if (step.optional) {
      if (step.state === "completed") {
        completedOptional += 1;
      } else {
        skippedOptional += 1;
      }
    } else {
      if (step.state === "completed") {
        completedRequired += 1;
      } else {
        incompleteRequired += 1;
      }
    }
  }

  return {
    completedRequiredCount: completedRequired,
    incompleteRequiredCount: incompleteRequired,
    completedOptionalCount: completedOptional,
    skippedOptionalCount: skippedOptional,
    totalActiveMinutes,
  };
}
