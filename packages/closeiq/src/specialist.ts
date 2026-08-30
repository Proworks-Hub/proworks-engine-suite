// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import type { CallContext, CloseEngine } from "./engine.js";
import { CLOSE_METHODS } from "./kernel/evidence.js";
import { refuse } from "./refusals.js";

// ─────────────────────────────────────────────────────────────────────────────
// Capability names — §19, with the SR-2 resolution APPLIED: CloseIQ's own
// package offered to concede `close_period` ("conceding a name it does not
// need costs nothing; both engines keeping a near-name costs a silently
// mis-resolved capability") and proposed `assess_close_readiness` +
// `request_period_close` as the disambiguating pair. That offer is adopted:
// nobody claims bare `close_period`; LedgerIQ holds the period STATE via
// `close_ledger_period`; CloseIQ's rung on that operation is REQUEST.
// Recorded in FINANCE-ENGINE-PROGRAM.md as the SR-2 outcome.
// ─────────────────────────────────────────────────────────────────────────────

export const CLOSE_CAPABILITIES = [
  "assess_close_readiness",
  "request_period_close",
  "reconcile_account",
  "record_close_signoff",
  "propose_close_adjustment",
  "list_close_exceptions",
] as const;

export type CloseCapability = (typeof CLOSE_CAPABILITIES)[number];

export function createCloseSpecialist(engine: CloseEngine): Specialist<CloseCapability> {
  return {
    id: "closeiq",
    capabilities: [...CLOSE_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const { ctx, ...input } = request.input as { ctx: CallContext } & Record<string, unknown>;
      if (!ctx || !ctx.asOf) {
        return refuse(
          "wrong-state",
          CLOSE_METHODS.registry,
          "Every CloseIQ call carries a CallContext with an explicit asOf. There is no now().",
        );
      }
      switch (request.capability) {
        case "assess_close_readiness":
          return engine.assessReadiness(input as unknown as Parameters<CloseEngine["assessReadiness"]>[0], ctx);
        case "request_period_close":
          return engine.requestPeriodClose(
            input as unknown as Parameters<CloseEngine["requestPeriodClose"]>[0],
            ctx,
          );
        case "reconcile_account":
          return engine.computeReconciliation(
            input as unknown as Parameters<CloseEngine["computeReconciliation"]>[0],
            ctx,
          );
        case "record_close_signoff":
          return engine.recordSignOff(input as unknown as Parameters<CloseEngine["recordSignOff"]>[0], ctx);
        case "propose_close_adjustment":
          return engine.transitionAdjustment(
            input as unknown as Parameters<CloseEngine["transitionAdjustment"]>[0],
            ctx,
          );
        case "list_close_exceptions":
          // The exception workflow is a later wave; an unbuilt list refuses
          // honestly rather than returning an empty array a caller would read
          // as "no exceptions".
          return refuse(
            "wrong-state",
            CLOSE_METHODS.registry,
            "The exception workflow is not built in this wave. An empty list would read as 'no exceptions', which is not known.",
          );
        default: {
          const unknown: never = request.capability;
          return refuse("wrong-state", CLOSE_METHODS.registry, `CloseIQ does not answer "${String(unknown)}".`);
        }
      }
    },
    async health() {
      return { healthy: true, detail: "Kernel available." };
    },
  };
}
