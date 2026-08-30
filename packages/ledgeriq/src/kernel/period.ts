// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { RiskClass } from "@proworks-hub/contracts";

import type { PeriodState } from "../model/model.js";

// ─────────────────────────────────────────────────────────────────────────────
// The period state machine — blueprint §13.5. Every non-terminal state has at
// least one enumerated exit with its trigger and authorization floor; the one
// terminal state is DECLARED terminal. Property test P-11 fails if the
// implementation acquires a state this table does not know.
// ─────────────────────────────────────────────────────────────────────────────

export interface PeriodTransitionRule {
  readonly from: PeriodState;
  readonly to: PeriodState;
  readonly trigger: string;
  /** The MINIMUM risk class the authorizing decision's envelope must carry. */
  readonly authorizationFloor: RiskClass;
}

export const PERIOD_TRANSITIONS: readonly PeriodTransitionRule[] = [
  { from: "future", to: "open", trigger: "calendar advance or explicit open", authorizationFloor: "elevated" },
  { from: "open", to: "pending-close", trigger: "cut-off reached", authorizationFloor: "elevated" },
  { from: "pending-close", to: "open", trigger: "cut-off reverted before close", authorizationFloor: "elevated" },
  { from: "pending-close", to: "closed", trigger: "close_ledger_period", authorizationFloor: "elevated" },
  { from: "open", to: "closed", trigger: "close_ledger_period", authorizationFloor: "elevated" },
  { from: "closed", to: "open", trigger: "reopen_ledger_period", authorizationFloor: "high" },
  { from: "closed", to: "permanently-closed", trigger: "statutory lock / retention seal", authorizationFloor: "critical" },
];

/** The one terminal state, stated as data so the P-11 test can read it. */
export const TERMINAL_PERIOD_STATES: readonly PeriodState[] = ["permanently-closed"];

export function findTransition(from: PeriodState, to: PeriodState): PeriodTransitionRule | undefined {
  return PERIOD_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

const RISK_ORDER: Readonly<Record<RiskClass, number>> = {
  routine: 0,
  elevated: 1,
  high: 2,
  critical: 3,
};

/** True when `actual` meets or exceeds the floor. */
export function meetsRiskFloor(actual: RiskClass, floor: RiskClass): boolean {
  return RISK_ORDER[actual] >= RISK_ORDER[floor];
}

/**
 * What a period state admits for a given entry type — the period gate's rule
 * table (gate 9). `pending-close` admits ADJUSTING entries only; the caller
 * still needs the elevated decision, which gate 28 verifies.
 */
export function periodAdmitsEntry(state: PeriodState, entryType: string): boolean {
  switch (state) {
    case "open":
      return true;
    case "pending-close":
      return entryType === "adjusting" || entryType === "closing";
    case "future":
    case "closed":
    case "permanently-closed":
      return false;
  }
}
