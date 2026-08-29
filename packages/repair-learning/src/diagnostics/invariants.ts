// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { Evidence } from "../evidence/evidence.js";

// ─────────────────────────────────────────────────────────────────────────────
// The invariant violation classifier.
//
// Directive §8: "Each run may violate zero, one, or multiple invariants...
// Do not mark an invariant violation merely because a test title suggests one.
// Use evidence."
//
// That sentence is the whole design. The corpus hands every scenario a list of
// invariants, and the tempting implementation is to copy that list onto the run
// and call them violations. It would produce a beautifully populated database
// of constitutional breaches that nobody observed — including 160 of them
// across the 80 happy-path scenarios where the corpus says nothing goes wrong.
//
// So a violation here requires a DETECTOR that looked at evidence and a
// reference to the evidence it looked at. An invariant with no detector reports
// NOT_ASSESSED, which is a third state and the honest one: not "held", not
// "violated", but "nothing here can tell".
//
// THE CATALOG IS NOT CANONICAL AND SAYS SO
//
// Every entry in `corpus/invariant-catalog.v2.json` carries
// `status: PROPOSED_CANONICAL_REFERENCE` and the note "must be reconciled with
// authoritative Hive invariant catalog when available". That status is carried
// through into every verdict rather than quietly dropped, because a violation
// of a proposed invariant is a weaker claim than a violation of a ratified one
// and the difference matters to whoever acts on it.
// ─────────────────────────────────────────────────────────────────────────────

export const invariantCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    validationType: z.string().min(1),
    /** PROPOSED_CANONICAL_REFERENCE for the whole V2 catalog. */
    status: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();
export type InvariantCatalogEntry = z.infer<typeof invariantCatalogEntrySchema>;

/**
 * The three possible verdicts on an invariant.
 *
 * NOT_ASSESSED is the important one. Without it every unassessed invariant
 * silently becomes "held", and a run that checked nothing reports a clean bill
 * of constitutional health.
 */
export const invariantVerdictSchema = z.enum(["HELD", "VIOLATED", "NOT_ASSESSED"]);
export type InvariantVerdict = z.infer<typeof invariantVerdictSchema>;

export interface InvariantAssessment {
  readonly invariantId: string;
  readonly verdict: InvariantVerdict;
  /** Which detector decided, or why nothing could. */
  readonly decidedBy: string;
  /** Evidence the detector actually read. Empty only for NOT_ASSESSED. */
  readonly evidenceIds: readonly string[];
  /** Confidence in the verdict. Absent for NOT_ASSESSED. */
  readonly confidence?: "suspected" | "probable" | "confirmed";
  readonly detail: string;
  /**
   * The catalog status of the invariant at the time of assessment.
   *
   * Carried so a downstream consumer knows whether this is a violation of a
   * ratified rule or of a proposal.
   */
  readonly catalogStatus: string;
}

/**
 * Something that can decide one invariant from evidence.
 *
 * Returns null when it cannot decide — which is different from deciding HELD.
 * A detector that returns HELD when it found nothing is worse than no detector,
 * because it converts absence of evidence into evidence of compliance.
 */
export interface InvariantDetector {
  readonly invariantId: string;
  readonly name: string;
  detect(evidence: readonly Evidence[]): {
    verdict: "HELD" | "VIOLATED";
    evidenceIds: readonly string[];
    confidence: "suspected" | "probable" | "confirmed";
    detail: string;
  } | null;
}

export interface InvariantClassifier {
  /**
   * Assesses invariants against evidence.
   *
   * `candidates` is what to LOOK at — typically the scenario's
   * `invariantsAtRisk`. It is a list of questions, never a list of answers.
   */
  assess(candidates: readonly string[], evidence: readonly Evidence[]): readonly InvariantAssessment[];
  /** Only the violations, for callers that want the finding rather than the sweep. */
  violations(candidates: readonly string[], evidence: readonly Evidence[]): readonly InvariantAssessment[];
  readonly detectorCount: number;
}

export function createInvariantClassifier(input: {
  catalog: readonly InvariantCatalogEntry[];
  detectors: readonly InvariantDetector[];
}): InvariantClassifier {
  const catalogById = new Map(input.catalog.map((e) => [e.id, e]));
  const detectorsById = new Map<string, InvariantDetector[]>();
  for (const detector of input.detectors) {
    const list = detectorsById.get(detector.invariantId) ?? [];
    list.push(detector);
    detectorsById.set(detector.invariantId, list);
  }

  const assess = (
    candidates: readonly string[],
    evidence: readonly Evidence[],
  ): InvariantAssessment[] =>
    candidates.map((invariantId) => {
      const catalogStatus = catalogById.get(invariantId)?.status ?? "NOT_IN_CATALOG";
      const detectors = detectorsById.get(invariantId) ?? [];

      if (detectors.length === 0) {
        return {
          invariantId,
          verdict: "NOT_ASSESSED",
          decidedBy: "<none>",
          evidenceIds: [],
          detail:
            `No detector implements ${invariantId}, so nothing here can say whether it held. ` +
            "Recorded as unassessed rather than held — an unchecked invariant is not a satisfied one.",
          catalogStatus,
        };
      }

      // A violation found by ANY detector stands. Invariants are one-sided:
      // one detector finding a breach outweighs another finding nothing, since
      // the second may simply have been looking elsewhere.
      for (const detector of detectors) {
        const result = detector.detect(evidence);
        if (result?.verdict === "VIOLATED") {
          return {
            invariantId,
            verdict: "VIOLATED",
            decidedBy: detector.name,
            evidenceIds: result.evidenceIds,
            confidence: result.confidence,
            detail: result.detail,
            catalogStatus,
          };
        }
      }

      const holds = detectors
        .map((d) => ({ detector: d, result: d.detect(evidence) }))
        .filter((r) => r.result !== null);

      if (holds.length === 0) {
        return {
          invariantId,
          verdict: "NOT_ASSESSED",
          decidedBy: detectors.map((d) => d.name).join(", "),
          evidenceIds: [],
          detail:
            `${detectors.length} detector(s) for ${invariantId} looked and could not decide from the evidence available. ` +
            "Undecided is not held.",
          catalogStatus,
        };
      }

      const first = holds[0]!;
      return {
        invariantId,
        verdict: "HELD",
        decidedBy: first.detector.name,
        evidenceIds: first.result!.evidenceIds,
        confidence: first.result!.confidence,
        detail: first.result!.detail,
        catalogStatus,
      };
    });

  return {
    assess,
    violations: (candidates, evidence) => assess(candidates, evidence).filter((a) => a.verdict === "VIOLATED"),
    detectorCount: input.detectors.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detectors that can be written honestly from evidence facts alone.
//
// Each reads flat, non-sensitive scalars an executor recorded, and each returns
// null when the relevant fact is absent. None of them infers a violation from a
// scenario's annotation, a test title, or a fault class.
// ─────────────────────────────────────────────────────────────────────────────

/** Evidence carrying a specific boolean fact. */
function withFact(evidence: readonly Evidence[], fact: string) {
  return evidence.filter((e) => typeof e.facts[fact] === "boolean");
}

/**
 * HIVE-INV-CORRELATION-001 — correlation survives the hop.
 *
 * Decidable from evidence alone: every piece of evidence in one run should
 * carry the same correlation id. Disagreement is a broken trace, and that is
 * observable without knowing anything about the domain.
 */
export const correlationDetector: InvariantDetector = {
  invariantId: "HIVE-INV-CORRELATION-001",
  name: "correlation-continuity",
  detect(evidence) {
    const correlations = evidence
      .map((e) => e.facts.correlationId)
      .filter((v): v is string => typeof v === "string");

    if (correlations.length < 2) return null;

    const distinct = [...new Set(correlations)];
    if (distinct.length === 1) {
      return {
        verdict: "HELD",
        evidenceIds: evidence.map((e) => e.evidenceId),
        confidence: "confirmed",
        detail: `All ${correlations.length} evidence records share correlation ${distinct[0]}.`,
      };
    }

    return {
      verdict: "VIOLATED",
      evidenceIds: evidence
        .filter((e) => typeof e.facts.correlationId === "string")
        .map((e) => e.evidenceId),
      confidence: "confirmed",
      detail: `Trace split across ${distinct.length} correlation ids: ${distinct.join(", ")}. One workflow cannot be reconstructed.`,
    };
  },
};

/**
 * HIVE-INV-TENANT-001 — tenant isolation.
 *
 * Two tenants appearing in one execution's evidence is a boundary crossing,
 * observable without domain knowledge.
 */
export const tenantIsolationDetector: InvariantDetector = {
  invariantId: "HIVE-INV-TENANT-001",
  name: "tenant-boundary",
  detect(evidence) {
    const tenants = evidence
      .map((e) => e.facts.tenantId)
      .filter((v): v is string => typeof v === "string");

    if (tenants.length === 0) return null;

    const distinct = [...new Set(tenants)];
    if (distinct.length === 1) {
      return {
        verdict: "HELD",
        evidenceIds: evidence.filter((e) => typeof e.facts.tenantId === "string").map((e) => e.evidenceId),
        confidence: "confirmed",
        detail: `All evidence is scoped to tenant ${distinct[0]}.`,
      };
    }

    return {
      verdict: "VIOLATED",
      evidenceIds: evidence.filter((e) => typeof e.facts.tenantId === "string").map((e) => e.evidenceId),
      confidence: "confirmed",
      detail: `Evidence spans ${distinct.length} tenants (${distinct.join(", ")}) within one execution.`,
    };
  },
};

/**
 * HIVE-INV-IDEMPOTENCY-001 — a repeated delivery does not repeat the effect.
 *
 * Needs the executor to record `duplicateDelivered` and `duplicateSuppressed`.
 * Returns null without both, rather than assuming.
 */
export const idempotencyDetector: InvariantDetector = {
  invariantId: "HIVE-INV-IDEMPOTENCY-001",
  name: "idempotent-consumer",
  detect(evidence) {
    const delivered = withFact(evidence, "duplicateDelivered");
    if (delivered.length === 0) return null;

    const suppressed = withFact(evidence, "duplicateSuppressed");
    if (suppressed.length === 0) return null;

    const anySuppressed = suppressed.some((e) => e.facts.duplicateSuppressed === true);
    if (anySuppressed) {
      return {
        verdict: "HELD",
        evidenceIds: suppressed.map((e) => e.evidenceId),
        confidence: "confirmed",
        detail: "A duplicate was delivered and the consumer suppressed its effect.",
      };
    }

    return {
      verdict: "VIOLATED",
      evidenceIds: [...delivered, ...suppressed].map((e) => e.evidenceId),
      confidence: "confirmed",
      detail:
        "A duplicate was delivered and its effect was not suppressed. At-least-once delivery requires an idempotent consumer.",
    };
  },
};

/**
 * HIVE-INV-AUTHORITY-001 — capability does not imply permission.
 *
 * A consequential action recorded without a governance decision is the §1.9
 * failure. Requires the executor to mark which evidence is consequential.
 */
export const authorityDetector: InvariantDetector = {
  invariantId: "HIVE-INV-AUTHORITY-001",
  name: "governance-before-action",
  detect(evidence) {
    const consequential = evidence.filter((e) => e.facts.consequential === true);
    if (consequential.length === 0) return null;

    const decisions = evidence.filter((e) => e.kind === "governance_decision");
    if (decisions.length === 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: consequential.map((e) => e.evidenceId),
        confidence: "confirmed",
        detail: `${consequential.length} consequential action(s) occurred with no Governance decision recorded. Capability is not permission.`,
      };
    }

    const permitted = decisions.some((e) => e.facts.permitted === true);
    if (!permitted) {
      return {
        verdict: "VIOLATED",
        evidenceIds: [...consequential, ...decisions].map((e) => e.evidenceId),
        confidence: "confirmed",
        detail: "A consequential action proceeded although no Governance decision permitted it.",
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: [...consequential, ...decisions].map((e) => e.evidenceId),
      confidence: "confirmed",
      detail: "Every consequential action is covered by a permitting Governance decision.",
    };
  },
};

/**
 * HIVE-INV-PRIME-OWNERSHIP-001 — Prime coordinates but does not own domain state.
 *
 * Needs the executor to record which component persisted what.
 */
export const primeOwnershipDetector: InvariantDetector = {
  invariantId: "HIVE-INV-PRIME-OWNERSHIP-001",
  name: "prime-persists-nothing",
  detect(evidence) {
    const persists = evidence.filter((e) => typeof e.facts.persistedEntity === "string");
    if (persists.length === 0) return null;

    const byPrime = persists.filter((e) => e.componentId.includes("prime"));
    if (byPrime.length === 0) {
      return {
        verdict: "HELD",
        evidenceIds: persists.map((e) => e.evidenceId),
        confidence: "confirmed",
        detail: "Domain state was persisted only by owning engines, not by Prime.",
      };
    }

    return {
      verdict: "VIOLATED",
      evidenceIds: byPrime.map((e) => e.evidenceId),
      confidence: "confirmed",
      detail: `Prime persisted ${byPrime.map((e) => String(e.facts.persistedEntity)).join(", ")}. Prime coordinates work; it does not own the work.`,
    };
  },
};

/** The detectors that can be honestly implemented from evidence facts alone. */
export const BASELINE_DETECTORS: readonly InvariantDetector[] = Object.freeze([
  correlationDetector,
  tenantIsolationDetector,
  idempotencyDetector,
  authorityDetector,
  primeOwnershipDetector,
]);
