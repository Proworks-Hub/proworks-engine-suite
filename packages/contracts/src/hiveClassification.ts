// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { HiveTier } from "./hiveArchitecture.js";

// ─────────────────────────────────────────────────────────────────────────────
// Hive classification: the constitutional plane and the capability plane.
//
// `hiveArchitecture.ts` models the CAPABILITY hierarchy — Core, Specialized,
// Industry and the platform beneath them — and enforces a downward-only
// dependency law over it. That model is sound and is left intact.
//
// What it could not express is the constitutional plane. Governance, Sentinel,
// Foundry, ARIA and Prime are not reusable capability layers and do not sit in
// a dependency matrix with them:
//
//   Governance AUTHORIZES across the system.
//   Sentinel OBSERVES across the system.
//   Foundry INSPECTS AND EVOLVES across the system.
//   ARIA REASONS across the system, as authorized.
//   Prime COORDINATES authorized work across the system.
//
// "Across" is the word the tier matrix cannot represent. A tier is a position
// in a hierarchy; these are relationships to the whole. Forcing them into the
// matrix would either make them depend on everything — which inverts the
// dependency law — or make everything depend on them, which is worse, because
// a Specialized engine that imports Governance is no longer portable.
//
// So: two planes, one classification vocabulary. Classification says WHAT a
// component constitutionally is. Tier says where a CAPABILITY component sits
// for dependency purposes, and applies only to the capability plane.
//
// WHAT IS DELIBERATELY NOT HERE
//
// Overwatch has no classification. It is the coordination framework formed by
// Governance, Sentinel and Foundry together — a relationship, not a component.
// Giving it an enum member would invite somebody to build it, and the thing
// they built would not be the concept.
//
// RepairBots have no classification either. They are Foundry-scoped agents
// holding a leased subset of Foundry's authority, and an agent is not an
// engine. They are identified by lease, not by classification.
//
// The Information Fabric has no classification. It is the governed
// communication substrate formed from Communication Core, EventIQ, engine
// contracts, IntegrationIQ, Governance, IdentityIQ, AuditIQ and Prime. There is
// no single component to classify, and building one would centralize exactly
// what the Fabric exists to keep distributed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What KIND of thing a component is, before asking what class of engine it is.
 *
 * DEC-005. `HOST` was briefly an engine classification here, and that was a
 * category error: approved §23.3 recognizes four capability-layer engine
 * classifications — Core, Shared Platform, Specialized, Industry — and the
 * glossary defines a Host Application as something that consumes Hive
 * capabilities "without owning the engines providing them". A Host is not an
 * engine, so it cannot hold an engine classification.
 *
 * Only `ENGINE` carries a `HiveClassification`. Everything else is a component
 * the Hive recognizes without chartering as an engine — which is precisely why
 * agents, hosts and frameworks kept needing exceptions in the old model.
 */
export const componentKindSchema = z.enum([
  /** A chartered engine. The only kind that carries an EngineClassification. */
  "ENGINE",
  /** Consumes Hive capability. Owns its own experience, never a portable engine. */
  "HOST_APPLICATION",
  /** Operates under a leased subset of another component's authority. */
  "AGENT",
  /** Outside the trust boundary. A dependency, never an authority. */
  "EXTERNAL_PROVIDER",
  /** A coordination relationship between components, such as Overwatch. */
  "FRAMEWORK",
]);
export type ComponentKind = z.infer<typeof componentKindSchema>;

/** True only for the one kind that may carry an engine classification. */
export function carriesEngineClassification(kind: ComponentKind): boolean {
  return kind === "ENGINE";
}

/**
 * What a component constitutionally is.
 *
 * The identifiers are the directive's own, verbatim, because this vocabulary is
 * quoted in charters and amendments and a paraphrase would be a second name for
 * the same thing.
 *
 * NO HIERARCHY IS IMPLIED AMONG THE CONSTITUTIONAL CLASSES. They appear in an
 * order because an enum has one. Governance does not outrank Sentinel because
 * it is listed first.
 */
export const hiveClassificationSchema = z.enum([
  // ── Constitutional plane ───────────────────────────────────────────────────
  /** Determines whether consequential activity is permitted. */
  "CONSTITUTIONAL_GOVERNANCE",
  /** Independently monitors, protects, contains, validates integrity. */
  "CONSTITUTIONAL_SENTINEL",
  /** Designs, repairs, validates, refactors, evolves and maintains the Hive. */
  "CONSTITUTIONAL_EVOLUTION",
  /** Cross-Hive reasoning and advice. Advises; never authorizes. */
  "CONSTITUTIONAL_INTELLIGENCE",
  /** Coordinates authorized work. One Prime, with Nexus and Pulse chambers. */
  "CONSTITUTIONAL_ORCHESTRATION",

  // ── Capability plane ───────────────────────────────────────────────────────
  /** One of the eight Core domain coordinators. */
  "CORE",
  /** Reusable infrastructure available to any engine. */
  "SHARED_PLATFORM",
  /** A portable engine owning one domain capability. */
  "SPECIALIZED",
  /** An industry pack composing reusable capabilities. */
  "INDUSTRY",
]);
export type HiveClassification = z.infer<typeof hiveClassificationSchema>;

const CONSTITUTIONAL: ReadonlySet<HiveClassification> = new Set([
  "CONSTITUTIONAL_GOVERNANCE",
  "CONSTITUTIONAL_SENTINEL",
  "CONSTITUTIONAL_EVOLUTION",
  "CONSTITUTIONAL_INTELLIGENCE",
  "CONSTITUTIONAL_ORCHESTRATION",
]);

/**
 * True for the constitutional plane.
 *
 * The distinction that matters operationally: the capability-tier dependency
 * law applies to the capability plane and does not govern these.
 */
export function isConstitutional(classification: HiveClassification): boolean {
  return CONSTITUTIONAL.has(classification);
}

/** The three that together form Overwatch. Overwatch itself is not a member. */
export const OVERWATCH_MEMBERS: readonly HiveClassification[] = [
  "CONSTITUTIONAL_GOVERNANCE",
  "CONSTITUTIONAL_SENTINEL",
  "CONSTITUTIONAL_EVOLUTION",
];

/**
 * The capability tier a classification maps to, or `null` for the
 * constitutional plane.
 *
 * `null` is the point. A caller asking "which tier is Governance in" is asking
 * a question with no answer, and returning a plausible tier would let the
 * dependency checker silently accept a constitutional dependency it has no
 * basis to judge.
 */
export function tierFor(classification: HiveClassification): HiveTier | null {
  switch (classification) {
    case "CORE":
      return "core";
    case "SHARED_PLATFORM":
      return "platform";
    case "SPECIALIZED":
      return "specialized";
    case "INDUSTRY":
      return "industry";
    default:
      return null;
  }
}

/**
 * Which structural band of the Hive a component occupies.
 *
 * DERIVED from `HiveClassification`, never chosen. A hand-picked band is a
 * second opinion about what a component is, and the two opinions drift — which
 * is already observable in `hiveMap.ts`, where four constitutionally-classified
 * components carry `tier: "platform"`.
 *
 * This is not `HiveTier`. `tierFor` answers a DEPENDENCY question and correctly
 * returns `null` for the constitutional plane, because asking which tier
 * Governance depends from has no answer. This answers a STRUCTURAL one — where
 * a component sits relative to the work hierarchy — which every component has,
 * including the ones with no tier.
 *
 * NOT NAMED `overwatch`, deliberately, and the reason is load-bearing:
 * Overwatch is Governance + Sentinel + Evolution — see `OVERWATCH_MEMBERS`,
 * which is three. ARIA is not a member. A band named `overwatch` holding
 * `CONSTITUTIONAL_INTELLIGENCE` would assert by placement that ARIA holds
 * constraining authority, when ARIA advises and never authorizes. Naming the
 * band for the set it actually contains avoids making that claim.
 */
export const hiveLayerSchema = z.enum([
  /** Coordinates authorized work. Inside the hierarchy, subordinate to it. */
  "prime",
  /** Acts upon the whole system rather than sitting within it. */
  "constitutional",
  /** One of the domain Cores. */
  "core",
  /** A portable engine under a Core. */
  "specialized",
  /** An industry pack composing capabilities. */
  "industry",
  /** Reusable infrastructure beneath the engines. */
  "platform",
  /**
   * A component the Hive runs but has not classified.
   *
   * Exists so an unratified component can be rendered truthfully instead of
   * being assigned a classification it does not hold. Neural Fabric is the
   * present case: its `PROPOSED_COORDINATION_PLANE` is deliberately absent
   * from `hiveClassificationSchema`, and a leak test guards that absence.
   */
  "plane",
]);
export type HiveLayer = z.infer<typeof hiveLayerSchema>;

/**
 * The band a classification belongs to. Total, so there is nothing to decide.
 *
 * `null` means the component has no ratified classification — which is a real
 * state, not an error, and maps to `plane`.
 */
export function layerFor(classification: HiveClassification | null): HiveLayer {
  if (classification === null) return "plane";
  switch (classification) {
    case "CONSTITUTIONAL_ORCHESTRATION":
      return "prime";
    case "CONSTITUTIONAL_GOVERNANCE":
    case "CONSTITUTIONAL_SENTINEL":
    case "CONSTITUTIONAL_EVOLUTION":
    case "CONSTITUTIONAL_INTELLIGENCE":
      return "constitutional";
    case "CORE":
      return "core";
    case "SHARED_PLATFORM":
      return "platform";
    case "SPECIALIZED":
      return "specialized";
    case "INDUSTRY":
      return "industry";
    default: {
      // Every classification is listed above rather than routed through
      // `isConstitutional`, so that adding a tenth breaks the BUILD here
      // instead of quietly acquiring a plausible band. A silent default is
      // the failure this whole derivation exists to prevent.
      const unhandled: never = classification;
      throw new Error(`unclassified layer for ${String(unhandled)}`);
    }
  }
}

/**
 * The eight domain Cores, as a value a schema can range over.
 *
 * `domain` is the catch-all for a Specialized engine whose Core is not one of
 * the seven named ones — not a synonym for "unassigned". A Specialized engine
 * with no Core at all is rejected rather than defaulted here, because the
 * default is what would let the first genuinely orphaned engine through.
 */
export const coreDomainSchema = z.enum([
  "foundation",
  "knowledge",
  "operations",
  "finance",
  "resources",
  "intelligence",
  "communication",
  "domain",
]);
export type CoreDomain = z.infer<typeof coreDomainSchema>;

/**
 * Whether a layer requires its component to name a Core.
 *
 * True for the capability plane — `core`, `specialized`, `industry` — and false
 * for everything else. The rule is the data's, not a designer's: every one of
 * the 69 rows in `hiveMap.ts` at `58d5e84` partitions this way with no
 * exceptions.
 *
 *   core         9 of 9   name a Core
 *   specialized 44 of 44  name a Core   (finance 32, intelligence 5,
 *                                        operations 4, resources 2,
 *                                        communication 1)
 *   industry     1 of 1   names a Core  (ForgeIQ → domain)
 *   platform     0 of 14  name a Core
 *   prime        0 of 1   names a Core
 *
 * `industry` was very nearly excluded here on the reasoning that an industry
 * pack composes across Cores and so belongs to none. The single industry row
 * that exists says otherwise, and a rule contradicted by the only instance of
 * the thing it governs is a rule about nothing. Requiring it refuses the first
 * omission rather than silently defaulting it.
 */
export function requiresCoreDomain(layer: HiveLayer): boolean {
  return layer === "core" || layer === "specialized" || layer === "industry";
}

/**
 * How a constitutional system relates to everything else.
 *
 * Recorded as data rather than prose because these relationships are what the
 * tier matrix cannot express, and a reviewer needs to be able to quote them.
 */
export const CONSTITUTIONAL_REACH: Readonly<
  Record<string, { readonly verb: string; readonly limit: string }>
> = Object.freeze({
  CONSTITUTIONAL_GOVERNANCE: {
    verb: "authorizes across the system",
    limit: "Does not execute, own domain state, or reason. It answers whether an action may happen.",
  },
  CONSTITUTIONAL_SENTINEL: {
    verb: "observes and contains across the system",
    limit:
      "Does not own imported entities or perform ordinary CRUD. Its findings must not be alterable by the system under investigation.",
  },
  CONSTITUTIONAL_EVOLUTION: {
    verb: "inspects and evolves across the system",
    limit:
      "Broad authority in sandbox, narrow in production. Repair authority does not authorize feature expansion or deployment.",
  },
  CONSTITUTIONAL_INTELLIGENCE: {
    verb: "reasons across the system, as authorized",
    limit:
      "Advises and requests. Never authorizes, never orchestrates, never becomes Knowledge Core, Foundry or Sentinel.",
  },
  CONSTITUTIONAL_ORCHESTRATION: {
    verb: "coordinates authorized work across the system",
    limit:
      "Coordinates; does not own business data and is not the communication bus. Subordinate to Governance and Sentinel.",
  },
});

/**
 * Lifecycle state of a registered component.
 *
 * Separate from `buildStatus` in `hiveArchitecture.ts`, which answers "how much
 * of this exists" for the architecture map. This answers "what is this allowed
 * to be used for", which is a registry question — a chartered-but-unbuilt
 * component and an experimental one are both incomplete but must not be
 * treated the same way by a caller.
 */
export const lifecycleStateSchema = z.enum([
  /** A charter exists. Code may not. */
  "CHARTERED",
  /** Structure exists; behaviour is placeholder. */
  "SCAFFOLDED",
  /** Real, unproven, and not for production reliance. */
  "EXPERIMENTAL",
  /** Proven against its charter. */
  "VALIDATED",
  /** In production use. */
  "PRODUCTION",
  /** Still available; a successor exists. */
  "DEPRECATED",
  /** No longer available. Identity is retained so history stays readable. */
  "RETIRED",
]);
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;

/**
 * A reference to an authoritative Charter.
 *
 * A REFERENCE, deliberately. Copying charter text into source guarantees the
 * copies diverge, and the divergence is invisible because both look
 * authoritative. The integrity hash is what makes the reference checkable
 * rather than merely a pointer.
 */
export const charterReferenceSchema = z
  .object({
    charterId: z.string().min(1),
    charterVersion: z.string().min(1),
    /** Where the authoritative text lives. Not necessarily a URL. */
    charterLocation: z.string().min(1),
    /**
     * Integrity of the referenced text.
     *
     * Optional only because charters are still being written. Once a charter is
     * ratified this stops being optional — an unverifiable reference to a
     * governing document is how a compromised runtime redefines what counts as
     * constitutional.
     */
    charterIntegrityHash: z.string().min(1).optional(),
  })
  .strict();
export type CharterReference = z.infer<typeof charterReferenceSchema>;

/**
 * Why something has no classification.
 *
 * Kept as data so a reviewer can check whether a proposed component belongs in
 * the enum, rather than adding it because there was nowhere else to put it.
 */
export const NOT_CLASSIFIED: Readonly<Record<string, string>> = Object.freeze({
  Overwatch:
    "A coordination framework formed by Governance, Sentinel and Foundry together. A relationship, not a component. Naming it in the enum invites building it, and the thing built would not be the concept.",
  RepairBot:
    "A Foundry-scoped agent holding a leased subset of Foundry's authority for a bounded time. Identified by lease, not classification. An agent is not an engine.",
  InformationFabric:
    "The governed communication substrate formed from Communication Core, EventIQ, engine contracts, IntegrationIQ, Governance, IdentityIQ, AuditIQ and Prime. There is no single component to classify, and creating one would centralize what the Fabric exists to keep distributed.",
  IdentityIQ:
    "Classified SHARED_PLATFORM, not constitutional. It establishes operational identity; Governance determines authority. Authentication proves who is asking, which is not permission.",
  HostApplication:
    "componentKind HOST_APPLICATION, not an engine classification. Approved §23.3 recognizes four capability-layer engine classifications and a Host is none of them: it consumes Hive capability without owning the engines providing it. Host governance belongs in a Host Integration Profile, not the Engine Charter registry.",
});
