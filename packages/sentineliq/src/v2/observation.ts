// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { confidenceSchema, severitySchema } from "../finding.js";
import {
  CATEGORY_OF,
  DATA_CLASSIFICATIONS,
  OBSERVATION_TYPES,
  PRIVACY_SCOPES,
  SECURITY_CONVENTIONS_VERSION,
  SUBJECT_KINDS,
  type ObservationCategory,
  type ObservationType,
} from "./securityConventions.js";
import { screenTelemetry } from "./telemetry.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Security Observation Plane — directive §9/§10 (DEC-028), named there as
// "the first major missing operational layer".
//
// A SecurityObservation is the canonical, normalized, provider-neutral record
// of something security-relevant that was seen. Everything downstream —
// detection, correlation, incidents, exposure, forensics, the SOC read models
// — consumes this substrate, which is why it is built first.
//
// THREE RULES THIS FILE ENFORCES STRUCTURALLY:
//
// 1. NO SECRETS, NO RAW PROTECTED PAYLOADS (§10). An observation carries
//    REFERENCES to protected evidence, never the evidence. Construction runs
//    the telemetry secret screen and REFUSES — a record that would carry a
//    credential is not emitted with holes, it is rejected with the field
//    named. A redaction pipeline that silently passes what it failed to match
//    is a false validator.
//
// 2. VENDOR FORMATS DO NOT ENTER (§9). Adapters normalize; the internals only
//    ever see canonical vocabulary. `provider` records WHO spoke, as data —
//    it is not part of the meaning.
//
// 3. UNKNOWN IS NOT ABSENT. Severity and confidence are required, and
//    normalization records what the adapter could NOT map rather than
//    dropping it, because a field an adapter silently discarded is a
//    detection gap nobody can see.
// ─────────────────────────────────────────────────────────────────────────────

export const observationSubjectSchema = z
  .object({
    kind: z.enum(SUBJECT_KINDS),
    /** A reference, never a domain object. */
    ref: z.string().min(1),
    /** Optional human-meaningful label for explanation surfaces. */
    label: z.string().min(1).optional(),
  })
  .strict();
export type ObservationSubject = z.infer<typeof observationSubjectSchema>;

/** Where the observation came from. `provider` is where a vendor name is
 * legitimate — as data about the source, never as canonical vocabulary. */
export const observationSourceSchema = z
  .object({
    /** Which sensor port produced it (see providers.ts), or "hive-native". */
    sensorKind: z.string().min(1),
    /** The concrete provider, e.g. "hive.neural-fabric" or an external tool
     * name. Free text BY DESIGN: it is data, not meaning. */
    provider: z.string().min(1),
    instanceRef: z.string().min(1),
    hostEnvironmentRef: z.string().min(1).optional(),
  })
  .strict();
export type ObservationSource = z.infer<typeof observationSourceSchema>;

/** A reference to evidence held elsewhere (AuditIQ, EventIQ, a host tool).
 * Sentinel does not copy the evidence — §24: no parallel AuditIQ. */
export const evidencePointerSchema = z
  .object({
    holder: z.enum(["audit-iq", "event-iq", "host-provider", "fabric", "sentinel-forensics", "external"]),
    locator: z.string().min(1),
    /** Digest where the holder supports one — makes the reference checkable. */
    integrityHash: z.string().min(1).optional(),
  })
  .strict();
export type EvidencePointer = z.infer<typeof evidencePointerSchema>;

/** What the adapter could not map. Present-and-empty means "mapped cleanly";
 * a populated list is a visible normalization gap, not a silent loss. */
export const normalizationMetadataSchema = z
  .object({
    adapterRef: z.string().min(1),
    conventionsVersion: z.string().min(1),
    /** Source field names the adapter received but could not place. */
    unmappedFields: z.array(z.string().min(1)),
    /** True when the adapter had to guess a value; guessed observations are
     * usable for triage and never for a deterministic gate. */
    lossy: z.boolean(),
  })
  .strict();
export type NormalizationMetadata = z.infer<typeof normalizationMetadataSchema>;

export const OBSERVATION_SCHEMA_VERSION = "1.0.0";

export const securityObservationSchema = z
  .object({
    observationId: z.string().min(1),
    schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
    /** Explicit instants, never a clock read inside the kernel. Both are
     * required: the gap between them IS the detection latency, and a plane
     * that only records one cannot measure itself. */
    observedAt: z.string().min(1),
    receivedAt: z.string().min(1),
    source: observationSourceSchema,
    subject: observationSubjectSchema,
    observationType: z.enum(OBSERVATION_TYPES),
    category: z.enum(["identity-and-trust", "runtime", "network-and-fabric", "data-protection", "supply-chain", "ai-activity", "constitutional", "operator", "sentinel-self"]),
    severity: severitySchema,
    confidence: confidenceSchema,
    /** REFERENCES only. */
    evidenceRefs: z.array(evidencePointerSchema),
    /** Correlation across a causal chain; causation names the direct parent. */
    correlationId: z.string().min(1).optional(),
    causationId: z.string().min(1).optional(),
    dataClassification: z.enum(DATA_CLASSIFICATIONS),
    privacyScope: z.enum(PRIVACY_SCOPES),
    /** Attestation state of the OBSERVATION itself — a sensor's own integrity
     * is part of what its evidence is worth. */
    sourceAttested: z.boolean(),
    attackTechniqueRef: z
      .string()
      .regex(/^T\d{4}(\.\d{3})?$/)
      .optional(),
    /** Small, already-normalized, non-sensitive detail. Screened at
     * construction like everything else. */
    attributes: z.record(z.string(), z.string()),
    normalization: normalizationMetadataSchema,
  })
  .strict()
  .refine((o) => CATEGORY_OF[o.observationType] === o.category, {
    message: "category must be the canonical category of observationType — a mislabelled category routes an observation to the wrong chamber",
  });
export type SecurityObservation = z.infer<typeof securityObservationSchema>;

export type ObservationAdmission =
  | { readonly admitted: true; readonly observation: SecurityObservation }
  | {
      readonly admitted: false;
      readonly reason: "secret-material-present" | "schema-invalid" | "classification-scope-conflict";
      readonly detail: string;
      /** Named fields, so the producer can fix its adapter rather than guess. */
      readonly offendingFields: readonly string[];
    };

/**
 * The single admission point into the plane. Nothing reaches detection,
 * correlation or the read models without passing here.
 *
 * The classification/scope rule: protected-health and regulated data are
 * NEVER collective-eligible. That is not a policy toggle — the combination is
 * refused at construction, because the alternative is a promotion path whose
 * safety depends on every downstream consumer checking a flag correctly.
 */
export function admitObservation(candidate: unknown): ObservationAdmission {
  const parsed = securityObservationSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      admitted: false,
      reason: "schema-invalid",
      detail: parsed.error.issues[0]?.message ?? "invalid observation",
      offendingFields: parsed.error.issues.map((i) => i.path.join(".")).filter((p) => p.length > 0),
    };
  }
  const observation = parsed.data;
  if (
    observation.privacyScope === "collective-eligible" &&
    (observation.dataClassification === "protected-health" || observation.dataClassification === "regulated")
  ) {
    return {
      admitted: false,
      reason: "classification-scope-conflict",
      detail: `${observation.dataClassification} data is never collective-eligible; the combination is refused at construction rather than trusted to a downstream check.`,
      offendingFields: ["privacyScope", "dataClassification"],
    };
  }
  // The secret screen runs over every free-text surface the record carries.
  const screened: Record<string, string> = {
    ...observation.attributes,
    "subject.ref": observation.subject.ref,
    ...(observation.subject.label !== undefined ? { "subject.label": observation.subject.label } : {}),
    ...Object.fromEntries(observation.evidenceRefs.map((e, i) => [`evidenceRefs.${i}.locator`, e.locator])),
  };
  const screen = screenTelemetry(screened);
  if (!screen.emit) {
    return {
      admitted: false,
      reason: "secret-material-present",
      detail: `Observation carries secret material (${screen.refusedFields.map((f) => f.matchedRule).join(", ")}). Reference protected evidence; never inline it.`,
      offendingFields: screen.refusedFields.map((f) => f.field),
    };
  }
  return { admitted: true, observation };
}

/** Detection latency, in milliseconds, from the record's own instants. Null
 * when the timestamps are unusable — never a zero standing in for unknown. */
export function detectionLatencyMs(observation: SecurityObservation): number | null {
  const observed = Date.parse(observation.observedAt);
  const received = Date.parse(observation.receivedAt);
  if (Number.isNaN(observed) || Number.isNaN(received)) return null;
  return received - observed;
}

/** Convenience for producers: fills schemaVersion, category and conventions
 * version so a producer cannot desynchronize them by hand. */
export function buildObservation(input: {
  observationId: string;
  observedAt: string;
  receivedAt: string;
  source: ObservationSource;
  subject: ObservationSubject;
  observationType: ObservationType;
  severity: SecurityObservation["severity"];
  confidence: SecurityObservation["confidence"];
  evidenceRefs?: readonly EvidencePointer[];
  correlationId?: string;
  causationId?: string;
  dataClassification: SecurityObservation["dataClassification"];
  privacyScope: SecurityObservation["privacyScope"];
  sourceAttested: boolean;
  attackTechniqueRef?: string;
  attributes?: Readonly<Record<string, string>>;
  adapterRef: string;
  unmappedFields?: readonly string[];
  lossy?: boolean;
}): ObservationAdmission {
  const category: ObservationCategory = CATEGORY_OF[input.observationType];
  return admitObservation({
    observationId: input.observationId,
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt,
    source: input.source,
    subject: input.subject,
    observationType: input.observationType,
    category,
    severity: input.severity,
    confidence: input.confidence,
    evidenceRefs: input.evidenceRefs ?? [],
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    dataClassification: input.dataClassification,
    privacyScope: input.privacyScope,
    sourceAttested: input.sourceAttested,
    ...(input.attackTechniqueRef !== undefined ? { attackTechniqueRef: input.attackTechniqueRef } : {}),
    attributes: input.attributes ?? {},
    normalization: {
      adapterRef: input.adapterRef,
      conventionsVersion: SECURITY_CONVENTIONS_VERSION,
      unmappedFields: input.unmappedFields ?? [],
      lossy: input.lossy ?? false,
    },
  });
}
