// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { compareSourceStrength, type MethodRef } from "@proworks-hub/contracts";

import type {
  CloseEvidenceRef,
  EvidenceRequirement,
  SatisfactionVerdict,
  UnmetClause,
} from "../model.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-1 · close.evidence.satisfaction — THE method of this engine, pure.
//
// For each clause: filter to kind; drop below the strength floor (LOCK-2 is
// the arithmetic — ai-candidate ranks below the minimum permitted floor);
// drop older than maxAgeDays against the EXPLICIT asOf; drop attestations
// entirely when the requirement forbids them; drop self-supporting
// control-test evidence (a control test whose population contains the thing
// being completed is not evidence — it is the thing certifying itself).
// The verdict records which evidence satisfied each clause, so satisfaction
// is inspectable rather than a boolean.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const CLOSE_METHODS = {
  evidenceSatisfaction: method("close.evidence.satisfaction"),
  readiness: method("close.readiness.assessment"),
  reconciliationDifference: method("close.reconciliation.difference"),
  autoCertZeroBalance: method("close.autocertification.zero-balance"),
  autoCertNoActivity: method("close.autocertification.no-activity"),
  autoCertWithinThreshold: method("close.autocertification.within-threshold"),
  autoCertAgedItemFree: method("close.autocertification.aged-item-free"),
  riskTier: method("close.risktier.recommendation"),
  cutoff: method("close.cutoff.determination"),
  authorizationHold: method("close.authorization.hold"),
  waiver: method("close.waiver"),
  signoff: method("close.signoff.record"),
  templateInstantiation: method("close.template.instantiation"),
  idempotencyKey: method("close.idempotency.key"),
  registry: method("close.methods.registry"),
} as const satisfies Record<string, MethodRef>;

function daysBetweenIso(a: string, b: string): number {
  const [ay = 0, am = 1, ad = 1] = a.split("-").map(Number);
  const [by = 0, bm = 1, bd = 1] = b.split("-").map(Number);
  return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000;
}

export interface SatisfactionContext {
  /** The task or reconciliation being completed — the acyclicity subject. */
  readonly subjectId: string;
  /** Resolved control-test populations, keyed by evidence target. Absent map = port unbound. */
  readonly controlPopulations?: ReadonlyMap<string, readonly string[]>;
}

export function satisfies(
  requirement: EvidenceRequirement,
  evidence: readonly CloseEvidenceRef[],
  asOf: string,
  context: SatisfactionContext,
): { satisfied: true; verdict: SatisfactionVerdict } | { satisfied: false; unmet: readonly UnmetClause[] } {
  const unmet: UnmetClause[] = [];
  const perClause: { clauseKind: UnmetClause["clauseKind"]; satisfiedBy: string[] }[] = [];

  for (const clause of requirement.clauses) {
    const drops: string[] = [];
    const surviving: string[] = [];
    for (const candidate of evidence) {
      if (candidate.kind !== clause.kind) continue;
      if (candidate.kind === "human-attestation" && !requirement.attestationSufficient) {
        drops.push(`${candidate.evidenceId}: attestation refused (attestationSufficient is false)`);
        continue;
      }
      if (compareSourceStrength(candidate.quality.sourceStrength, clause.minSourceStrength) > 0) {
        drops.push(
          `${candidate.evidenceId}: sourceStrength ${candidate.quality.sourceStrength} ranks below the ${clause.minSourceStrength} floor`,
        );
        continue;
      }
      if (clause.maxAgeDays !== undefined && daysBetweenIso(candidate.observedAt, asOf) > clause.maxAgeDays) {
        drops.push(`${candidate.evidenceId}: observed ${candidate.observedAt}, older than ${clause.maxAgeDays} days at ${asOf}`);
        continue;
      }
      if (candidate.kind === "control-test-result") {
        // Acyclicity: self-supporting evidence is not weak evidence — it is
        // not evidence. Unresolvable population is UNMET, not assumed acyclic.
        if (context.controlPopulations === undefined) {
          drops.push(`${candidate.evidenceId}: ControlCatalogPort unbound — the population cannot be resolved, and an unresolvable population is exactly the condition under which a cycle would be invisible`);
          continue;
        }
        const population = context.controlPopulations.get(candidate.target);
        if (population === undefined) {
          drops.push(`${candidate.evidenceId}: carries no resolvable population reference`);
          continue;
        }
        if (population.includes(context.subjectId)) {
          drops.push(`${candidate.evidenceId}: its population contains ${context.subjectId} — self-supporting evidence is not evidence`);
          continue;
        }
      }
      surviving.push(candidate.evidenceId);
    }
    if (surviving.length < clause.minCount) {
      unmet.push({ clauseKind: clause.kind, needed: clause.minCount, found: surviving.length, drops });
    } else {
      perClause.push({ clauseKind: clause.kind, satisfiedBy: surviving.slice(0, clause.minCount) });
    }
  }

  if (unmet.length > 0) return { satisfied: false, unmet };
  return { satisfied: true, verdict: { perClause } };
}
