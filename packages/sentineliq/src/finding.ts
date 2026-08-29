// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { tenantContextSchema, traceContextSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// What Sentinel observed.
//
// Charter §2 — the one question: "Is the Hive actually behaving the way it is
// authorized and expected to behave?"
//
// Charter §4 — Sentinel is authoritative for "its security observations,
// constitutional-integrity findings, anomaly findings, threat classifications,
// defensive incident records, integrity assessments, and Sentinel-issued
// protective state." It does NOT own "business-domain truth, Governance policy,
// architectural evolution, Prime workflows, or general operational execution."
//
// So a finding is an OBSERVATION with provenance and confidence. It is not a
// verdict, not a policy, and not a repair. Foundry may fix what Sentinel found;
// Sentinel "shall not become the architecture designer merely because it
// identified the problem" (§9).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How bad it is if the finding is true.
 *
 * Severity is about consequence, never about certainty — those are separate
 * axes and collapsing them is how a merely suspicious signal acquires the
 * weight of a confirmed breach on its way up the chain.
 */
export const severitySchema = z.enum([
  "informational",
  "low",
  "moderate",
  "high",
  /** Threatens users, protected data, constitutional integrity, or Hive survival. */
  "catastrophic",
]);
export type Severity = z.infer<typeof severitySchema>;

/**
 * How sure Sentinel is.
 *
 * Common Overwatch Protections: "Sentinel shall distinguish confirmed
 * compromise from suspected compromise where practical." Required rather than
 * optional, because an unstated confidence is read as certainty by whoever acts
 * on it at three in the morning.
 */
export const confidenceSchema = z.enum(["suspected", "probable", "confirmed"]);
export type Confidence = z.infer<typeof confidenceSchema>;

/** What kind of wrongness this is. Charter §5's monitoring surface. */
export const findingKindSchema = z.enum([
  "security_event",
  "constitutional_violation",
  "integrity_failure",
  "drift",
  "privilege_abuse",
  "abnormal_ai_behavior",
  "intrusion",
  "data_exfiltration",
  "cross_tenant_leakage",
  "event_integrity",
  "audit_integrity",
  "engine_health",
  "supply_chain",
  "trust_root",
]);
export type FindingKind = z.infer<typeof findingKindSchema>;

/**
 * Where the observation came from.
 *
 * Common Overwatch Protections: "Consequential conclusions shall preserve
 * appropriate evidence, provenance, confidence, uncertainty, and applicable
 * policy or authority." A finding with no provenance cannot be challenged, and
 * §17 gives every other constitutional system the right to challenge one.
 */
export const evidenceReferenceSchema = z
  .object({
    /** What produced the evidence — an AuditIQ record, a scan, a heartbeat. */
    sourceKind: z.enum(["audit_record", "telemetry", "scan", "attestation", "report", "correlation"]),
    /** A reference, never the evidence itself. */
    locator: z.string().min(1),
    observedAt: z.string().min(1),
    /** Digest, when the evidence supports one. Makes the reference checkable. */
    integrityHash: z.string().min(1).optional(),
  })
  .strict();
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

/**
 * What the finding is about.
 *
 * Deliberately a REFERENCE and a kind, never a domain object. Sentinel watching
 * a work order does not make Sentinel a holder of work orders (§4).
 */
export const findingSubjectSchema = z
  .object({
    kind: z.enum(["engine", "actor", "integration", "session", "deployment", "dataset", "prime_chamber"]),
    id: z.string().min(1),
    /** Present when the finding concerns one tenant. Absent means Hive-wide. */
    tenant: tenantContextSchema.optional(),
  })
  .strict();
export type FindingSubject = z.infer<typeof findingSubjectSchema>;

export const findingSchema = z
  .object({
    findingId: z.string().min(1),
    kind: findingKindSchema,
    severity: severitySchema,
    confidence: confidenceSchema,
    subject: findingSubjectSchema,
    /** Plain-language statement of what was observed. */
    summary: z.string().min(1),
    /** At least one. A finding with no evidence is an assertion. */
    evidence: z.array(evidenceReferenceSchema).min(1),
    observedAt: z.string().min(1),
    trace: traceContextSchema.optional(),
    /**
     * What Sentinel does NOT know.
     *
     * Required on anything short of confirmed. Naming the gap is what lets a
     * responder judge the finding rather than inherit Sentinel's confidence.
     */
    uncertainty: z.string().min(1).optional(),
    /**
     * Findings this one correlates with (§5, incident correlation).
     *
     * References, so correlation never merges two findings into one and loses
     * the weaker signal.
     */
    correlatedWith: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((f) => f.confidence === "confirmed" || Boolean(f.uncertainty), {
    message:
      "A suspected or probable finding must state what is not known. Unstated uncertainty is read as certainty by whoever acts on the finding.",
    path: ["uncertainty"],
  })
  .refine((f) => f.severity !== "catastrophic" || f.evidence.length > 0, {
    message: "A catastrophic finding must carry evidence.",
    path: ["evidence"],
  });
export type Finding = z.infer<typeof findingSchema>;

/**
 * What happened to a finding after it was raised.
 *
 * There is no `suppressed`, no `dismissed` and no `deleted`. Charter §17:
 * "Sentinel findings cannot be silently suppressed." A finding that turns out
 * to be wrong is RESOLVED as a false positive, by somebody, with a reason, and
 * it stays queryable — which is the difference between being wrong in public
 * and making the record of being wrong disappear.
 */
export const dispositionSchema = z.enum([
  "open",
  /** Seen by a responder. Still open. */
  "acknowledged",
  /** Investigated and found not to be a real problem. Stays in the record. */
  "resolved_false_positive",
  /** Real, and dealt with. */
  "resolved_addressed",
  /** Real, accepted as a standing risk by a named authority. */
  "risk_accepted",
]);
export type Disposition = z.infer<typeof dispositionSchema>;

export const dispositionRecordSchema = z
  .object({
    disposition: dispositionSchema,
    /** Who decided. Never a system default. */
    by: z.string().min(1),
    at: z.string().min(1),
    /** Required on every disposition, including acknowledgement. */
    reason: z.string().min(1),
  })
  .strict();
export type DispositionRecord = z.infer<typeof dispositionRecordSchema>;

/** A finding plus its history. The history only ever grows. */
export interface RecordedFinding {
  readonly finding: Finding;
  readonly sequence: number;
  readonly disposition: Disposition;
  readonly history: readonly DispositionRecord[];
}
