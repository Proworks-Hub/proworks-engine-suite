// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The universal structural language.
//
// Foundation Core is AUTHORITATIVE for these definitions (its charter says so).
// The definitions themselves live here, in `contracts`, for a reason the
// dependency law forces:
//
//   ALLOWED_DEPENDENCIES.specialized === ["platform"]
//
// A Specialized engine may not depend on a Core. So if Foundation Core held
// `EngineId` and `TenantId`, CostIQ could not use them — and a universal
// structural language no engine can import is not universal. Putting the types
// in the platform layer and the AUTHORITY over them in Foundation Core is the
// only arrangement that satisfies both the charter and the law.
//
// Foundation owns what these mean and validates them. Everything may read them.
//
// WHY BRANDED TYPES
//
// `EngineId` and `TenantId` are both strings. Without branding, passing one
// where the other belongs compiles — and a tenant id used as an engine id is a
// tenancy bug that typechecks. The brand costs a cast at the boundary and buys
// a whole class of mistake being impossible.
// ─────────────────────────────────────────────────────────────────────────────

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A chartered engine's permanent constitutional identity. */
export type EngineId = Brand<string, "EngineId">;
/** Any recognized component: engine, host, agent, provider, framework. */
export type ComponentId = Brand<string, "ComponentId">;
/** Who is acting. A human, service, engine or agent. */
export type ActorId = Brand<string, "ActorId">;
/** The organization an action is scoped to. */
export type TenantId = Brand<string, "TenantId">;
/** A domain record, owned by whichever engine is authoritative for it. */
export type EntityId = Brand<string, "EntityId">;
/** A thing an action targets. Broader than an entity: a file, a queue, a route. */
export type ResourceId = Brand<string, "ResourceId">;

/** One coordinated execution, possibly spanning engines. */
export type ExecutionId = Brand<string, "ExecutionId">;
/** Groups related activity. */
export type CorrelationId = Brand<string, "CorrelationId">;
/** What caused this. Chains a trace into an order. */
export type CausationId = Brand<string, "CausationId">;
/** One message on the fabric. */
export type MessageId = Brand<string, "MessageId">;
/** One Governance decision. */
export type DecisionId = Brand<string, "DecisionId">;

/**
 * Structural validity only. NOT existence, and NOT authority.
 *
 * Foundation validates that an identifier is well formed. Whether the thing
 * exists is the owning engine's question, and whether you may touch it is
 * Governance's. Charter: "Foundation describes structures. It does not
 * manufacture authority."
 */
const identifierPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export const identifierSchema = z.string().regex(identifierPattern, {
  message:
    "An identifier is 1-128 characters of letters, digits, dot, colon, underscore or hyphen, starting alphanumeric.",
});

/** Casts a validated string into a branded id. Throws on a malformed one. */
function makeIdFactory<T extends string>(): (value: string) => T {
  return (value: string) => {
    const parsed = identifierSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`"${value}" is not a well-formed identifier: ${parsed.error.issues[0]?.message}`);
    }
    return value as T;
  };
}

export const engineId = makeIdFactory<EngineId>();
export const componentId = makeIdFactory<ComponentId>();
export const actorId = makeIdFactory<ActorId>();
export const tenantId = makeIdFactory<TenantId>();
export const entityId = makeIdFactory<EntityId>();
export const resourceId = makeIdFactory<ResourceId>();
export const executionId = makeIdFactory<ExecutionId>();
export const correlationId = makeIdFactory<CorrelationId>();
export const causationId = makeIdFactory<CausationId>();
export const messageId = makeIdFactory<MessageId>();
export const decisionId = makeIdFactory<DecisionId>();

/**
 * What kind of thing a canonical reference points at.
 *
 * Closed on purpose. An open string here would let a reference point at
 * "whatever", and a reference nobody can resolve is a broken link that reads as
 * a working one.
 */
export const referenceKindSchema = z.enum([
  "engine",
  "component",
  "actor",
  "tenant",
  "entity",
  "resource",
  "contract",
  "event",
  "charter",
  "policy",
  "constitution",
  "execution",
  "decision",
]);
export type ReferenceKind = z.infer<typeof referenceKindSchema>;

/**
 * A pointer to something, without carrying the thing.
 *
 * Constitution §23.6 and the reference books both make the same point:
 * "Communication, replication, indexing, caching, analysis, learning,
 * transformation, or possession of another engine's information does not
 * transfer source-of-truth ownership." A reference is how one engine mentions
 * another's data without acquiring it.
 *
 * `ownedBy` is required. A reference that does not say who is authoritative is
 * the beginning of two engines both believing they are.
 */
export const canonicalReferenceSchema = z
  .object({
    kind: referenceKindSchema,
    id: identifierSchema,
    /** The engine authoritative for the referent. */
    ownedBy: identifierSchema,
    /** Scope, when the referent is tenant-scoped. */
    tenant: identifierSchema.optional(),
    /** Which version of the referent, when it is versioned. */
    version: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalReference = z.infer<typeof canonicalReferenceSchema>;

/**
 * A version of something, and what governed it at the time.
 *
 * Constitution §23.12 requires a trusted implementation to be identifiable
 * against the Charter and Constitution versions under which it was validated,
 * and §39 of the foundation directive versions implementation, contract,
 * charter and constitution independently. Four fields because changing one does
 * not imply changing the others.
 */
export const versionReferenceSchema = z
  .object({
    implementationVersion: z.string().min(1),
    contractVersion: z.string().min(1).optional(),
    charterVersion: z.string().min(1).optional(),
    constitutionVersion: z.string().min(1).optional(),
  })
  .strict();
export type VersionReference = z.infer<typeof versionReferenceSchema>;

/** Points at the decision that authorized something. Never the decision itself. */
export const authorityReferenceSchema = z
  .object({
    decisionId: identifierSchema,
    policyId: identifierSchema.optional(),
    policyVersion: z.string().min(1).optional(),
    decidedAt: z.string().min(1),
  })
  .strict();
export type AuthorityReference = z.infer<typeof authorityReferenceSchema>;

export const policyReferenceSchema = z
  .object({
    policyId: identifierSchema,
    version: z.string().min(1),
    /** Verifiable, so a policy cannot be altered without the reference breaking. */
    integrityHash: z.string().min(1).optional(),
  })
  .strict();
export type PolicyReference = z.infer<typeof policyReferenceSchema>;

/**
 * The Hive-level health vocabulary.
 *
 * Five states, per the foundation directive §27. `isolated` is the one that
 * matters most and is easiest to omit: Sentinel containment has no meaning
 * without a state that says "deliberately cut off", and without it an isolated
 * component reports as merely unavailable — which reads as a fault to fix
 * rather than a containment to respect.
 */
export const healthStateSchema = z.enum([
  /** Operating normally. */
  "healthy",
  /** Working, with reduced capability or confidence. Never reduced authority. */
  "degraded",
  /** Coming back. Not yet trustworthy for consequential work. */
  "recovering",
  /** Not answering. A fault. */
  "unavailable",
  /** Deliberately contained. Not a fault — a decision. */
  "isolated",
  /**
   * Nobody has said. NOT a synonym for healthy.
   *
   * Added because SentinelIQ was already returning it through an
   * `as HealthState` cast: with no host self-assessment it refuses to claim
   * health, and the vocabulary had no way to express that, so the value was
   * forced past the type. A consumer switching exhaustively on HealthState
   * would not have handled it.
   *
   * The doctrine was already everywhere else — NOT_ASSESSED for invariants,
   * NOT_RUN for validators, null for score dimensions, INCONCLUSIVE for runs.
   * Health was the one place that could not say it, which is the place it
   * matters most: an unanswered heartbeat is not a healthy one.
   *
   * `acceptsConsequentialWork` is an allowlist, so this is refused work
   * without any change there.
   */
  "unknown",
]);
export type HealthState = z.infer<typeof healthStateSchema>;

/**
 * True when a component may be given consequential work.
 *
 * A function so no call site has to remember that `degraded` is usable and
 * `recovering` is not. Getting that backwards sends work to something that
 * cannot finish it, or withholds work from something that can.
 */
export function acceptsConsequentialWork(state: HealthState): boolean {
  return state === "healthy" || state === "degraded";
}

/**
 * Charter §23.10: "Degraded operation shall never increase authority."
 *
 * Stated as data so a test can assert it and a reviewer can quote it. No health
 * state grants anything — the function exists to make that explicit rather than
 * to compute it.
 */
export function healthGrantsAuthority(_state: HealthState): false {
  return false;
}
