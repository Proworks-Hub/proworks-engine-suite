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
 * Change-order consequence — Routing effect.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §3.2 step 1.
 *
 * Decides whether an approved change order invalidates the current route and,
 * if so, produces a `RoutingRecomputedEffect` describing what the caller should
 * re-plan. The module is **pure**: it never writes to the event log directly.
 * Emission is the engine's job (`changeConsequenceEngine`) so the full cascade
 * envelope (`change.applied`) can reference the effect events by id.
 *
 * A change is considered routing-invalidating when its `kind` is one of
 *   - `modify_spec`      (spec change may need a different machine / station)
 *   - `add_item`         (new line-item may add a new step requiring routing)
 *   - `remove_item`      (removed item may prune steps)
 *   - `change_quantity`  (quantity scale may change workstation class / batching)
 *
 * `expedite` does NOT by itself invalidate routing — it just escalates
 * priority — unless the caller passes `hints.forceRoutingRecompute = true`.
 */

import type { ChangeOrder } from "../../change/changeOrderTypes";
import type { WorkOrderStepId } from "../../../models/events";

export interface ChangeConsequenceHints {
  /** If true, routing is always treated as invalidated regardless of kind. */
  readonly forceRoutingRecompute?: boolean;
  /**
   * If true, the caller has already determined tasks must regenerate. The
   * tasksEffect will emit regardless of its own heuristics.
   */
  readonly forceTasksRegenerate?: boolean;
  /**
   * Explicit list of step ids that should be regenerated. When provided, the
   * tasksEffect treats regeneration as required and carries the list on the
   * emitted payload.
   */
  readonly invalidatedStepIds?: ReadonlyArray<WorkOrderStepId>;
  /**
   * New ETA after applying the change. When absent, the etaEffect passes
   * through the previous ETA and no event is emitted.
   */
  readonly newEtaIso?: string;
  /**
   * Previous ETA — the engine defaults this to the caller-supplied value
   * when the etaEffect fires. Required to know whether the delta exceeds
   * the epsilon.
   */
  readonly previousEtaIso?: string;
  /**
   * Minimum absolute ETA delta (milliseconds) that should fire an
   * `eta.recalculated` event. Defaults to 60_000 (1 minute).
   */
  readonly etaEpsilonMs?: number;
}

export interface RoutingRecomputedPayload {
  readonly changeOrderId: string;
  readonly reasonKind: ChangeOrder["kind"];
  readonly forced: boolean;
}

export type RoutingEffectDecision =
  | { readonly applies: false }
  | { readonly applies: true; readonly payload: RoutingRecomputedPayload };

export function evaluateRoutingEffect(
  changeOrder: ChangeOrder,
  hints?: ChangeConsequenceHints
): RoutingEffectDecision {
  const forced = hints?.forceRoutingRecompute === true;
  const kind = changeOrder.kind;
  const kindInvalidates =
    kind === "modify_spec" ||
    kind === "add_item" ||
    kind === "remove_item" ||
    kind === "change_quantity";

  if (!forced && !kindInvalidates) {
    return { applies: false };
  }

  return {
    applies: true,
    payload: {
      changeOrderId: changeOrder.id,
      reasonKind: kind,
      forced,
    },
  };
}
