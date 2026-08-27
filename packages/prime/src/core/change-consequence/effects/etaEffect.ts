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
 * Change-order consequence — ETA effect.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §3.2 step 3.
 *
 * Recomputes ETA on every approved change but only emits
 * `work_order.eta.recalculated` when the difference from the previous ETA
 * exceeds a configurable epsilon (default: 60 seconds). This prevents noise
 * for spec tweaks that don't meaningfully shift the schedule.
 *
 * Pure function — the engine composes and appends.
 */

import type { ChangeOrder } from "../../change/changeOrderTypes.js";
import type { ChangeConsequenceHints } from "./routingEffect.js";

export interface EtaRecalculatedPayload {
  readonly changeOrderId: string;
  readonly previousEtaIso: string;
  readonly newEtaIso: string;
  readonly deltaMs: number;
}

export type EtaEffectDecision =
  | { readonly applies: false; readonly reason: "no_new_eta" | "below_epsilon" }
  | { readonly applies: true; readonly payload: EtaRecalculatedPayload };

const DEFAULT_EPSILON_MS = 60_000;

export function evaluateEtaEffect(
  changeOrder: ChangeOrder,
  hints?: ChangeConsequenceHints
): EtaEffectDecision {
  if (!hints?.newEtaIso || !hints?.previousEtaIso) {
    return { applies: false, reason: "no_new_eta" };
  }

  const prev = Date.parse(hints.previousEtaIso);
  const next = Date.parse(hints.newEtaIso);
  if (Number.isNaN(prev) || Number.isNaN(next)) {
    return { applies: false, reason: "no_new_eta" };
  }

  const delta = next - prev;
  const absDelta = Math.abs(delta);
  const epsilon = hints.etaEpsilonMs ?? DEFAULT_EPSILON_MS;

  if (absDelta < epsilon) {
    return { applies: false, reason: "below_epsilon" };
  }

  return {
    applies: true,
    payload: {
      changeOrderId: changeOrder.id,
      previousEtaIso: hints.previousEtaIso,
      newEtaIso: hints.newEtaIso,
      deltaMs: delta,
    },
  };
}
