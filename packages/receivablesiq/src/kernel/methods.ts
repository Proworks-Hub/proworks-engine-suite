// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

import type { AgingPolicy } from "../model.js";

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

/** §16 — every consequential rule, versioned. A result-changing modification requires a new version. */
export const RECEIVABLES_METHODS = {
  intake: method("receivable.intake"),
  discount: method("application.discount"),
  allocation: method("application.allocation"),
  matchingCascade: method("matching.cascade"),
  shortpayClassification: method("shortpay.classification"),
  residualVsPartial: method("shortpay.residual-vs-partial"),
  applicationFx: method("application.fx"),
  agingPolicy: method("aging.policy"),
  dsoSimple: method("dso.simple"),
  dsoCountback: method("dso.countback"),
  dsoBestPossible: method("dso.best-possible"),
  add: method("add"),
  cei: method("cei"),
  projection: method("projection.replay"),
  registry: method("methods.registry"),
} as const satisfies Record<string, MethodRef>;

export interface PolicyRejection {
  readonly rule: string;
  readonly detail: string;
}

/**
 * Aging-policy validation ON LOAD — a policy that fails is refused, not
 * repaired. A gap means an item silently vanishes from a total.
 */
export function validateAgingPolicy(policy: AgingPolicy): PolicyRejection | undefined {
  const buckets = policy.buckets;
  if (buckets.length === 0) return { rule: "buckets", detail: "A policy needs at least one bucket." };
  const first = buckets[0];
  if (first && first.fromDays !== 0) {
    return { rule: "coverage", detail: `The first bucket starts at ${first.fromDays}, not 0.` };
  }
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (!bucket) continue;
    if (bucket.toDays <= bucket.fromDays) {
      return { rule: "buckets", detail: `Bucket "${bucket.name}" is empty or inverted.` };
    }
    const next = buckets[i + 1];
    if (next && next.fromDays !== bucket.toDays) {
      return {
        rule: "coverage",
        detail: `Gap or overlap between "${bucket.name}" and "${next.name}".`,
      };
    }
  }
  const last = buckets[buckets.length - 1];
  if (last && last.toDays !== Number.MAX_SAFE_INTEGER) {
    return {
      rule: "coverage",
      detail: `The last bucket "${last.name}" ends at ${last.toDays}; older items would vanish.`,
    };
  }
  return undefined;
}
