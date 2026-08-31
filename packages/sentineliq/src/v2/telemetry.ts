// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel V2 §3/§9/§11 privacy + telemetry minimization, the Collective
// promotion gate, and the §16 scorecard.
//
// §11, absolute: "Never log private keys, bearer secrets, raw credentials or
// decrypted protected payloads in Sentinel telemetry." Implemented as a gate
// that REFUSES the record rather than redacting-and-hoping: a telemetry
// record that trips the secret screen is not emitted with holes, it is
// rejected with the field named, because a redaction pipeline that silently
// passes what it failed to match is a false validator.
//
// §3/§9: tenant-private incidents, PHI, credentials and raw logs remain
// LOCAL; only approved generalized threat patterns are promoted to the
// Collective, and never by default.
// ─────────────────────────────────────────────────────────────────────────────

// ── Secret screening — refuse, never emit-with-holes ────────────────────────

const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}/ },
  { name: "aws-style-secret", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "password-assignment", pattern: /\b(password|passwd|pwd)\s*[:=]\s*\S+/i },
  { name: "generic-api-key", pattern: /\b(api[-_]?key|secret[-_]?key|client[-_]?secret)\s*[:=]\s*\S+/i },
];

export type TelemetryScreenOutcome =
  | { readonly emit: true }
  | { readonly emit: false; readonly refusedFields: readonly { field: string; matchedRule: string }[] };

export function screenTelemetry(record: Readonly<Record<string, string>>): TelemetryScreenOutcome {
  const refused: { field: string; matchedRule: string }[] = [];
  for (const [field, value] of Object.entries(record)) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        refused.push({ field, matchedRule: name });
        break;
      }
    }
  }
  return refused.length > 0 ? { emit: false, refusedFields: refused } : { emit: true };
}

// ── Collective promotion — generalized, authorized, never by default ────────

export interface PromotionCandidate {
  readonly candidateRef: string;
  readonly contentKind: "generalized-threat-pattern" | "raw-incident" | "raw-log" | "phi" | "credentials";
  /** True only when tenant identifiers, hosts, principals and payload
   * fragments have been stripped — asserted by the generalizer, checked here. */
  readonly tenantIdentifiersStripped: boolean;
  readonly authorizationRef: string | null;
}

export type PromotionVerdict =
  | { readonly promoted: true; readonly candidateRef: string }
  | { readonly promoted: false; readonly reason: string };

export function promoteToCollective(candidate: PromotionCandidate): PromotionVerdict {
  if (candidate.contentKind !== "generalized-threat-pattern") {
    // §21.12: Collective threat learning cannot exfiltrate raw private
    // incident content. Not with authorization, not at all through this path.
    return { promoted: false, reason: `${candidate.contentKind} is never promoted to the Collective; only generalized threat patterns are.` };
  }
  if (!candidate.tenantIdentifiersStripped) {
    return { promoted: false, reason: "Generalization incomplete: tenant identifiers present." };
  }
  if (candidate.authorizationRef === null) {
    // Never by default — an approved pattern still needs an explicit
    // promotion authorization.
    return { promoted: false, reason: "Promotion is explicitly authorized, never default." };
  }
  return { promoted: true, candidateRef: candidate.candidateRef };
}

// ── §16 · the scorecard — unevidenced dimensions never score ────────────────

export const SCORECARD_DIMENSIONS = [
  { dimension: "threat-detection-coverage", weight: 15 },
  { dimension: "zero-trust-identity-assurance", weight: 10 },
  { dimension: "integrity-supply-chain-assurance", weight: 10 },
  { dimension: "containment-incident-response", weight: 10 },
  { dimension: "security-resilience", weight: 10 },
  { dimension: "privacy-data-minimization", weight: 10 },
  { dimension: "governance-constitutional-assurance", weight: 10 },
  { dimension: "host-interoperability", weight: 10 },
  { dimension: "observability-explainability", weight: 5 },
  { dimension: "performance-scalability", weight: 5 },
  { dimension: "continuous-benchmark-evolution", weight: 5 },
] as const;

export interface DimensionEvidence {
  readonly dimension: string;
  readonly scorePermille: number; // 0..1000, from measured evidence
  readonly evidenceRefs: readonly string[];
}

export interface Scorecard {
  readonly scoredWeight: number;
  readonly totalWeight: number;
  readonly weightedScorePermille: number | null; // null when nothing is evidenced
  readonly unevidencedDimensions: readonly string[];
  /** The unevidenced share is VISIBLE — a scorecard over 40% of the weights
   * is a scorecard over 40% of the weights, not a smaller success. */
  readonly coverageStatement: string;
}

export function computeScorecard(evidence: readonly DimensionEvidence[]): Scorecard {
  const byDimension = new Map(evidence.filter((e) => e.evidenceRefs.length > 0).map((e) => [e.dimension, e]));
  let scoredWeight = 0;
  let weightedSum = 0;
  const unevidenced: string[] = [];
  for (const { dimension, weight } of SCORECARD_DIMENSIONS) {
    const row = byDimension.get(dimension);
    if (row === undefined) {
      // Never scored as passing, never scored as zero-and-averaged-in:
      // excluded from the numerator AND the denominator, and NAMED.
      unevidenced.push(dimension);
      continue;
    }
    scoredWeight += weight;
    weightedSum += weight * Math.max(0, Math.min(1000, row.scorePermille));
  }
  const totalWeight = SCORECARD_DIMENSIONS.reduce((a, d) => a + d.weight, 0);
  return {
    scoredWeight,
    totalWeight,
    weightedScorePermille: scoredWeight === 0 ? null : Math.floor(weightedSum / scoredWeight),
    unevidencedDimensions: unevidenced,
    coverageStatement:
      scoredWeight === totalWeight
        ? "all dimensions evidenced"
        : `scored over ${scoredWeight} of ${totalWeight} weight; unevidenced: ${unevidenced.join(", ") || "none"}`,
  };
}
