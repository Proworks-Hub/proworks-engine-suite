// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
} from "@proworks-hub/contracts";

import type { ItemComponent } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { RECEIVABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-3 · application.allocation.v1 — splitting one applied amount across
// components. Specified exactly because a partial payment that splits
// differently between two runs makes a tax sub-ledger untieable.
//
// Largest-remainder method, fully deterministic: floor each proportional
// share, then distribute the residual one minor unit at a time in descending
// order of the fractional part discarded; ties break by componentPriority
// ordinal, then component id. R2 asserts Σ allocated == applied EXACTLY — a
// failed assertion is a refusal, never an unbalanced allocation.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_COMPONENT_PRIORITY = ["line", "tax", "freight", "financeCharge"] as const;

export interface ComponentAllocation {
  readonly componentId: string;
  readonly componentKind: ItemComponent["componentKind"];
  readonly allocated: ExactMoney;
}

export function allocateAcrossComponents(
  applied: ExactMoney,
  components: readonly ItemComponent[],
  mode: "proportional" | "sequential",
  componentPriority: readonly string[] = DEFAULT_COMPONENT_PRIORITY,
): Result<readonly ComponentAllocation[]> {
  const M = RECEIVABLES_METHODS.allocation;
  const appliedUnits = exactMinorUnits(applied);
  const ordered = [...components].sort(
    (a, b) =>
      componentPriority.indexOf(a.componentKind) - componentPriority.indexOf(b.componentKind) ||
      (a.componentId < b.componentId ? -1 : 1),
  );
  const totalUnits = ordered.reduce((acc, c) => acc + exactMinorUnits(c.amount), 0n);
  if (totalUnits === 0n && appliedUnits > 0n) {
    return refuse("allocation-assertion-failed", M, "Σ open components is zero and applied > 0; nothing can be allocated.");
  }

  if (mode === "sequential") {
    let remaining = appliedUnits;
    const out: ComponentAllocation[] = [];
    for (const c of ordered) {
      const cUnits = exactMinorUnits(c.amount);
      const take = remaining < cUnits ? remaining : cUnits;
      out.push({
        componentId: c.componentId,
        componentKind: c.componentKind,
        allocated: exactMoneyFromMinorUnits(take, applied.currency, applied.scale),
      });
      remaining -= take;
      if (remaining === 0n) break;
    }
    return ok(out);
  }

  // Proportional with largest remainder. share_i = applied × open_i / Σ open,
  // floored; remainders ranked by the discarded fraction (numerator of the
  // exact remainder over Σ open).
  const floors: { c: ItemComponent; floorUnits: bigint; remainderNumerator: bigint; ordinal: number }[] =
    ordered.map((c, ordinal) => {
      const numerator = appliedUnits * exactMinorUnits(c.amount);
      return {
        c,
        floorUnits: numerator / totalUnits,
        remainderNumerator: numerator % totalUnits,
        ordinal,
      };
    });
  let residual = appliedUnits - floors.reduce((acc, f) => acc + f.floorUnits, 0n);
  const byRemainder = [...floors].sort(
    (a, b) =>
      (b.remainderNumerator > a.remainderNumerator ? 1 : b.remainderNumerator < a.remainderNumerator ? -1 : 0) ||
      a.ordinal - b.ordinal ||
      (a.c.componentId < b.c.componentId ? -1 : 1),
  );
  const bonus = new Map<string, bigint>();
  for (const f of byRemainder) {
    if (residual === 0n) break;
    bonus.set(f.c.componentId, 1n);
    residual -= 1n;
  }
  const out: ComponentAllocation[] = floors.map((f) => ({
    componentId: f.c.componentId,
    componentKind: f.c.componentKind,
    allocated: exactMoneyFromMinorUnits(
      f.floorUnits + (bonus.get(f.c.componentId) ?? 0n),
      applied.currency,
      applied.scale,
    ),
  }));

  // R2 — the only rounding in the path, asserted exactly. By construction the
  // largest-remainder distribution cannot fail this (residual < component
  // count, fully distributed), so this is a TRIPWIRE against a future edit to
  // the distribution, not a reachable branch today — mutation
  // `R2-assertion-dropped` survives as an equivalent mutant, and that is the
  // honest classification, recorded here rather than gamed.
  const total = out.reduce((acc, a) => acc + exactMinorUnits(a.allocated), 0n);
  if (total !== appliedUnits) {
    return refuse(
      "allocation-assertion-failed",
      M,
      `Σ allocated (${total}) ≠ applied (${appliedUnits}) minor units — the engine refuses rather than emit an unbalanced allocation.`,
    );
  }
  return ok(out);
}
