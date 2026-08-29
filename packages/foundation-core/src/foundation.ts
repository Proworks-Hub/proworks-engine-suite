// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import {
  canonicalReferenceSchema,
  coreRequest,
  createCoordinator,
  createSpecialistRegistry,
  defaultAuthorityFor,
  healthStateSchema,
  identifierSchema,
  versionReferenceSchema,
  type AuthorityEnvelope,
  type CanonicalReference,
  type CoreAnswer,
  type CoreFailure,
  type CoreRefusal,
  type CoreRequest,
  type Coordinator,
  type Governance,
  type HealthState,
  type Specialist,
  type SpecialistRegistry,
  type VersionReference,
} from "./deps.js";

// ─────────────────────────────────────────────────────────────────────────────
// Foundation Core: the universal structural language.
//
// Charter: "Foundation answers: what are the fundamental things that exist,
// how are they identified, referenced, versioned and related?" And the boundary
// that shapes every line below:
//
//   "Foundation describes structures. It does not manufacture authority."
//
// WHERE THE TYPES LIVE, AND WHY NOT HERE
//
// The identifier and reference TYPES are in `@proworks-hub/contracts`, not in
// this package, and that is forced by the dependency law rather than chosen for
// convenience:
//
//   ALLOWED_DEPENDENCIES.specialized === ["platform"]
//
// A Specialized engine may not depend on a Core. Had `EngineId` lived here,
// CostIQ could not have imported it — and a universal structural language that
// no engine may import is not universal.
//
// So: the definitions sit in the platform layer where everything may read them,
// and Foundation Core holds AUTHORITY over what they mean — validation,
// minting, relationship rules, and the vocabulary of what may be referenced.
// The charter's ownership and the law's direction are both satisfied.
//
// WHAT FOUNDATION MUST NEVER BECOME
//
// Charter, verbatim: it "may not independently authorize actions, create
// permissions, elevate users, grant engine authority, change Governance policy,
// override Sentinel, or infer authority from relationships."
//
// The last clause is the subtle one. Foundation knows that actor A relates to
// tenant T. It must never conclude that A may therefore act on T's behalf.
// Relationship is structure; permission is Governance. `relate()` below returns
// a relationship and nothing that resembles a grant.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the foundational domain can be asked.
 *
 * Named for the question, and deliberately small. Charter Core Stability
 * Principle: capabilities are not added to a Core because they are useful.
 */
export const foundationCapabilitySchema = z.enum([
  /** Is this identifier well formed? Structure only — not existence. */
  "validate_identifier",
  /** Mint a new scoped identifier. */
  "mint_identifier",
  /** Build or check a canonical reference. */
  "resolve_reference",
  /** Record or read a structural relationship between two references. */
  "relate_entities",
  /** Compare version references for compatibility. */
  "compare_versions",
]);
export type FoundationCapability = z.infer<typeof foundationCapabilitySchema>;

export type FoundationSpecialist = Specialist<FoundationCapability>;
export type FoundationRegistry = SpecialistRegistry<FoundationCapability>;
export type FoundationRequest<TInput = unknown> = CoreRequest<FoundationCapability, TInput>;
export type FoundationAnswer<TOutput = unknown> = CoreAnswer<FoundationCapability, TOutput>;
export type FoundationRefusal = CoreRefusal<FoundationCapability>;
export type FoundationFailure = CoreFailure;
export type FoundationCoordinator = Coordinator<FoundationCapability>;

export function createFoundationRegistry(
  specialists: readonly FoundationSpecialist[] = [],
): FoundationRegistry {
  return createSpecialistRegistry(specialists);
}

export interface FoundationCoordinatorOptions {
  registry: FoundationRegistry;
  /** REQUIRED. Foundation coordinates like every other Core, and is governed. */
  governance: Governance;
  authorityFor?: (request: FoundationRequest) => AuthorityEnvelope;
  timeoutMs?: number;
  allowFallback?: boolean;
  now?: () => number;
  onAttempt?: Parameters<typeof createCoordinator<FoundationCapability>>[0]["onAttempt"];
}

export function createFoundationCoordinator(
  options: FoundationCoordinatorOptions,
): FoundationCoordinator {
  return createCoordinator<FoundationCapability>({
    core: "foundation",
    registry: options.registry,
    governance: options.governance,
    authorityFor: options.authorityFor ?? defaultAuthorityFor,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.allowFallback === undefined ? {} : { allowFallback: options.allowFallback }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }),
  });
}

export function foundationRequest<TInput>(input: {
  capability: FoundationCapability;
  input: TInput;
  context: Parameters<typeof coreRequest<FoundationCapability, TInput>>[0]["context"];
  correlationId: string;
  causationId?: string;
}): FoundationRequest<TInput> {
  return coreRequest(input);
}

// ── The structural rules Foundation is authoritative for ─────────────────────

export type ValidationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Structural validity of an identifier.
 *
 * Says nothing about whether the thing exists, and nothing about whether the
 * caller may touch it. A caller that treats `ok: true` as "found" or "allowed"
 * has made the mistake this comment exists to prevent.
 */
export function validateIdentifier(value: unknown): ValidationOutcome {
  const parsed = identifierSchema.safeParse(value);
  return parsed.success
    ? { ok: true }
    : {
        ok: false,
        reason: `${parsed.error.issues[0]?.message ?? "Malformed identifier."} Structural validity only — this says nothing about existence or permission.`,
      };
}

export interface MintOptions {
  /** What kind of thing is being identified. */
  kind: string;
  /** Injectable for deterministic tests. */
  random?: () => string;
}

/**
 * Mints a scoped identifier.
 *
 * Prefixed by kind so a misplaced identifier is visible on sight: `eng_` in a
 * tenant field is obvious, where a bare UUID is not. That is the same reasoning
 * as the branded types, applied at runtime for values that cross a wire.
 */
export function mintIdentifier(options: MintOptions): string {
  const kindPart = options.kind.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!kindPart) throw new Error("An identifier needs a kind. An unkinded id cannot be recognized when misplaced.");
  const random = options.random ?? (() => Math.random().toString(36).slice(2, 12));
  return `${kindPart}_${random()}`;
}

/**
 * Builds a canonical reference, refusing a malformed one.
 *
 * Refuses rather than returning a partial reference: a reference missing its
 * owner is the beginning of two engines both believing they are authoritative.
 */
export function buildReference(input: unknown): CanonicalReference {
  const parsed = canonicalReferenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Not a canonical reference: ${JSON.stringify(parsed.error.flatten())}. ` +
        "Every reference must name what it points at and which engine owns it.",
    );
  }
  return parsed.data;
}

/** How two things are structurally related. Closed, because an open vocabulary
 *  is one where "related" eventually means "may act upon". */
export const relationshipKindSchema = z.enum([
  "belongs_to",
  "derived_from",
  "supersedes",
  "references",
  "contains",
]);
export type RelationshipKind = z.infer<typeof relationshipKindSchema>;

export const relationshipSchema = z
  .object({
    from: canonicalReferenceSchema,
    kind: relationshipKindSchema,
    to: canonicalReferenceSchema,
    recordedAt: z.string().min(1),
  })
  .strict();
export type Relationship = z.infer<typeof relationshipSchema>;

/**
 * Records a structural relationship.
 *
 * Charter authority boundary: Foundation may not "infer authority from
 * relationships." This returns a relationship and nothing else — no implied
 * access, no derived permission, no capability list. If a caller wants to know
 * whether the relationship permits something, that is a question for
 * Governance, and it has to be asked separately.
 */
export function relate(
  from: CanonicalReference,
  kind: RelationshipKind,
  to: CanonicalReference,
  at: string,
): Relationship {
  return relationshipSchema.parse({ from, kind, to, recordedAt: at });
}

/**
 * Whether a consumer built against `required` can use `available`.
 *
 * Compares only what is present on BOTH sides. A consumer that states no
 * charter requirement is not asserting compatibility with every charter — it is
 * declining to constrain that dimension, and treating silence as a constraint
 * would reject working pairs.
 */
export function versionsCompatible(
  required: VersionReference,
  available: VersionReference,
): ValidationOutcome {
  const majorOf = (v: string): string => (v.split(".")[0] ?? v);

  const checks: Array<[string, string | undefined, string | undefined]> = [
    ["implementation", required.implementationVersion, available.implementationVersion],
    ["contract", required.contractVersion, available.contractVersion],
    ["charter", required.charterVersion, available.charterVersion],
    ["constitution", required.constitutionVersion, available.constitutionVersion],
  ];

  for (const [label, want, have] of checks) {
    if (!want || !have) continue;
    if (majorOf(want) !== majorOf(have)) {
      return {
        ok: false,
        reason: `Incompatible ${label} version: requires ${want}, found ${have}. Major versions differ.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Parses a health state, refusing an unknown one.
 *
 * Unknown is not treated as `unavailable`. A component reporting a state this
 * Hive does not recognize is a component nobody should assume anything about,
 * and quietly mapping it to a known state invents information.
 */
export function parseHealthState(value: unknown): HealthState | null {
  const parsed = healthStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export { versionReferenceSchema };
