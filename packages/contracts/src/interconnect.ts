// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { dataClassificationSchema } from "./hiveMessage.js";
import { identifierSchema } from "./identifiers.js";

// ─────────────────────────────────────────────────────────────────────────────
// TWO INSTANCES WORKING TOGETHER WITHOUT BECOMING ONE DATABASE.
//
// Every phase before this one held a wall shut. EventIQ refuses a message
// claiming a foreign origin, and its refusal says why: "requires a governed
// relationship through the Interconnect, which does not exist yet." This is
// that relationship, and the wall does not come down — it gains a door.
//
// The distinction matters because it decides what happens when this code is
// absent, misconfigured, or expired. A wall with a door still refuses
// everything by default; a wall removed refuses nothing. So `linkPermits`
// below is deny-by-default, every branch is a named refusal, and the absence
// of a link is not a special case — it is simply not a permit.
//
// A CONNECTION IS A RELATIONSHIP, NOT SHARED ACCESS
//
// The link says what may be SENT, for what PURPOSE, under which CONTRACT. It
// does not open a database, a queue, a cache or an index. Nothing in this file
// can express "read their store", because there is no shape here that means
// it — which is a stronger guarantee than a rule saying not to.
//
// TRUST IS NEVER TRANSITIVE
//
// KSix→ProWorks and MakerOps→ProWorks does not create MakerOps→KSix. That is
// enforced structurally: an evaluation takes ONE link and never follows a
// second. There is no graph to walk, so there is no path to find.
//
// NOT A SECOND HiveMessage
//
// `hiveMessageSchema` is the INTRA-instance envelope — how engines inside one
// Hive talk. This is the INTER-instance one, and it carries different things
// for a different reason: a signature, an encryption envelope, a link, prior
// stage attestations, and a destination that is somebody else. A HiveMessage
// may travel inside a handoff as its payload. Merging them would mean every
// internal message carried fields only a border crossing needs, and every
// border crossing trusted fields written for a context with no border in it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one instance may do to another, in one direction.
 *
 * Verbs, not resources. `SEND_WORK` names an action the source performs;
 * there is deliberately no `READ_ORDERS`, because a capability naming a
 * resource is one step from a capability naming a table.
 */
export const interconnectCapabilitySchema = z.enum([
  /** Hand an authorized work package to the destination. */
  "SEND_WORK",
  /** Receive authorized status about work previously sent. */
  "RECEIVE_STATUS",
  /** Ask for a result the destination produced. */
  "REQUEST_RESULT",
  /** Send an authorized artifact by reference. */
  "SEND_ARTIFACT",
  /** Acknowledge something received. Separate, because it is not a send. */
  "ACKNOWLEDGE",
]);
export type InterconnectCapability = z.infer<typeof interconnectCapabilitySchema>;

/** How much scrutiny a link's traffic gets. Higher tiers do not skip checks. */
export const trustTierSchema = z.enum([
  /** Every transfer is independently re-validated by the recipient. */
  "verified_each_time",
  /** Prior-stage attestations may be accepted without re-running the work. */
  "attestation_accepted",
  /** Regulated: additional policy applies and raw payloads never travel inline. */
  "regulated",
]);
export type TrustTier = z.infer<typeof trustTierSchema>;

export const linkStatusSchema = z.enum(["active", "suspended", "revoked", "expired"]);
export type LinkStatus = z.infer<typeof linkStatusSchema>;

/**
 * One directional relationship between two instances.
 *
 * DIRECTIONAL, always. Bidirectional collaboration is two grants, and that is
 * not bureaucracy: "KSix may send ProWorks work" and "ProWorks may send KSix
 * work" are genuinely different decisions, and a single bidirectional object
 * would make approving one approve the other.
 */
export const instanceLinkSchema = z
  .object({
    linkId: identifierSchema,
    sourceInstanceId: identifierSchema,
    destinationInstanceId: identifierSchema,
    relationshipType: z.string().min(1),
    /** At least one. A link permitting nothing is not a link. */
    allowedCapabilities: z.array(interconnectCapabilitySchema).min(1),
    /** Contract types this link may carry. Empty means none, not all. */
    allowedContractTypes: z.array(z.string().min(1)).min(1),
    /**
     * Purposes this link may be used for.
     *
     * Purpose limitation, and the field that makes it enforceable. Access for
     * one purpose does not authorize another — the same constitutional rule
     * §1.7 applies inside an instance, applied at the border.
     */
    allowedPurposes: z.array(z.string().min(1)).min(1),
    /** The highest sensitivity this link may carry. */
    maxSensitivity: dataClassificationSchema,
    trustTier: trustTierSchema,
    createdBy: identifierSchema,
    /** The human or governance decision that approved it. Required. */
    approvedBy: identifierSchema,
    validFrom: z.string().min(1),
    expiresAt: z.string().min(1).optional(),
    status: linkStatusSchema,
    revocationReason: z.string().min(1).optional(),
    policyVersion: z.string().min(1),
  })
  .strict()
  .refine((l) => l.sourceInstanceId !== l.destinationInstanceId, {
    message:
      "A link from an instance to itself is not an interconnect. Intra-instance communication is EventIQ's, and routing it through a border check would make the border meaningless.",
    path: ["destinationInstanceId"],
  })
  .refine((l) => l.status !== "revoked" || Boolean(l.revocationReason), {
    message:
      "A revoked link must say why. A revocation nobody can explain cannot be reviewed, appealed, or distinguished from an expiry.",
    path: ["revocationReason"],
  });
export type InstanceLink = z.infer<typeof instanceLinkSchema>;

/**
 * Evidence that a stage of work was already done, and by whom.
 *
 * The point of the whole handoff: the receiver continues from an authenticated
 * checkpoint rather than redoing what the sender already did. What it must NOT
 * become is a way to skip work on somebody's say-so — which is why the
 * attestation carries who attested and a digest, and why the link's trust tier
 * decides whether that is enough.
 */
export const priorStageAttestationSchema = z
  .object({
    stage: z.string().min(1),
    completedBy: identifierSchema,
    completedAt: z.string().min(1),
    /** A digest of what was produced. Never the output itself. */
    resultDigest: z.string().min(1),
    /** The attesting instance's signature reference. */
    attestationRef: z.string().min(1),
  })
  .strict();
export type PriorStageAttestation = z.infer<typeof priorStageAttestationSchema>;

/**
 * The baton.
 *
 * Domain payloads are versioned contracts carried INSIDE it, which is what
 * makes this industry-neutral: manufacturing packages, imaging referrals and
 * construction change orders are all `contractType` plus a payload, and the
 * envelope does not know the difference.
 */
export const handoffEnvelopeSchema = z
  .object({
    envelopeId: identifierSchema,
    /** Survives the crossing, so one workflow is followable across instances. */
    globalCorrelationId: z.string().min(1),
    causationId: z.string().min(1).optional(),

    sourceInstanceId: identifierSchema,
    destinationInstanceId: identifierSchema,
    sourceEngineId: identifierSchema.optional(),
    /** What the destination is being asked to do. Matched against the link. */
    destinationCapability: interconnectCapabilitySchema,

    contractType: z.string().min(1),
    contractVersion: z.string().min(1),
    purpose: z.string().min(1),

    createdAt: z.string().min(1),
    expiresAt: z.string().min(1).optional(),
    /** So a retried handoff does not become two pieces of downstream work. */
    idempotencyKey: z.string().min(1),

    priorStageAttestations: z.array(priorStageAttestationSchema).default([]),

    /**
     * The payload, or a reference to it.
     *
     * Exactly one. Large and protected content travels by reference — the same
     * rule `hiveMessageSchema` applies internally, and for a stronger reason
     * here: an inline payload crosses an organizational boundary and cannot be
     * unsent.
     */
    payload: z.unknown().optional(),
    payloadRef: z
      .object({
        locator: z.string().min(1),
        contentType: z.string().min(1),
        sizeBytes: z.number().int().nonnegative().optional(),
        integrityHash: z.string().min(1),
        /** When the reference stops resolving. Scoped, expiring, revocable. */
        expiresAt: z.string().min(1),
      })
      .strict()
      .optional(),

    sensitivityClass: dataClassificationSchema,
    policyLabels: z.array(z.string().min(1)).default([]),
    provenanceRefs: z.array(z.string().min(1)).default([]),

    integrityHash: z.string().min(1),
    /** A reference to a signature. This file implements no cryptography. */
    senderSignature: z.string().min(1),
    encryptionMetadata: z
      .object({ algorithm: z.string().min(1), keyId: z.string().min(1) })
      .strict()
      .optional(),

    acknowledgementRequired: z.boolean(),
  })
  .strict()
  .refine((e) => (e.payload !== undefined) !== (e.payloadRef !== undefined), {
    message:
      "A handoff carries exactly one of payload or payloadRef. Both is two versions of the truth crossing a boundary; neither is a baton with nothing in it.",
    path: ["payload"],
  })
  .refine(
    (e) =>
      !(e.sensitivityClass === "restricted" || e.sensitivityClass === "secret") ||
      e.payloadRef !== undefined,
    {
      message:
        "Restricted and secret content crosses an instance boundary by reference only. An inline protected payload has left its organization and cannot be unsent.",
      path: ["payload"],
    },
  )
  .refine((e) => e.sourceInstanceId !== e.destinationInstanceId, {
    message: "A handoff addressed to its own source is not a crossing.",
    path: ["destinationInstanceId"],
  });
export type HandoffEnvelope = z.infer<typeof handoffEnvelopeSchema>;

export interface LinkVerdict {
  readonly permitted: boolean;
  /** Why, on both answers. A refusal nobody can act on is a refusal twice. */
  readonly reason: string;
}

/**
 * Whether one link permits one handoff.
 *
 * PURE, DENY-BY-DEFAULT, and takes exactly ONE link. There is no second
 * lookup, no graph, no chain — which is how "trust is never transitive"
 * becomes a property of the shape rather than a rule somebody remembers.
 *
 * Every branch names what failed. During an incident the useful question is
 * never "was it refused" but "which of the eight things was wrong".
 */
export function linkPermits(input: {
  link: InstanceLink;
  envelope: HandoffEnvelope;
  now: string;
}): LinkVerdict {
  const { link, envelope } = input;
  const at = Date.parse(input.now);

  // ── The link must actually be this crossing ─────────────────────────────
  //
  // Checked first because a link for a different pair is not a weaker permit,
  // it is a different relationship entirely — and matching on capability
  // before direction would let a valid grant authorize the wrong crossing.
  if (link.sourceInstanceId !== envelope.sourceInstanceId) {
    return {
      permitted: false,
      reason: `This link is from ${link.sourceInstanceId} and the handoff claims ${envelope.sourceInstanceId}.`,
    };
  }
  if (link.destinationInstanceId !== envelope.destinationInstanceId) {
    return {
      permitted: false,
      reason:
        `This link goes to ${link.destinationInstanceId} and the handoff is addressed to ` +
        `${envelope.destinationInstanceId}. A grant to one destination is not a grant to another.`,
    };
  }

  // ── Status and time ─────────────────────────────────────────────────────
  if (link.status !== "active") {
    return {
      permitted: false,
      reason: `Link ${link.linkId} is ${link.status}${link.revocationReason ? `: ${link.revocationReason}` : "."}`,
    };
  }
  if (Number.isNaN(at)) {
    return { permitted: false, reason: "The evaluation time is unparseable, so validity cannot be established." };
  }
  if (at < Date.parse(link.validFrom)) {
    return { permitted: false, reason: `Link ${link.linkId} is not valid until ${link.validFrom}.` };
  }
  if (link.expiresAt && at >= Date.parse(link.expiresAt)) {
    return { permitted: false, reason: `Link ${link.linkId} expired at ${link.expiresAt}.` };
  }

  // ── Capability, contract, purpose ───────────────────────────────────────
  if (!link.allowedCapabilities.includes(envelope.destinationCapability)) {
    return {
      permitted: false,
      reason: `Link ${link.linkId} does not permit ${envelope.destinationCapability}.`,
    };
  }
  if (!link.allowedContractTypes.includes(envelope.contractType)) {
    return {
      permitted: false,
      reason: `Link ${link.linkId} does not carry ${envelope.contractType} contracts.`,
    };
  }
  if (!link.allowedPurposes.includes(envelope.purpose)) {
    return {
      permitted: false,
      reason:
        `Link ${link.linkId} is not authorized for the purpose "${envelope.purpose}". Access for one ` +
        "purpose does not authorize another.",
    };
  }

  // ── Sensitivity ceiling ─────────────────────────────────────────────────
  const order = ["public", "internal", "tenant-confidential", "restricted", "secret"] as const;
  if (order.indexOf(envelope.sensitivityClass) > order.indexOf(link.maxSensitivity)) {
    return {
      permitted: false,
      reason:
        `This handoff is ${envelope.sensitivityClass} and link ${link.linkId} carries at most ` +
        `${link.maxSensitivity}. A link is approved for a sensitivity, not merely for a partner.`,
    };
  }

  return { permitted: true, reason: `Link ${link.linkId} permits this handoff.` };
}

/**
 * Whether trust follows a chain.
 *
 * Always false. A→B and C→B does not create C→A. Enforced structurally —
 * `linkPermits` takes one link and there is no graph to walk — and stated here
 * so a future resolver that "helpfully" followed a second hop fails a test
 * rather than passing review.
 */
export function trustIsTransitive(): false {
  return false;
}

/**
 * Whether a link grants access to the other instance's stores.
 *
 * Always false, and there is no shape in this file that could express it. A
 * link names capabilities, contracts and purposes; none of them is a table, a
 * queue, an index or a cache.
 */
export function linkGrantsDatabaseAccess(): false {
  return false;
}
