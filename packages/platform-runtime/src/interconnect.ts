// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  handoffEnvelopeSchema,
  instanceLinkSchema,
  linkPermits,
  type HandoffEnvelope,
  type InstanceLink,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// THE DOOR IN THE WALL.
//
// One gateway, and everything crossing an instance boundary goes through it.
// The same shape as the knowledge gateway, for the same reason: a second path
// would be one the signature, link, purpose and compatibility checks do not
// stand in front of, and it would be added by somebody in a hurry.
//
// THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY
//
// Worth arguing with rather than accepting, because it looks arbitrary and is
// not. The directive lists what to verify; it does not say in which order, and
// the order decides what an attacker can learn and what a bug can do.
//
//   SIGNATURE FIRST. Every other field in the envelope — destination, purpose,
//   contract, sensitivity — is a claim written by whoever sent it. Checking
//   any of them before the signature means branching on unverified input. The
//   sender's key is looked up by the CLAIMED source, and a forged claim simply
//   fails: you cannot sign as someone whose key you do not have.
//
//   THEN INTEGRITY. A valid signature over a tampered body is a body somebody
//   else's signature is being reused for.
//
//   THEN DESTINATION. Now that the envelope is authentic, "is this mine" is a
//   question with a trustworthy answer. Opening someone else's mail is the one
//   failure with no remedy.
//
//   THEN THE LINK, purpose, contract, sensitivity — the authorization.
//
//   THEN FRESHNESS AND REPLAY. Deliberately after authorization: an
//   unauthorized party should not be able to probe which idempotency keys this
//   instance has seen by watching which duplicates are rejected differently.
//
//   THEN COMPATIBILITY, last, because an incompatible contract from an
//   authorized partner is an operational problem and deserves an actionable
//   answer, while the same from a stranger deserves nothing.
//
// NO CRYPTOGRAPHY IS IMPLEMENTED HERE
//
// `EnvelopeVerifier` is a port. This file computes no digests and holds no
// keys; a host binds a real implementation. Home-grown cryptography is
// forbidden and this is how that rule survives contact with a deadline.
// ─────────────────────────────────────────────────────────────────────────────

export interface VerificationOutcome {
  readonly valid: boolean;
  readonly reason: string;
}

/**
 * Cryptographic services, injected.
 *
 * Two separate questions and not one: a signature proves WHO, an integrity
 * hash proves WHAT. A verifier that answered both with one boolean would make
 * a tampered body indistinguishable from a forged sender.
 */
export interface EnvelopeVerifier {
  /** Whether the sender's signature over this envelope is genuine. */
  verifySignature(envelope: HandoffEnvelope): VerificationOutcome;
  /** Whether the body still matches its integrity hash. */
  verifyIntegrity(envelope: HandoffEnvelope): VerificationOutcome;
}

/**
 * Where relationships, seen keys and the chain of custody live.
 *
 * Caught by the durability guard for the second time this session, on a module
 * written well after that guard existed — and here the restart behaviour would
 * have been genuinely bad rather than merely inconvenient:
 *
 *   A REVOKED LINK would come back. Restarting would undo a revocation, which
 *   makes restarting the way to restore a relationship somebody ended.
 *
 *   SEEN IDEMPOTENCY KEYS would be forgotten, so a partner's retry after an
 *   outage would create a second piece of downstream work — precisely the
 *   thing the key exists to prevent, failing at precisely the moment retries
 *   are most likely.
 *
 *   THE CHAIN OF CUSTODY would be lost, and it is the evidence that only
 *   matters after something has gone wrong.
 */
export interface InterconnectStore {
  readonly durability: "in-memory" | "durable";
  link(source: string, destination: string): InstanceLink | null;
  putLink(link: InstanceLink): void;
  links(): readonly InstanceLink[];
  hasSeen(scopedIdempotencyKey: string): boolean;
  markSeen(scopedIdempotencyKey: string): void;
  appendLedger(entry: InterconnectLedgerEntry): void;
  ledger(): readonly InterconnectLedgerEntry[];
}

export function createInMemoryInterconnectStore(): InterconnectStore {
  const linksByDirection = new Map<string, InstanceLink>();
  const seenKeys = new Set<string>();
  const entries: InterconnectLedgerEntry[] = [];
  const key = (source: string, destination: string) => `${source}->${destination}`;
  return {
    durability: "in-memory",
    link: (source, destination) => linksByDirection.get(key(source, destination)) ?? null,
    putLink: (l) => {
      linksByDirection.set(key(l.sourceInstanceId, l.destinationInstanceId), l);
    },
    links: () => [...linksByDirection.values()],
    hasSeen: (k) => seenKeys.has(k),
    markSeen: (k) => {
      seenKeys.add(k);
    },
    appendLedger: (e) => {
      entries.push(e);
    },
    ledger: () => entries,
  };
}

export interface RelationshipRegistry {
  /** Records an approved link. */
  grant(input: unknown): { granted: true; link: InstanceLink } | { granted: false; reason: string };
  /** Ends one. The record stays. */
  revoke(linkId: string, reason: string, by: string): { revoked: boolean; reason: string };
  /**
   * The link for exactly this direction, or null.
   *
   * Deliberately not `linksFor(instance)`. A method returning every link an
   * instance holds is one a caller can iterate looking for any that fits, and
   * "any link that fits" is how transitive trust gets reinvented.
   */
  linkFor(sourceInstanceId: string, destinationInstanceId: string): InstanceLink | null;
  all(): readonly InstanceLink[];
  /** Whether relationships survive a restart. */
  durability(): "in-memory" | "durable";
}

export function createRelationshipRegistry(store?: InterconnectStore): RelationshipRegistry {
  const held = store ?? createInMemoryInterconnectStore();

  return {
    grant(input) {
      const parsed = instanceLinkSchema.safeParse(input);
      if (!parsed.success) {
        return { granted: false, reason: `Not a valid link: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const link = parsed.data;
      const existing = held.link(link.sourceInstanceId, link.destinationInstanceId);
      if (existing && existing.status === "active") {
        return {
          granted: false,
          reason: `An active link already exists from ${link.sourceInstanceId} to ${link.destinationInstanceId}. Widening a relationship is an amendment to that link, not a second one — two links for one direction would make "what may they send" a question with two answers.`,
        };
      }
      held.putLink(link);
      return { granted: true, link };
    },

    revoke(linkId, reason, by) {
      for (const link of held.links()) {
        if (link.linkId !== linkId) continue;
        if (link.status === "revoked") return { revoked: false, reason: "Already revoked." };
        held.putLink({
          ...link,
          status: "revoked",
          revocationReason: `${reason} (revoked by ${by})`,
        });
        return { revoked: true, reason: "Revoked; the record remains so past transfers stay explicable." };
      }
      return { revoked: false, reason: `No link ${linkId}.` };
    },

    linkFor: (source, destination) => held.link(source, destination),
    all: () => held.links(),
    durability: () => held.durability,
  };
}

/** Where an accepted handoff's metadata is recorded. Never its payload. */
export interface InterconnectLedgerEntry {
  readonly envelopeId: string;
  readonly globalCorrelationId: string;
  readonly sourceInstanceId: string;
  readonly destinationInstanceId: string;
  readonly contractType: string;
  readonly purpose: string;
  readonly linkId: string | null;
  readonly outcome: "accepted" | "refused";
  readonly reason: string;
  readonly at: string;
}

export type AcceptResult =
  | {
      readonly accepted: true;
      readonly envelope: HandoffEnvelope;
      readonly duplicate: boolean;
      readonly reason: string;
    }
  | { readonly accepted: false; readonly reason: string; readonly stage: AcceptStage };

/** Which check refused. Named so an operator is not left guessing. */
export type AcceptStage =
  | "malformed"
  | "signature"
  | "integrity"
  | "destination"
  | "authorization"
  | "freshness"
  | "compatibility";

export interface InterconnectGateway {
  /** The only way in. */
  accept(input: unknown): AcceptResult;
  /** Every decision, accepted and refused. Metadata only. */
  ledger(): readonly InterconnectLedgerEntry[];
  /** Whether the ledger and seen keys survive a restart. */
  durability(): "in-memory" | "durable";
}

export interface InterconnectGatewayOptions {
  /** Which instance this gateway defends. Never read from the envelope. */
  readonly instanceId: string;
  readonly relationships: RelationshipRegistry;
  readonly verifier: EnvelopeVerifier;
  /**
   * Where the ledger and seen idempotency keys live.
   *
   * Bind the SAME store the relationship registry uses: a gateway whose links
   * came from one place and whose seen keys came from another would enforce
   * two halves of one decision from two different points in time.
   */
  readonly store?: InterconnectStore;
  /**
   * Whether this instance can handle a contract version.
   *
   * A port, because compatibility is the receiver's question and depends on
   * what it is actually running.
   */
  readonly supports: (contractType: string, contractVersion: string) => VerificationOutcome;
  readonly now?: () => Date;
  readonly onDecision?: (entry: InterconnectLedgerEntry) => void;
}

export function createInterconnectGateway(
  options: InterconnectGatewayOptions,
): InterconnectGateway {
  const now = options.now ?? (() => new Date());
  const held = options.store ?? createInMemoryInterconnectStore();

  const record = (
    envelope: HandoffEnvelope | null,
    outcome: "accepted" | "refused",
    reason: string,
    linkId: string | null,
  ): void => {
    const entry: InterconnectLedgerEntry = {
      envelopeId: envelope?.envelopeId ?? "unparseable",
      globalCorrelationId: envelope?.globalCorrelationId ?? "unknown",
      sourceInstanceId: envelope?.sourceInstanceId ?? "unknown",
      destinationInstanceId: envelope?.destinationInstanceId ?? options.instanceId,
      contractType: envelope?.contractType ?? "unknown",
      purpose: envelope?.purpose ?? "unknown",
      linkId,
      outcome,
      reason,
      at: now().toISOString(),
    };
    held.appendLedger(entry);
    options.onDecision?.(entry);
  };

  const refuse = (
    envelope: HandoffEnvelope | null,
    stage: AcceptStage,
    reason: string,
    linkId: string | null = null,
  ): AcceptResult => {
    record(envelope, "refused", `${stage}: ${reason}`, linkId);
    return { accepted: false, reason, stage };
  };

  return {
    accept(input) {
      const parsed = handoffEnvelopeSchema.safeParse(input);
      if (!parsed.success) {
        return refuse(null, "malformed", `Not a valid handoff: ${JSON.stringify(parsed.error.flatten())}`);
      }
      const envelope = parsed.data;

      // ── 1. Signature ──────────────────────────────────────────────────
      //
      // Before anything else reads a field. Everything below this line is a
      // claim until this passes.
      const signature = options.verifier.verifySignature(envelope);
      if (!signature.valid) {
        return refuse(envelope, "signature", `Sender signature rejected: ${signature.reason}`);
      }

      // ── 2. Integrity ──────────────────────────────────────────────────
      const integrity = options.verifier.verifyIntegrity(envelope);
      if (!integrity.valid) {
        return refuse(
          envelope,
          "integrity",
          `The body does not match its hash: ${integrity.reason}. A valid signature over a tampered body is somebody else's signature being reused.`,
        );
      }

      // ── 3. Destination ────────────────────────────────────────────────
      //
      // From configuration, never from the envelope. Opening somebody else's
      // mail is the one failure with no remedy afterwards.
      if (envelope.destinationInstanceId !== options.instanceId) {
        return refuse(
          envelope,
          "destination",
          `This gateway is ${options.instanceId} and the handoff is addressed to ${envelope.destinationInstanceId}.`,
        );
      }

      // ── 4. Authorization ──────────────────────────────────────────────
      //
      // ONE lookup, for exactly this direction. No search, no fallback, no
      // second hop — which is what makes non-transitivity structural.
      const link = options.relationships.linkFor(
        envelope.sourceInstanceId,
        envelope.destinationInstanceId,
      );
      if (!link) {
        return refuse(
          envelope,
          "authorization",
          `No link authorizes ${envelope.sourceInstanceId} to send to ${envelope.destinationInstanceId}. Deny by default: an absent relationship is not a weak permission, it is none.`,
        );
      }

      const verdict = linkPermits({ link, envelope, now: now().toISOString() });
      if (!verdict.permitted) {
        return refuse(envelope, "authorization", verdict.reason, link.linkId);
      }

      // ── 5. Freshness and replay ───────────────────────────────────────
      //
      // After authorization on purpose: an unauthorized sender must not be
      // able to probe which idempotency keys this instance has already seen by
      // watching which duplicates are refused differently.
      if (envelope.expiresAt && now().getTime() >= Date.parse(envelope.expiresAt)) {
        return refuse(envelope, "freshness", `This handoff expired at ${envelope.expiresAt}.`, link.linkId);
      }

      // Scoped by source. Two instances that independently chose the same
      // idempotency key are describing two different operations.
      const idempotencyKey = `${envelope.sourceInstanceId}|${envelope.idempotencyKey}`;
      if (held.hasSeen(idempotencyKey)) {
        // ACCEPTED, and flagged. A duplicate is the sender retrying, not an
        // error — refusing it would make a lost acknowledgement into a stuck
        // workflow. The caller performs no new work because `duplicate` says
        // not to.
        record(envelope, "accepted", "Duplicate; no new work.", link.linkId);
        return {
          accepted: true,
          envelope,
          duplicate: true,
          reason:
            "This idempotency key has been seen from this source. The handoff is acknowledged and creates no further downstream work.",
        };
      }

      // ── 6. Compatibility ──────────────────────────────────────────────
      //
      // Last, and actionable: an authorized partner sending a version we
      // cannot read deserves to be told which version we speak.
      const compatible = options.supports(envelope.contractType, envelope.contractVersion);
      if (!compatible.valid) {
        return refuse(envelope, "compatibility", compatible.reason, link.linkId);
      }

      held.markSeen(idempotencyKey);
      record(envelope, "accepted", "Accepted.", link.linkId);
      return {
        accepted: true,
        envelope,
        duplicate: false,
        reason: `Accepted under link ${link.linkId}.`,
      };
    },

    ledger: () => [...held.ledger()],
    durability: () => held.durability,
  };
}

/**
 * Whether the interconnect ledger holds payloads.
 *
 * Always false. It records who sent what kind of thing to whom, under which
 * link, and what was decided. A ledger that kept the payloads would be the
 * global raw-payload store the architecture exists to avoid — arrived at
 * through the audit trail rather than the database.
 */
export function ledgerStoresPayloads(): false {
  return false;
}

/**
 * Whether a gateway may accept a handoff addressed elsewhere.
 *
 * Always false. The destination comes from configuration and the check has no
 * override, because a gateway that could be argued into opening another
 * instance's mail is not a boundary.
 */
export function gatewayMayOpenOthersMail(): false {
  return false;
}
