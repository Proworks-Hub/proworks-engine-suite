/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/domain/envelope.ts
 * Module:   neural-fabric / domain
 * Purpose:  The Universal Fabric Envelope — and the fields it refuses to trust.
 */

import { z } from "zod";

import { LANE_SEMANTICS, laneSchema, type Lane } from "./lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// A REFERENCE TO AUTHORITY IS NOT AUTHORITY
//
// The envelope carries `authorizationEvidenceRef`. §11 puts the rule in the
// field description itself: "never authority by itself."
//
// That sentence is doing a great deal of work. The failure it prevents is not
// exotic — it is the most natural thing in the world for a developer to write:
//
//     if (envelope.authorizationEvidenceRef) { proceed(); }
//
// which reads as a permission check and is not one. It tests that somebody
// wrote a string into a field. A caller that wants to do something forbidden
// only has to write a string into that field.
//
// So this module gives that check a name — `carriesAuthorizationReference` —
// that cannot be mistaken for `isAuthorized`, and exports
// `referenceGrantsAuthority()` returning false so the claim is testable. The
// actual decision comes from Governance through a port, and the envelope's job
// is only to say where to look.
//
// EVERY FIELD HERE IS ROUTING METADATA
//
// Nothing in the envelope describes what the payload MEANS. The Fabric routes
// on lane, capability, zone, classification and policy — never on content.
// §30 puts it plainly: do not let Nexus or Pulse own business meaning beyond
// routing metadata and policy. A routing decision that depended on payload
// contents would make the Fabric a participant in every domain it carries.
//
// AND THE ENVELOPE IS STRICT
//
// `.strict()` throughout. An unknown field on an envelope is either a sender
// with a stale contract or a sender trying something, and both should be
// refused at the boundary rather than carried onward for something downstream
// to interpret. §34.3 makes the sharpest version of the point: transport
// metadata and authorization are never taken from model-generated payload
// assertions.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a signal is going, without naming a machine. */
export const fabricAddressSchema = z
  .object({
    /**
     * The capability being addressed, not the host providing it.
     *
     * §12 prefers semantic addressing for a reason that shows up at the third
     * deployment: a host name in a message is a deployment decision frozen into
     * a contract, and moving the workload then means changing every sender.
     */
    capability: z.string().min(1),
    /** Optional narrowing to a specific participant, when one is genuinely required. */
    participantId: z.string().min(1).optional(),
    /** The zone the address is scoped to. Absent means "wherever policy allows". */
    zoneId: z.string().min(1).optional(),
  })
  .strict();
export type FabricAddress = z.infer<typeof fabricAddressSchema>;

/** How sensitive the signal is, which changes how adapters may handle it. */
export const classificationSchema = z.enum([
  "PUBLIC",
  "INTERNAL",
  /** Tenant-private. Never crosses an instance boundary without governed export. */
  "TENANT_PRIVATE",
  /** Personal data. Minimization rules apply. */
  "PERSONAL",
  /** Security-sensitive. Restricted visibility even inside the instance. */
  "RESTRICTED",
]);
export type Classification = z.infer<typeof classificationSchema>;

/** The scheduling class, bounded by policy — not a business priority. */
export const prioritySchema = z.enum(["BULK", "NORMAL", "HIGH", "EMERGENCY"]);
export type Priority = z.infer<typeof prioritySchema>;

export const provenanceSchema = z
  .object({
    /** The engine or host that originated the signal. */
    originComponent: z.string().min(1),
    /** The instance it originated in. */
    originInstanceId: z.string().min(1),
    /**
     * What kind of principal caused this.
     *
     * §34.3 requires AI-originated traffic to be labelled. Not because AI
     * traffic is untrusted more than any other, but because "an AI asked for
     * this" is a fact an operator needs when deciding whether an unusual
     * request is a bug or an attack, and it is unrecoverable after the fact.
     */
    principalKind: z.enum(["HUMAN", "ENGINE", "AGENT", "AI_MODEL", "EXTERNAL_SYSTEM", "SYSTEM"]),
    /** Model and provider, where an AI principal made a consequential request. */
    modelProvenance: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        sessionRef: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Every transformation applied on the way, in order. */
    transformations: z.array(z.string().min(1)).max(50).default([]),
  })
  .strict()
  .refine((p) => p.principalKind !== "AI_MODEL" || p.modelProvenance !== undefined, {
    message:
      "An AI-originated signal must say which model produced it. Without that, a bad request cannot be traced to its source, and every AI on the instance is equally suspect.",
    path: ["modelProvenance"],
  });
export type FabricProvenance = z.infer<typeof provenanceSchema>;

export const fabricEnvelopeSchema = z
  .object({
    fabricMessageId: z.string().min(1),
    schemaId: z.string().min(1),
    schemaVersion: z.string().min(1),
    lane: laneSchema,

    source: fabricAddressSchema,
    destination: fabricAddressSchema,

    /** Isolation boundary. Required — a signal with no instance cannot be scoped. */
    instanceId: z.string().min(1),
    tenantId: z.string().min(1),

    /** Groups related activity across engines. */
    correlationId: z.string().min(1),
    /**
     * What caused this signal.
     *
     * Nullable, not optional. "Nothing caused this, it originated here" and
     * "nobody recorded what caused it" are different facts, and a chain that
     * cannot tell them apart cannot be walked backwards.
     */
    causationId: z.string().min(1).nullable(),
    /** W3C traceparent-compatible context, where the deployment propagates one. */
    traceContext: z.string().min(1).optional(),

    /**
     * Safe redelivery key. Required on lanes that redeliver AND change state.
     *
     * Enforced below rather than left to the sender, because the sender that
     * forgets is exactly the sender whose command will run twice.
     */
    idempotencyKey: z.string().min(1).optional(),

    /** WHERE the authorization evidence is. Never the authorization itself. */
    authorizationEvidenceRef: z.string().min(1).optional(),

    provenance: provenanceSchema,
    classification: classificationSchema,
    priority: prioritySchema,

    /** When the signal stops being useful, or stops being safe. */
    deadline: z.string().min(1).optional(),
    ttlSeconds: z.number().int().positive().optional(),

    contentType: z.string().min(1),
    /** Large content lives elsewhere and travels as a reference. */
    payloadRef: z.string().min(1).optional(),

    /** Integrity evidence, produced and verified by Security IQ. */
    integrity: z
      .object({
        algorithmProfile: z.string().min(1),
        signature: z.string().min(1),
        signedBy: z.string().min(1),
      })
      .strict()
      .optional(),

    /**
     * Whether this came from a test run.
     *
     * Required with no default. The same rule the rest of the suite uses, and
     * for the reason a real defect demonstrated: a hardcoded `isTest: false`
     * put four test work orders into a production database, and nothing
     * complained.
     */
    isTest: z.boolean(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const semantics = LANE_SEMANTICS[envelope.lane];

    if (semantics.requiresIdempotentConsumer && envelope.idempotencyKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idempotencyKey"],
        message: `The ${envelope.lane} lane redelivers until acknowledged, so a signal on it needs an idempotency key. Without one, a redelivery after a timeout is indistinguishable from a second, genuine request.`,
      });
    }

    if (semantics.requiresAuthorizationEvidence && envelope.authorizationEvidenceRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizationEvidenceRef"],
        message: `The ${envelope.lane} lane carries consequential signals and requires a reference to authorization evidence. The reference is not permission — it is where to look for it — but a signal that cannot say where to look cannot be checked at all.`,
      });
    }

    if (semantics.payloadCarriage === "REFERENCE_ONLY" && envelope.payloadRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadRef"],
        message: `The ${envelope.lane} lane carries a reference to content held elsewhere. A signal on it with no payload reference is carrying the bytes inline, which is what this lane exists to prevent.`,
      });
    }
  });
export type FabricEnvelope = z.infer<typeof fabricEnvelopeSchema>;

export type EnvelopeAcceptance =
  | { readonly accepted: true; readonly envelope: FabricEnvelope }
  | { readonly accepted: false; readonly reason: string; readonly issues: readonly string[] };

/**
 * The single door for an inbound signal.
 *
 * One function, so there is one place the envelope rules are enforced. A second
 * entry point would be a second place to forget one.
 */
export function acceptEnvelope(raw: unknown): EnvelopeAcceptance {
  const parsed = fabricEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      accepted: false,
      reason: "The signal is not a valid Fabric envelope and was not routed.",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { accepted: true, envelope: parsed.data };
}

/**
 * Whether the envelope names a place to look for authorization evidence.
 *
 * NOT a permission check, and named so it cannot be read as one. The
 * difference between this and `isAuthorized` is the difference between knowing
 * where a document is filed and having read it.
 */
export function carriesAuthorizationReference(envelope: FabricEnvelope): boolean {
  return envelope.authorizationEvidenceRef !== undefined;
}

/**
 * Whether possessing an evidence reference grants authority.
 *
 * Always false. Asserted in a test because this is the exact confusion §11 and
 * §33.3 both warn about, and a comment saying so decays while a test does not.
 */
export function referenceGrantsAuthority(): false {
  return false;
}

/**
 * Whether holding a route grants permission to use it.
 *
 * Also always false. §33.3: "Fabric never treats possession of a route as
 * permission." Separate from the above because they are separately tempting:
 * one confuses a citation with a decision, the other confuses reachability with
 * entitlement.
 */
export function routePossessionGrantsPermission(): false {
  return false;
}

/**
 * Whether a signal has outlived its usefulness.
 *
 * `now` is an argument. A TTL check that read the clock could not be replayed,
 * and "was this signal expired when we dropped it?" is precisely the question
 * asked after an incident.
 */
export function isExpired(envelope: FabricEnvelope, sentAt: string, now: string): boolean {
  if (envelope.deadline !== undefined && now >= envelope.deadline) return true;
  if (envelope.ttlSeconds !== undefined) {
    const sent = Date.parse(sentAt);
    const at = Date.parse(now);
    if (Number.isFinite(sent) && Number.isFinite(at)) {
      return at - sent >= envelope.ttlSeconds * 1000;
    }
  }
  return false;
}

/** Fields that may appear in telemetry. Everything else is withheld. */
const TELEMETRY_SAFE = [
  "fabricMessageId",
  "schemaId",
  "schemaVersion",
  "lane",
  "instanceId",
  "correlationId",
  "causationId",
  "traceContext",
  "classification",
  "priority",
  "isTest",
] as const;

/**
 * The envelope reduced to what may safely be published as telemetry.
 *
 * An allowlist, not a denylist. §19 requires payload-sensitive data to stay out
 * of telemetry, and a denylist fails open every time a field is added: the new
 * field is not on the list, so it is emitted, and nobody notices until it is in
 * a dashboard.
 *
 * `tenantId` is deliberately absent. It identifies a customer, and a trace
 * spanning a shared observability stack is exactly where that should not be.
 */
export function telemetryView(envelope: FabricEnvelope): Readonly<Record<string, unknown>> {
  const view: Record<string, unknown> = {};
  for (const field of TELEMETRY_SAFE) {
    const value = envelope[field];
    if (value !== undefined) view[field] = value;
  }
  // The addresses are logical, so the capability is safe and useful. The
  // participant id can identify a specific workload, so it is not included.
  view["sourceCapability"] = envelope.source.capability;
  view["destinationCapability"] = envelope.destination.capability;
  view["principalKind"] = envelope.provenance.principalKind;
  return Object.freeze(view);
}

/** Whether a field is permitted in telemetry. Data, so the allowlist is testable. */
export function isTelemetrySafeField(field: string): boolean {
  return (TELEMETRY_SAFE as readonly string[]).includes(field);
}

/**
 * Whether a signal may cross an instance boundary on classification alone.
 *
 * Classification is necessary and NOT sufficient — the route must still
 * terminate at a governed Interconnect gateway. This answers only the data
 * question, and says so, because a caller who reads `true` as "safe to send"
 * has skipped the gateway.
 */
export function classificationPermitsExport(classification: Classification): {
  readonly permitted: boolean;
  readonly note: string;
} {
  if (classification === "TENANT_PRIVATE" || classification === "PERSONAL" || classification === "RESTRICTED") {
    return {
      permitted: false,
      note: `${classification} data does not leave the instance without a governed export decision. This is a property of the data, and no route health, latency benefit or urgency changes it.`,
    };
  }
  return {
    permitted: true,
    note: `${classification} data may cross an instance boundary — but only through an explicit Interconnect gateway. This answers the data question alone; it is not a route approval.`,
  };
}

/** The lane's semantics for an envelope, so a caller need not look them up. */
export function laneOf(envelope: FabricEnvelope): Lane {
  return envelope.lane;
}
