// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import {
  coreRequest,
  createCoordinator,
  createSpecialistRegistry,
  defaultAuthorityFor,
  type AuthorityEnvelope,
  type CoreAnswer,
  type CoreFailure,
  type CoreRefusal,
  type CoreRequest,
  type Coordinator,
  type Governance,
  type Specialist,
  type SpecialistRegistry,
} from "./deps.js";
import { deliverableTo, type HiveMessage } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Communication Core: the universal language of exchange.
//
// Charter: "How is information communicated reliably, in the right form, to the
// right participant?" It "may define messages, events, sender/recipient
// references, channels, delivery state, acknowledgments, subscriptions,
// correlation, priority, expiration, and communication provenance."
//
// THREE CHARTER RULES, WRITTEN AS CODE RATHER THAN PROSE
//
//   "Communication does not gain ownership over the information it transports."
//   "Receiving a message does not prove the message is authorized."
//   "Routing capability shall never be interpreted as authorization to cross
//    tenant boundaries."
//
// All three are the same failure in different clothes: mistaking the ability to
// MOVE something for the right to act on it. Each has a function and a test.
//
// THIS IS NOT EVENTIQ
//
// Charter: Communication "does not replace EventIQ, NotificationIQ,
// IntegrationIQ, email providers, messaging providers, or external
// communication systems. It provides the common foundation upon which those
// capabilities operate."
//
// So there is no bus here, no queue, no subscription store and no delivery
// loop. This defines what a delivery guarantee MEANS, what an acknowledgement
// IS, and when a message has expired. EventIQ implements durable asynchronous
// movement against those definitions later, and is one specialist among
// several — direct contracts and synchronous calls are equally legitimate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The delivery vocabulary.
 *
 * DECLARED IN `contracts`, OWNED HERE.
 *
 * These shapes were written in this file and moved to `@proworks-hub/contracts`
 * when EventIQ arrived: the dependency law says `platform: []`, so a Shared
 * Platform engine may import nothing in the tier system — and a vocabulary the
 * engine implementing it may not import is not a vocabulary. Wave B moved the
 * identifier types for the identical reason.
 *
 * Communication Core still owns what these words MEAN. EventIQ operationalizes
 * them; it does not get to redefine them.
 */
export {
  deliveryGuaranteeSchema,
  orderingScopeSchema,
  deliveryExpectationSchema,
  acknowledgementSchema,
  shouldRetry,
  hasExpired,
} from "@proworks-hub/contracts";
export type {
  DeliveryGuarantee,
  OrderingScope,
  DeliveryExpectation,
  Acknowledgement,
} from "@proworks-hub/contracts";

// ── The three charter rules ──────────────────────────────────────────────────

/**
 * Charter: "Communication does not gain ownership over the information it
 * transports."
 *
 * Returns the owner named on the message, never the transporter. Stated as a
 * function so that "who owns this now" has one answer that cannot drift toward
 * whoever last handled it.
 */
export function ownerAfterTransport(message: HiveMessage): string {
  return message.producerId;
}

export type DeliverabilityVerdict =
  | { readonly deliverable: true }
  | { readonly deliverable: false; readonly reason: string };

/**
 * Whether a message may be DELIVERED to a consumer in a tenant.
 *
 * Charter: "Routing capability shall never be interpreted as authorization to
 * cross tenant boundaries."
 *
 * This answers ONE question — does the tenant boundary permit this hop — and
 * deliberately not "may the recipient act on it". A `deliverable: true` is not
 * a permission; it means only that delivering does not cross a tenant. The
 * recipient still needs Governance before doing anything, and the name says
 * `deliverable` rather than `allowed` so the two cannot be confused at a call
 * site.
 */
export function checkDeliverability(message: HiveMessage, consumerTenant: string): DeliverabilityVerdict {
  if (deliverableTo(message, consumerTenant)) return { deliverable: true };
  return {
    deliverable: false,
    reason:
      `A message scoped to "${message.tenant?.organizationId ?? "no tenant"}" may not be delivered to a consumer ` +
      `in "${consumerTenant}". Routing capability is never authorization to cross a tenant boundary.`,
  };
}

/**
 * Charter: "Receiving a message does not prove the message is authorized."
 *
 * Always false. It exists to be called, and to be a named place where the rule
 * is stated — a caller reaching for "is this trusted because it arrived" finds
 * a function that says no rather than an absence they interpret as yes.
 */
export function receiptImpliesAuthorization(_message: HiveMessage): false {
  return false;
}

// ── The Core ─────────────────────────────────────────────────────────────────

/**
 * What the communication domain can be asked.
 *
 * Notice what is NOT here: `publish`, `send`, `subscribe`, `deliver`. Those are
 * a bus, and Communication Core is not one. These are questions about
 * communication, which is what a Core coordinates.
 */
export const communicationCapabilitySchema = z.enum([
  /** What guarantees apply to this class of message? */
  "resolve_delivery_expectation",
  /** Record what a recipient said back. */
  "record_acknowledgement",
  /** Which channel is appropriate, given the message and recipient? */
  "resolve_channel",
  /** Has this message stopped being worth delivering? */
  "check_expiry",
]);
export type CommunicationCapability = z.infer<typeof communicationCapabilitySchema>;

export type CommunicationSpecialist = Specialist<CommunicationCapability>;
export type CommunicationRegistry = SpecialistRegistry<CommunicationCapability>;
export type CommunicationRequest<TInput = unknown> = CoreRequest<CommunicationCapability, TInput>;
export type CommunicationAnswer<TOutput = unknown> = CoreAnswer<CommunicationCapability, TOutput>;
export type CommunicationRefusal = CoreRefusal<CommunicationCapability>;
export type CommunicationFailure = CoreFailure;
export type CommunicationCoordinator = Coordinator<CommunicationCapability>;

export function createCommunicationRegistry(
  specialists: readonly CommunicationSpecialist[] = [],
): CommunicationRegistry {
  return createSpecialistRegistry(specialists);
}

export interface CommunicationCoordinatorOptions {
  registry: CommunicationRegistry;
  /** REQUIRED, like every Core. */
  governance: Governance;
  authorityFor?: (request: CommunicationRequest) => AuthorityEnvelope;
  timeoutMs?: number;
  allowFallback?: boolean;
  now?: () => number;
  onAttempt?: Parameters<typeof createCoordinator<CommunicationCapability>>[0]["onAttempt"];
}

export function createCommunicationCoordinator(
  options: CommunicationCoordinatorOptions,
): CommunicationCoordinator {
  return createCoordinator<CommunicationCapability>({
    core: "communication",
    registry: options.registry,
    governance: options.governance,
    authorityFor: options.authorityFor ?? defaultAuthorityFor,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.allowFallback === undefined ? {} : { allowFallback: options.allowFallback }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }),
  });
}

export function communicationRequest<TInput>(input: {
  capability: CommunicationCapability;
  input: TInput;
  context: Parameters<typeof coreRequest<CommunicationCapability, TInput>>[0]["context"];
  correlationId: string;
  causationId?: string;
}): CommunicationRequest<TInput> {
  return coreRequest(input);
}
