// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { exactMinorUnits } from "@proworks-hub/contracts";

import type { CashReceipt, MatchPolicy, OpenItem } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { RECEIVABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-4 · matching.cascade.v1 — the deterministic matcher ladder. The FIRST
// matcher that returns a unique solution wins; ANY matcher returning more
// than one solution STOPS the cascade and refuses. That last clause is the
// whole design: an ambiguous match auto-resolved by preference is a guess
// that will be reversed at month end.
//
// M4.7 (AI candidate) is deliberately not here: an AI matcher NEVER applies —
// it may only emit a candidate for human acceptance, and that path is not
// built in this wave.
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchSolution {
  readonly matcher: "exact-reference" | "secondary-reference" | "exact-amount" | "subset-sum" | "policy-ordered";
  readonly openItemIds: readonly string[];
}

export function matchCascade(
  receipt: CashReceipt,
  candidates: readonly OpenItem[],
  policy: MatchPolicy,
): Result<MatchSolution> {
  const M = RECEIVABLES_METHODS.matchingCascade;
  if (receipt.customerRef === undefined) {
    return refuse("unidentified-customer", M, "The payer is not resolved to a customer; the engine never guesses.");
  }
  const open = candidates.filter(
    (i) =>
      i.customerRef === receipt.customerRef &&
      (i.state === "open" || i.state === "partially-applied") &&
      i.sign === "debit" &&
      i.openAmount.currency === receipt.amount.currency,
  );

  // M4.1 exact-reference: a remittance reference equals an item's documentRef.
  const byReference = open.filter((i) => receipt.remittanceRefs.includes(i.documentRef));
  if (byReference.length === 1) {
    const first = byReference[0];
    if (first) return ok({ matcher: "exact-reference", openItemIds: [first.openItemId] });
  }
  if (byReference.length > 1) {
    return refuse(
      "ambiguous-match",
      M,
      `Remittance references resolve to ${byReference.length} items: ${byReference.map((i) => i.openItemId).join(", ")}.`,
    );
  }

  // M4.4 exact-amount: exactly one open item equals the receipt amount.
  const receiptUnits = exactMinorUnits(receipt.unappliedAmount);
  const byAmount = open.filter((i) => exactMinorUnits(i.openAmount) === receiptUnits);
  if (byAmount.length === 1) {
    const first = byAmount[0];
    if (first) return ok({ matcher: "exact-amount", openItemIds: [first.openItemId] });
  }
  if (byAmount.length > 1) {
    return refuse(
      "ambiguous-match",
      M,
      `${byAmount.length} items equal the receipt amount; ties refuse rather than pick.`,
    );
  }

  // M4.5 bounded subset-sum: unique-or-refuse, hard candidate and node budget.
  if (open.length > policy.maxCandidates) {
    return refuse(
      "budget-exceeded",
      M,
      `${open.length} candidates exceed the policy bound of ${policy.maxCandidates}; the search refuses rather than truncates.`,
    );
  }
  const solutions: string[][] = [];
  let nodesVisited = 0;
  const nodeBudget = 1 << 18;
  const sorted = [...open].sort((a, b) => (a.openItemId < b.openItemId ? -1 : 1));
  const search = (index: number, remaining: bigint, chosen: string[]): boolean => {
    nodesVisited++;
    if (nodesVisited > nodeBudget) return false;
    if (remaining === 0n && chosen.length > 0) {
      solutions.push([...chosen]);
      return solutions.length <= 2;
    }
    if (index >= sorted.length || remaining < 0n) return true;
    const item = sorted[index];
    if (!item) return true;
    chosen.push(item.openItemId);
    if (!search(index + 1, remaining - exactMinorUnits(item.openAmount), chosen)) return false;
    chosen.pop();
    return search(index + 1, remaining, chosen);
  };
  const withinBudget = search(0, receiptUnits, []);
  if (!withinBudget && solutions.length < 2) {
    return refuse("budget-exceeded", M, "The subset search exceeded its node budget; refused, not truncated.");
  }
  if (solutions.length === 1) {
    const only = solutions[0];
    if (only) return ok({ matcher: "subset-sum", openItemIds: only });
  }
  if (solutions.length >= 2) {
    return refuse(
      "ambiguous-match",
      M,
      `Two or more subsets sum to the receipt amount: [${solutions.map((s) => s.join("+")).join("] and [")}].`,
    );
  }

  // M4.6 policy-ordered: oldest-first consumption — ONLY when the customer's
  // policy explicitly authorizes it, because it is a guess dressed as a rule.
  if (policy.policyOrderedAuthorized && open.length > 0) {
    const ordered = [...open].sort(
      (a, b) =>
        (a.dueDate ?? a.documentDate).localeCompare(b.dueDate ?? b.documentDate) ||
        (a.openItemId < b.openItemId ? -1 : 1),
    );
    const chosen: string[] = [];
    let remaining = receiptUnits;
    for (const item of ordered) {
      if (remaining <= 0n) break;
      chosen.push(item.openItemId);
      remaining -= exactMinorUnits(item.openAmount);
    }
    if (chosen.length > 0) return ok({ matcher: "policy-ordered", openItemIds: chosen });
  }

  return refuse("no-candidate", M, "No matcher produced a unique solution and policy-ordered consumption is not authorized.");
}
