// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { SecurityObservation } from "./observation.js";

// ─────────────────────────────────────────────────────────────────────────────
// ForensicsIQ — directive §24/§25 (DEC-028 increment 5).
//
// "ForensicsIQ is analysis. AuditIQ remains authoritative evidence."
//
// So this module builds RECONSTRUCTION PACKAGES: timelines, causal graphs and
// correlations that REFERENCE evidence held by AuditIQ, EventIQ, Fabric and
// host providers. It copies nothing. There is no store here and no ledger —
// §24 forbids a parallel AuditIQ, and the way to not build one is to have
// nowhere to put it.
//
// THE RULES:
//
// 1. EVERY ELEMENT IS A REFERENCE. A reconstruction that inlines evidence
//    becomes a second copy that can drift from, and be trusted over, the
//    authoritative one.
//
// 2. AN UNVERIFIABLE REFERENCE IS MARKED, NEVER DROPPED. If the holder cannot
//    confirm a locator, the element stays in the timeline flagged
//    `verification: "unconfirmed"` — dropping it would edit history to look
//    tidy, which is the one thing forensics must never do.
//
// 3. CAUSALITY IS DECLARED, NOT INFERRED FROM TIME. An edge exists because an
//    observation carries a causationId, not because one thing preceded
//    another. Post-hoc-ergo-propter-hoc in an incident report is how the wrong
//    subject gets blamed.
//
// 4. GAPS ARE FIRST-CLASS. A timeline over a window with sensor gaps says so;
//    a reconstruction that looks complete because nothing was recorded is the
//    same failure as a dashboard reading zero over a broken feed.
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenceVerification = "confirmed" | "unconfirmed" | "integrity-mismatch";

export interface TimelineElement {
  readonly at: string;
  readonly observationId: string;
  readonly subjectRef: string;
  readonly what: string;
  /** Holder + locator, never the evidence. */
  readonly evidenceHolder: string;
  readonly evidenceLocator: string;
  readonly verification: EvidenceVerification;
  /** Declared parent, from the observation's causationId. Never inferred. */
  readonly causedByObservationId: string | null;
}

export interface ReconstructionGap {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly reason: string;
}

export interface ReconstructionPackage {
  readonly packageId: string;
  readonly incidentId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly timeline: readonly TimelineElement[];
  /** Declared causal edges only. */
  readonly causalEdges: readonly { from: string; to: string }[];
  /** Observations whose causationId names something outside this package —
   * a dangling cause is REPORTED, because it points at evidence the
   * reconstruction does not contain. */
  readonly danglingCauses: readonly { observationId: string; missingCauseId: string }[];
  readonly gaps: readonly ReconstructionGap[];
  readonly unconfirmedCount: number;
  readonly integrityMismatchCount: number;
  /** True only when every element verified and no gaps were declared. */
  readonly complete: boolean;
  readonly statement: string;
  /** Named so nobody mistakes this for the ledger. */
  readonly authoritativeEvidenceSystem: "audit-iq";
}

export interface VerificationResult {
  readonly locator: string;
  readonly verification: EvidenceVerification;
}

/**
 * Build a reconstruction. Verification results are SUPPLIED by the holders —
 * Sentinel asks AuditIQ whether a locator resolves; it does not decide.
 */
export function reconstruct(input: {
  readonly packageId: string;
  readonly incidentId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly observations: readonly SecurityObservation[];
  readonly verifications: readonly VerificationResult[];
  readonly gaps: readonly ReconstructionGap[];
}): ReconstructionPackage {
  const verificationByLocator = new Map(input.verifications.map((v) => [v.locator, v.verification]));
  const elements: TimelineElement[] = input.observations
    .map((o): TimelineElement => {
      const evidence = o.evidenceRefs[0];
      const locator = evidence?.locator ?? "";
      return {
        at: o.observedAt,
        observationId: o.observationId,
        subjectRef: o.subject.ref,
        what: o.observationType,
        evidenceHolder: evidence?.holder ?? "none",
        evidenceLocator: locator,
        // Unknown verification is UNCONFIRMED, never assumed good.
        verification: verificationByLocator.get(locator) ?? "unconfirmed",
        causedByObservationId: o.causationId ?? null,
      };
    })
    .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.observationId < b.observationId ? -1 : 1));

  const present = new Set(elements.map((e) => e.observationId));
  const causalEdges: { from: string; to: string }[] = [];
  const danglingCauses: { observationId: string; missingCauseId: string }[] = [];
  for (const element of elements) {
    if (element.causedByObservationId === null) continue;
    if (present.has(element.causedByObservationId)) {
      causalEdges.push({ from: element.causedByObservationId, to: element.observationId });
    } else {
      danglingCauses.push({ observationId: element.observationId, missingCauseId: element.causedByObservationId });
    }
  }
  const unconfirmed = elements.filter((e) => e.verification === "unconfirmed").length;
  const mismatched = elements.filter((e) => e.verification === "integrity-mismatch").length;
  const complete = unconfirmed === 0 && mismatched === 0 && input.gaps.length === 0 && danglingCauses.length === 0;
  return {
    packageId: input.packageId,
    incidentId: input.incidentId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    timeline: elements,
    causalEdges,
    danglingCauses,
    gaps: input.gaps,
    unconfirmedCount: unconfirmed,
    integrityMismatchCount: mismatched,
    complete,
    statement: complete
      ? "every element verified against its holder; no declared gaps; every cause present"
      : `RECONSTRUCTION INCOMPLETE — ${unconfirmed} unconfirmed, ${mismatched} integrity mismatch(es), ${input.gaps.length} declared gap(s), ${danglingCauses.length} dangling cause(s). Absence of an event here is not evidence it did not occur.`,
    authoritativeEvidenceSystem: "audit-iq",
  };
}

/** Walk the declared causal chain back from an element. Returns only
 * DECLARED edges — the chain stops where the declaration stops, rather than
 * continuing on temporal proximity. */
export function causalChain(pkg: ReconstructionPackage, observationId: string): readonly string[] {
  const parentOf = new Map(pkg.causalEdges.map((e) => [e.to, e.from]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = observationId;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = parentOf.get(cursor);
  }
  return chain.reverse();
}

/** §13/§24: preserve before destructive cleanup. Returns the preservation
 * order — what must be captured, and in what sequence, before anything is
 * destroyed. Volatile first, because it is what disappears. */
export function preservationOrder(pkg: ReconstructionPackage): readonly { step: number; holder: string; locators: readonly string[] }[] {
  const volatility: Record<string, number> = { fabric: 0, "host-provider": 1, "event-iq": 2, "sentinel-forensics": 3, "audit-iq": 4, external: 5, none: 6 };
  const byHolder = new Map<string, string[]>();
  for (const element of pkg.timeline) {
    if (element.evidenceLocator === "") continue;
    const list = byHolder.get(element.evidenceHolder) ?? [];
    list.push(element.evidenceLocator);
    byHolder.set(element.evidenceHolder, list);
  }
  return [...byHolder.entries()]
    .sort(([a], [b]) => (volatility[a] ?? 9) - (volatility[b] ?? 9))
    .map(([holder, locators], index) => ({ step: index + 1, holder, locators: [...new Set(locators)].sort() }));
}
