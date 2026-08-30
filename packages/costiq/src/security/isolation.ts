/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/security/isolation.ts
 * Module:   cost-iq-engine / security
 * Purpose:  Keeping one tenant's costs out of another's, and out of error text.
 */

import type { CostEvent } from "../ports/costPorts.js";

// ─────────────────────────────────────────────────────────────────────────────
// COST DATA IS COMMERCIALLY SENSITIVE IN A SPECIFIC WAY
//
// It is not personal data, and the instinct that protects personal data does
// not fire for it. But a competitor who learns your unit cost knows your floor
// in every negotiation you will ever have with them, and a customer who learns
// it knows exactly how much margin you are making on them. The damage is
// permanent and there is no way to un-disclose it.
//
// The leaks that actually happen are not break-ins. They are:
//
//   - A cost figure in an exception message, which lands in a shared log.
//   - A tenant id read from a payload rather than from the caller's identity,
//     so a crafted request reads somebody else's model.
//   - A graph traversal that follows a reference across a tenant boundary
//     because nothing checked whether it should.
//   - A metric labelled with a cost, which is then on a dashboard forever.
//
// Each of those is a small piece of code written by somebody being reasonable.
// So the countermeasures here are the boring kind: an explicit tenant scope
// that must be passed, a redactor that runs on the way out, and functions that
// refuse rather than filter.
//
// REFUSE, DO NOT FILTER
//
// When a request touches two tenants, the safe-looking option is to return the
// rows that belong to the caller. It is the wrong one: silently returning three
// of five requested records makes a partial answer look complete, and a cost
// total computed from three of five components is wrong without looking wrong.
// Every function here refuses the whole request instead.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is asking, established by the host from authenticated identity.
 *
 * Never parsed from a request body. A tenant id that arrives in a payload is
 * a tenant id the caller chose, which makes it a request parameter rather
 * than an identity — and reading another tenant's costs then takes one edited
 * field.
 */
export interface TenantScope {
  readonly tenantId: string;
  /** True when this scope came from a test run. Test and production never mix. */
  readonly isTest: boolean;
}

export class TenantIsolationError extends Error {
  readonly code = "TENANT_ISOLATION";
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/**
 * Checks that every record belongs to the caller's tenant.
 *
 * Throws on the first foreign record, naming the count but never the record's
 * contents — an isolation error that quoted the offending row would leak
 * exactly what it exists to protect.
 */
export function assertAllOwned<T extends { readonly tenantId: string; readonly id: string }>(
  scope: TenantScope,
  records: readonly T[],
  what: string,
): readonly T[] {
  const foreign = records.filter((r) => r.tenantId !== scope.tenantId);
  if (foreign.length > 0) {
    throw new TenantIsolationError(
      `${foreign.length} of ${records.length} ${what} do not belong to this tenant. The whole request is refused rather than answered from the ${
        records.length - foreign.length
      } that do — a partial cost is wrong without looking wrong.`,
    );
  }
  return records;
}

/**
 * Checks that a record's test identity matches the caller's.
 *
 * Separate from the tenant check because they fail differently: a tenant
 * mismatch is somebody else's data, while a test/production mismatch is your
 * own data from the wrong universe. The second is more likely and easier to
 * dismiss, which is why it is checked rather than assumed.
 */
export function assertSameRealm<T extends { readonly isTest: boolean }>(
  scope: TenantScope,
  records: readonly T[],
  what: string,
): readonly T[] {
  const wrongRealm = records.filter((r) => r.isTest !== scope.isTest);
  if (wrongRealm.length > 0) {
    throw new TenantIsolationError(
      `${wrongRealm.length} of ${records.length} ${what} are ${scope.isTest ? "production" : "test"} records in a ${
        scope.isTest ? "test" : "production"
      } request. Test and production data never mix, in either direction: test data in a real cost is a wrong number, and real data in a test is a leak.`,
    );
  }
  return records;
}

/** Both checks, in the order that produces the most useful error. */
export function assertAccessible<T extends { readonly tenantId: string; readonly id: string; readonly isTest: boolean }>(
  scope: TenantScope,
  records: readonly T[],
  what: string,
): readonly T[] {
  assertAllOwned(scope, records, what);
  return assertSameRealm(scope, records, what);
}

/** Whether an event may be delivered to a subscriber in a given scope. */
export function eventVisibleTo(scope: TenantScope, event: CostEvent): boolean {
  return event.tenantId === scope.tenantId && event.isTest === scope.isTest;
}

// ─────────────────────────────────────────────────────────────────────────────
// REDACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patterns that look like money or a rate in free text.
 *
 * Deliberately eager. A false positive redacts a version number in an error
 * message, which costs somebody thirty seconds; a false negative puts a unit
 * cost in a shared log, which cannot be undone.
 */
const MONEY_LIKE = /(?:[£$€¥]\s?-?\d[\d,]*(?:\.\d+)?)|(?:-?\d[\d,]*\.\d{2,}\b)/g;

/**
 * Removes anything money-shaped from a string bound for a log or an error.
 *
 * Applied at the boundary rather than at every call site, because the call
 * site that forgets is the one that matters and there is no way to know which
 * one it will be.
 */
export function redactMoney(text: string): string {
  return text.replace(MONEY_LIKE, "[redacted]");
}

/**
 * A message safe to log, given a thrown value.
 *
 * Takes `unknown` because that is what a catch block has. A non-Error is
 * described by its type rather than stringified — stringifying an arbitrary
 * thrown object is how a whole cost model ends up in a log line.
 */
export function safeErrorMessage(thrown: unknown): string {
  if (thrown instanceof Error) return redactMoney(thrown.message);
  return `A non-Error value of type ${typeof thrown} was thrown. Its contents are not logged, because an arbitrary thrown value can carry an entire cost model.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOURCE LIMITS
//
// A cost graph is caller-supplied, and a caller can supply a large one. The
// rollup is iterative rather than recursive so depth does not blow the stack,
// but "does not crash" is not the same as "is safe to accept": a single request
// carrying a million components will occupy a worker for minutes while every
// other tenant waits.
//
// So the limits are explicit, checked before the work starts, and stated in
// the refusal — a caller told "too large" and nothing else cannot fix it.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResourceLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxComponentsPerNode: number;
  /** Longest free-text field accepted, in characters. */
  readonly maxTextLength: number;
  /** Most records one request may load. */
  readonly maxBatchSize: number;
}

/**
 * Limits chosen to be generous for real work and hostile to abuse.
 *
 * 50,000 nodes is far beyond any real bill of materials — the largest genuine
 * one in this project is under 400 — while remaining well inside what the
 * rollup handles in a fraction of a second. The gap between "generous" and
 * "unbounded" is where the protection lives.
 */
export const DEFAULT_LIMITS: ResourceLimits = Object.freeze({
  maxNodes: 50_000,
  maxDepth: 200,
  maxComponentsPerNode: 1_000,
  maxTextLength: 10_000,
  maxBatchSize: 1_000,
});

export class ResourceLimitError extends Error {
  readonly code = "RESOURCE_LIMIT";
  constructor(message: string) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

export function assertWithinLimits(
  measured: { readonly nodes?: number; readonly depth?: number; readonly componentsInLargestNode?: number; readonly batchSize?: number },
  limits: ResourceLimits = DEFAULT_LIMITS,
): void {
  const checks: ReadonlyArray<{ value: number | undefined; limit: number; what: string; advice: string }> = [
    {
      value: measured.nodes,
      limit: limits.maxNodes,
      what: "nodes",
      advice: "Split the model, or roll sub-assemblies up into their own estimates and reference those.",
    },
    {
      value: measured.depth,
      limit: limits.maxDepth,
      what: "levels deep",
      advice: "A bill of materials this deep is usually a cycle that the cycle check did not catch, or a modelling mistake.",
    },
    {
      value: measured.componentsInLargestNode,
      limit: limits.maxComponentsPerNode,
      what: "components on a single node",
      advice: "Group them into sub-assemblies, which also makes the resulting breakdown readable.",
    },
    {
      value: measured.batchSize,
      limit: limits.maxBatchSize,
      what: "records in one request",
      advice: "Page the request.",
    },
  ];

  for (const check of checks) {
    if (check.value !== undefined && check.value > check.limit) {
      throw new ResourceLimitError(
        `This request has ${check.value} ${check.what}, over the limit of ${check.limit}. ${check.advice} The limit exists because one oversized request occupies a worker while every other tenant waits.`,
      );
    }
  }
}

/**
 * Truncates free text to the limit, marking that it was truncated.
 *
 * Truncates rather than refuses, because a caveat that is too long is still a
 * caveat worth keeping most of — unlike a cost graph, where a partial answer
 * is a wrong answer.
 */
export function boundText(text: string, limits: ResourceLimits = DEFAULT_LIMITS): string {
  if (text.length <= limits.maxTextLength) return text;
  return `${text.slice(0, limits.maxTextLength)}… [truncated at ${limits.maxTextLength} characters]`;
}
