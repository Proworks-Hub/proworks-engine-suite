// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// The operations that may never be performed asynchronously.
//
// Each one is a question about PERMISSION, and a question about permission has
// exactly one safe shape: ask, wait, and act on the answer. Publishing "may I
// promote this?" onto a bus and continuing is not asking. It is acting, with a
// note attached.
//
// The failure is quiet, which is why this list is enforced rather than
// documented. An asynchronous authorization request looks correct in a diagram
// and correct in a log; the only thing wrong with it is that the work happened
// before the answer arrived, and nothing in the trace says so.
//
// WHY THIS LIVES IN CONTRACTS
//
// It was in foundry-evolutioniq, which is where it was first needed. But it is
// not a fact about Foundry — it is a fact about the Hive, and Prime has to
// enforce it too. The alternatives were both worse: Prime importing Foundry
// couples orchestration to evolution for the sake of eight strings, and copying
// the list gives the Hive two sources of truth that will disagree the first
// time one is extended. Foundry re-exports it, so every existing caller is
// unchanged.
//
// The same resolution Wave B used for identifier types and Wave I used for
// delivery types: when two tiers need one fact, the fact belongs underneath
// both of them.
// ─────────────────────────────────────────────────────────────────────────────

export const SYNCHRONOUS_ONLY = [
  /** Whether a lease permits an action. A stale yes is worse than a slow one. */
  "leasePermits",
  /** Whether a change is inside its mission's scope. */
  "changeWithinScope",
  /** Whether the work passes its validators. */
  "validate",
  /** Moving a change to an environment. */
  "promote",
  /** Sentinel's independent watch over a running agent. */
  "supervise",
  /** Governance saying yes or no. */
  "authorize",
  /** Admitting a mission to run. */
  "admit",
  /** Deciding how material a change is. */
  "classifyChange",
] as const;

export type SynchronousOnlyOperation = (typeof SYNCHRONOUS_ONLY)[number];

/**
 * Whether an operation may be performed asynchronously.
 *
 * Always false for anything in {@link SYNCHRONOUS_ONLY}. Written as a function
 * rather than left to callers comparing strings, because a caller who forgets
 * gets a permissive default, and this is the one place a permissive default is
 * the whole bug.
 */
export function mayBePerformedAsynchronously(operation: string): boolean {
  return !(SYNCHRONOUS_ONLY as readonly string[]).includes(operation);
}

/**
 * Whether a named operation is one of the synchronous-only eight.
 *
 * The narrowing half of the same question. Callers that need the type, rather
 * than the permission, use this.
 */
export function isSynchronousOnly(operation: string): operation is SynchronousOnlyOperation {
  return (SYNCHRONOUS_ONLY as readonly string[]).includes(operation);
}
