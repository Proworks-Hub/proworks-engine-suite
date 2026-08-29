// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The evidence recorder.
//
// Directive §6 lists what to capture and then constrains how: "Avoid copying
// large/sensitive payloads unnecessarily. Prefer references where the
// authoritative system already owns the data. Evidence must be enough to
// reproduce or investigate the failure."
//
// Those two pull against each other, and the resolution is the whole design:
// evidence is a REFERENCE plus enough structure to reason about, never a copy
// of the thing referenced. AuditIQ already owns its records; FileIQ already
// owns its files; the tenant already owns its data. A repair-learning subsystem
// that copies all of it becomes a second, ungoverned store of everything that
// has ever gone wrong — which is a more attractive target than the systems it
// was watching.
// ─────────────────────────────────────────────────────────────────────────────

/** Directive §6's evidence surface. */
export const evidenceKindSchema = z.enum([
  "log",
  "trace",
  "metric",
  "event",
  "command",
  "query",
  "result",
  "engine_health",
  "governance_decision",
  "sentinel_finding",
  "audit_record",
  "state_transition",
  "retry_attempt",
  "dependency_state",
  "authority_envelope",
  "tenant_context",
  "contract_version",
  "engine_version",
  "charter_version",
  "constitution_version",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/**
 * How sensitive the referenced material is.
 *
 * Drives a real rule below, matching the Hive message envelope: restricted and
 * secret material may be REFERENCED but its summary may not contain it.
 */
export const sensitivitySchema = z.enum([
  "public",
  "internal",
  "tenant-confidential",
  "restricted",
  "secret",
]);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

const REFERENCE_ONLY: ReadonlySet<Sensitivity> = new Set(["restricted", "secret"]);

export const evidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    kind: evidenceKindSchema,
    /** Where the authoritative copy lives. `auditiq://aud_41`, `trace://cor-1`. */
    locator: z.string().min(1),
    /** Which component produced it. */
    componentId: z.string().min(1),
    observedAt: z.string().min(1),
    sensitivity: sensitivitySchema.default("internal"),

    /**
     * A short, non-sensitive description of what the referenced thing shows.
     *
     * The minimum needed to reason without fetching. Diagnosis reads summaries;
     * a human investigating follows the locator.
     */
    summary: z.string().min(1),

    /**
     * Flat, non-sensitive facts extracted for matching and comparison.
     *
     * Scalars only. A nested object is where a payload gets attached — the same
     * rule AuditIQ's `detail` uses, for the same reason.
     */
    facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    /** Makes the reference checkable rather than merely a pointer. */
    integrityHash: z.string().min(1).optional(),
  })
  .strict()
  .refine((e) => !REFERENCE_ONLY.has(e.sensitivity) || Object.keys(e.facts).length === 0, {
    message:
      "Restricted or secret evidence may be referenced but not summarized into facts. Extracting scalars out of protected material is how it leaves its boundary one field at a time.",
    path: ["facts"],
  });
export type Evidence = z.infer<typeof evidenceSchema>;

export interface EvidenceCompleteness {
  readonly complete: boolean;
  /** Required evidence the run never captured. */
  readonly missing: readonly string[];
  readonly captured: readonly EvidenceKind[];
}

export interface EvidenceRecorder {
  /** Refuses malformed evidence rather than throwing. */
  capture(input: unknown): { captured: true; evidence: Evidence } | { captured: false; reason: string };
  all(): readonly Evidence[];
  ofKind(kind: EvidenceKind): readonly Evidence[];
  /**
   * Whether the run captured what the scenario said it needed.
   *
   * Directive §42 asks for an evidence-completeness test. A run that concluded
   * something without the evidence its own scenario required has concluded it
   * from somewhere else.
   */
  completeness(requiredEvidence: readonly string[]): EvidenceCompleteness;
  count(): number;
}

/**
 * Maps the corpus's prose evidence requirements onto evidence kinds.
 *
 * The corpus says things like "correlation lineage" and "work-order identity"
 * — human phrases, not enum values. This is a best-effort keyword mapping and
 * it is deliberately conservative: a requirement it cannot map is reported as
 * UNMAPPED rather than silently satisfied, because a completeness check that
 * quietly passes everything it does not understand is worse than none.
 */
const REQUIREMENT_KEYWORDS: readonly { pattern: RegExp; kind: EvidenceKind }[] = [
  { pattern: /correlation|lineage|trace/i, kind: "trace" },
  { pattern: /governance|authority|authoriz/i, kind: "governance_decision" },
  { pattern: /sentinel|finding/i, kind: "sentinel_finding" },
  { pattern: /audit/i, kind: "audit_record" },
  { pattern: /event/i, kind: "event" },
  { pattern: /health|availab/i, kind: "engine_health" },
  { pattern: /tenant/i, kind: "tenant_context" },
  { pattern: /contract|schema|version/i, kind: "contract_version" },
  { pattern: /state|reservation|inventory|ownership|identity/i, kind: "state_transition" },
  { pattern: /retry|attempt/i, kind: "retry_attempt" },
  { pattern: /depend/i, kind: "dependency_state" },
];

/** The evidence kind a prose requirement implies, or null when unmappable. */
export function requirementToKind(requirement: string): EvidenceKind | null {
  return REQUIREMENT_KEYWORDS.find((r) => r.pattern.test(requirement))?.kind ?? null;
}

export function createEvidenceRecorder(): EvidenceRecorder {
  const entries: Evidence[] = [];

  return {
    capture(input) {
      const parsed = evidenceSchema.safeParse(input);
      if (!parsed.success) {
        return {
          captured: false,
          reason: `Not valid evidence: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }
      entries.push(parsed.data);
      return { captured: true, evidence: parsed.data };
    },

    all: () => entries.map((e) => Object.freeze({ ...e })),

    ofKind: (kind) => entries.filter((e) => e.kind === kind).map((e) => Object.freeze({ ...e })),

    completeness(requiredEvidence) {
      const captured = [...new Set(entries.map((e) => e.kind))];
      const missing: string[] = [];

      for (const requirement of requiredEvidence) {
        const kind = requirementToKind(requirement);
        if (kind === null) {
          // Unmappable, so unverifiable. Reported, never assumed satisfied.
          missing.push(`${requirement} (UNMAPPED: no evidence kind corresponds to this requirement)`);
          continue;
        }
        if (!captured.includes(kind)) missing.push(`${requirement} (expected ${kind})`);
      }

      return { complete: missing.length === 0, missing, captured };
    },

    count: () => entries.length,
  };
}
