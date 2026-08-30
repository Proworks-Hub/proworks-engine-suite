/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/connectionEvidence.ts
 * Module:   neural-fabric / interop
 * Purpose:  Telling Foundry what broke without telling it whose data broke.
 */

import { z } from "zod";

import { classificationSchema } from "../domain/envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE HIVE DIFFERENTIATOR, AND THE THING THAT WOULD RUIN IT
//
// §6 H: "connection failures become governed Foundry knowledge" and
// "generalized lessons improve future Instances without sharing private host
// payloads." The first half is the value. The second half is the constraint,
// and it is the harder one: an evidence pipeline is a data-exfiltration
// channel that everybody has agreed to install.
//
// A failure record is the most tempting place in the system to include "just
// a bit" of the payload — the failing message would make the bug so much
// easier to reproduce. That is exactly how a customer's order line ends up in
// a cross-instance knowledge base. So this schema is `.strict()`, has no
// payload field at all, and the minimizer below is the only constructor.
//
// A FINGERPRINT, NOT AN IDENTIFIER
//
// The intent fingerprint is a stable hash over the SHAPE of the conversation
// — capabilities, lane, pattern, classification — and never over its content.
// Two instances hitting the same incompatibility produce the same
// fingerprint, which is what lets a lesson generalize; neither fingerprint
// can be walked back to a tenant, a participant or a message.
//
// The hash is FNV-1a: small, dependency-free, deterministic across runs and
// machines. It is not a cryptographic commitment and does not need to be —
// nothing here is secret, because nothing secret is allowed in.
// ─────────────────────────────────────────────────────────────────────────────

export const failureStageSchema = z.enum([
  "INTENT_VALIDATION",
  "PATTERN_PLANNING",
  "CONTRACT_RESOLUTION",
  "SCHEMA_COMPATIBILITY",
  "MAPPING",
  "ADAPTER_SELECTION",
  "ADAPTER_DISPATCH",
  "PROVIDER_OUTAGE",
  "SECURITY_VERIFICATION",
  "GATEWAY_INGRESS",
  "GATEWAY_EGRESS",
  "DELIVERY_TIMEOUT",
  "EDGE_RECONNECT",
]);
export type FailureStage = z.infer<typeof failureStageSchema>;

export const connectionFailureEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    /** Stable hash over the conversation's shape. Never over its content. */
    intentFingerprint: z.string().min(1),

    failureStage: failureStageSchema,
    /** A stable, enumerable code. Free text goes in `generalizedTags`. */
    failureCode: z.string().min(1).max(64),

    /** Versions, so a lesson can be scoped to what it was observed against. */
    contractProfileVersion: z.string().min(1).nullable(),
    adapterId: z.string().min(1).nullable(),
    adapterVersion: z.string().min(1).nullable(),
    providerFamily: z.string().min(1).nullable(),
    topologyVersionId: z.string().min(1),
    patternId: z.string().min(1).nullable(),

    /** Retry and circuit state at the moment of failure. */
    attemptCount: z.number().int().nonnegative(),
    circuitState: z.enum(["CLOSED", "OPEN", "HALF_OPEN"]),

    /**
     * The classification of the traffic that failed.
     *
     * The CLASS, never the data. Knowing that restricted traffic fails more
     * often on a given adapter is a real and useful finding; knowing what the
     * restricted traffic said is a breach.
     */
    classification: classificationSchema,

    /** Safe, generalized tags. Bounded and vocabulary-checked by the minimizer. */
    generalizedTags: z.array(z.string().min(1).max(48)).max(12),

    /** How to reproduce SHAPE, never content. */
    reproductionHints: z.array(z.string().min(1).max(200)).max(10),

    /** True when the failure happened to synthetic traffic. */
    isTest: z.boolean(),
    observedAt: z.string().min(1),
  })
  .strict();
export type ConnectionFailureEvidence = z.infer<typeof connectionFailureEvidenceSchema>;

/**
 * FNV-1a over a string. Deterministic, dependency-free, non-cryptographic.
 *
 * Two instances observing the same failure shape must produce the same
 * fingerprint on different machines and different days, which rules out
 * anything seeded or address-dependent.
 */
export function fingerprint(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  // NUL separator, written as an escape rather than a literal byte: a
  // literal NUL typechecks fine and turns the source file binary to grep.
  // NUL is the right separator because it cannot occur in any input, so
  // ["ab","c"] and ["a","bc"] cannot collide into one fingerprint.
  const input = parts.join("\u0000");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp-${hash.toString(16).padStart(8, "0")}`;
}

/** The raw observation, which DOES contain identifying detail. */
export interface RawFailureObservation {
  readonly sourceCapability: string;
  readonly destinationCapability: string;
  readonly lane: string;
  readonly patternId: string | null;
  readonly failureStage: FailureStage;
  readonly failureCode: string;
  readonly classification: ConnectionFailureEvidence["classification"];
  readonly topologyVersionId: string;
  readonly contractProfileVersion: string | null;
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly providerFamily: string | null;
  readonly attemptCount: number;
  readonly circuitState: ConnectionFailureEvidence["circuitState"];
  readonly isTest: boolean;
  readonly observedAt: string;

  // ── Everything below is DROPPED by the minimizer. It is accepted so the
  //    caller does not have to strip it first — a caller doing its own
  //    stripping is a caller that will one day forget.
  readonly tenantId?: string | null;
  readonly participantId?: string | null;
  readonly instanceId?: string | null;
  readonly payloadSample?: string | null;
  readonly errorMessage?: string | null;
  readonly fieldNames?: readonly string[];
}

/**
 * Tags the minimizer may emit.
 *
 * A closed vocabulary because free-text tags are where identifying detail
 * re-enters after being removed everywhere else — "failed for customer
 * Acme's bulk import" is a tag somebody would absolutely write.
 */
export const SAFE_TAG_VOCABULARY: readonly string[] = Object.freeze([
  "cross-instance",
  "local",
  "schema-incompatible",
  "mapping-ambiguous",
  "adapter-uncertified",
  "adapter-missing",
  "provider-unavailable",
  "provider-saturated",
  "security-unavailable",
  "security-refused",
  "deadline-exceeded",
  "retry-exhausted",
  "circuit-open",
  "offline-sender",
  "offline-receiver",
  "constrained-bandwidth",
  "payload-too-large",
  "ordering-violated",
  "duplicate-delivery",
  "replay-unsupported",
  "test-traffic",
]);

/**
 * The only way to build a ConnectionFailureEvidence.
 *
 * Takes the raw observation and returns something safe to export. Fields that
 * could identify a tenant, a participant, a person or a payload are not
 * copied — not redacted, not hashed, not carried in a "debug" field. They are
 * absent from the output type, so the compiler is what enforces this and not
 * a reviewer's attention.
 */
export function minimizeFailure(
  observation: RawFailureObservation,
  evidenceId: string,
): ConnectionFailureEvidence {
  const tags: string[] = [];
  // The vocabulary check is an EQUIVALENT MUTANT today: every string passed to
  // `tag` below is already a literal from SAFE_TAG_VOCABULARY, so removing the
  // check changes no observable behaviour and no test can distinguish it.
  //
  // It stays because it is a live tripwire rather than a redundant guard. The
  // next person to add a failure stage will add a `tag("...")` call, and if
  // they invent a string instead of adding it to the vocabulary, this silently
  // drops it rather than letting an untracked tag into a corpus that is
  // retained permanently and shared across instances. The test below asserts
  // the invariant the check protects — that every stage's tags are in the
  // vocabulary — which is the honest way to cover an equivalent mutant.
  const tag = (candidate: string): void => {
    if (SAFE_TAG_VOCABULARY.includes(candidate) && !tags.includes(candidate) && tags.length < 12) tags.push(candidate);
  };

  if (observation.isTest) tag("test-traffic");
  if (observation.circuitState === "OPEN") tag("circuit-open");
  if (observation.attemptCount > 1) tag("retry-exhausted");

  switch (observation.failureStage) {
    case "SCHEMA_COMPATIBILITY":
      tag("schema-incompatible");
      break;
    case "MAPPING":
      tag("mapping-ambiguous");
      break;
    case "ADAPTER_SELECTION":
      tag("adapter-missing");
      break;
    case "ADAPTER_DISPATCH":
      tag("adapter-uncertified");
      break;
    case "PROVIDER_OUTAGE":
      tag("provider-unavailable");
      break;
    case "SECURITY_VERIFICATION":
      tag("security-refused");
      break;
    case "GATEWAY_INGRESS":
    case "GATEWAY_EGRESS":
      tag("cross-instance");
      break;
    case "DELIVERY_TIMEOUT":
      tag("deadline-exceeded");
      break;
    case "EDGE_RECONNECT":
      tag("offline-sender");
      break;
    default:
      break;
  }

  return {
    evidenceId,
    // Capability names are part of the shape, and they are architectural
    // vocabulary rather than customer data — but they still go through the
    // hash rather than into the record, because a capability name in a
    // deployment can be specific enough to identify the deployment.
    intentFingerprint: fingerprint([
      observation.sourceCapability,
      observation.destinationCapability,
      observation.lane,
      observation.patternId ?? "no-pattern",
      observation.classification,
      observation.failureStage,
      observation.failureCode,
    ]),
    failureStage: observation.failureStage,
    failureCode: observation.failureCode,
    contractProfileVersion: observation.contractProfileVersion,
    adapterId: observation.adapterId,
    adapterVersion: observation.adapterVersion,
    providerFamily: observation.providerFamily,
    topologyVersionId: observation.topologyVersionId,
    patternId: observation.patternId,
    attemptCount: observation.attemptCount,
    circuitState: observation.circuitState,
    classification: observation.classification,
    generalizedTags: tags,
    reproductionHints: [
      `Stage ${observation.failureStage} with code ${observation.failureCode}.`,
      `Pattern ${observation.patternId ?? "none"} on lane ${observation.lane}.`,
      observation.adapterId === null ? "No adapter was selected." : `Adapter ${observation.adapterId}@${observation.adapterVersion ?? "?"}.`,
    ],
    isTest: observation.isTest,
    observedAt: observation.observedAt,
  };
}

/**
 * The export port. Foundry implements it; the Fabric only calls it.
 *
 * A port rather than a direct dependency because the direction matters: the
 * Fabric must not import Foundry. Fabric is a coordination plane that has to
 * keep working when the learning layer is absent, and an import would make
 * Foundry a load-bearing dependency of message delivery.
 */
export interface ConnectionEvidencePort {
  /**
   * Records one minimized failure. Best-effort by contract: the caller must
   * not fail a delivery because the learning layer is unavailable. Evidence
   * is valuable; it is not more valuable than the traffic.
   */
  record(evidence: ConnectionFailureEvidence): void;
}

/**
 * Exports evidence, swallowing failures from the sink.
 *
 * The try/catch is the contract, not defensive habit: a Foundry outage that
 * could break message delivery would make the learning layer load-bearing for
 * the nervous system, which inverts the dependency the port exists to keep
 * one-way.
 */
export function exportFailure(
  port: ConnectionEvidencePort,
  observation: RawFailureObservation,
  evidenceId: string,
): { readonly exported: boolean; readonly evidence: ConnectionFailureEvidence } {
  const evidence = minimizeFailure(observation, evidenceId);
  try {
    port.record(evidence);
    return { exported: true, evidence };
  } catch {
    return { exported: false, evidence };
  }
}

/** Evidence carries no payload, and there is no field in which it could. */
export function evidenceMayCarryPayload(): false {
  return false;
}
