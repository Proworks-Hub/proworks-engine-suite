// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { charterReferenceSchema, hiveClassificationSchema, lifecycleStateSchema } from "./hiveClassification.js";
import { healthStateSchema, identifierSchema, versionReferenceSchema } from "./identifiers.js";

// ─────────────────────────────────────────────────────────────────────────────
// The constitutional runtime manifest.
//
// Constitution §2.5: "Constitutionally significant engines and services shall
// maintain sufficient machine-readable identity and governance information to
// determine what they are, what version they represent, what capabilities they
// provide, what authority they possess, what dependencies and contracts they
// require, and how their health and compatibility may be evaluated."
//
// TWO MANIFESTS, ONE IDENTITY, AND WHY BOTH STAY
//
// `control-plane/manifest.ts` already has an `EngineManifest`. It is a
// PRESENTATION manifest — icon, visualizationType, hivePlacement,
// supportedAdminPanels, eventMappings — and the Hive console at /hive consumes
// it today. It is not wrong; it answers a different question.
//
// Extending it with twenty constitutional fields would make every console
// concern a constitutional one and vice versa, and the console would then break
// whenever the constitutional shape moved. So they stay separate and are joined
// by `engineId`, which is the same value in both.
//
// Presentation asks: how should this engine appear?
// This asks:         what is this engine, constitutionally?
//
// WHAT A MANIFEST MAY NOT DO
//
// It DECLARES. It does not grant. `authorityRequirements` states what an engine
// needs in order to work — it is a request, never a grant, and Governance
// remains the only thing that can answer it. A manifest that could grant its own
// authority would let any engine widen itself by editing a file it ships.
// ─────────────────────────────────────────────────────────────────────────────

/** A contract this engine offers or requires, named and versioned. */
export const contractReferenceSchema = z
  .object({
    contractId: identifierSchema,
    version: z.string().min(1),
    /** One line. What it is for, so a reader need not open the schema. */
    summary: z.string().min(1).optional(),
  })
  .strict();
export type ContractReference = z.infer<typeof contractReferenceSchema>;

/**
 * How badly a dependency is needed.
 *
 * Three levels because they fail differently, and an operator seeing a
 * dependency down needs to know which of the three this is before deciding
 * whether anything is wrong.
 */
export const dependencyStrengthSchema = z.enum([
  /** Without it the engine cannot start. */
  "required",
  /** Needed for some capabilities. The engine runs degraded without it. */
  "conditional",
  /** Improves behaviour. Absence is not degradation. */
  "optional",
  /** Governance, Sentinel, Foundry. Not a capability dependency. */
  "constitutional",
]);
export type DependencyStrength = z.infer<typeof dependencyStrengthSchema>;

export const dependencyDeclarationSchema = z
  .object({
    engineId: identifierSchema,
    strength: dependencyStrengthSchema,
    /** What breaks without it. Required for anything above optional. */
    consequenceIfUnavailable: z.string().min(1).optional(),
  })
  .strict()
  .refine((d) => d.strength === "optional" || Boolean(d.consequenceIfUnavailable), {
    message:
      "A required, conditional or constitutional dependency must state what breaks without it. An unexplained dependency is one nobody can triage when it goes down.",
    path: ["consequenceIfUnavailable"],
  });
export type DependencyDeclaration = z.infer<typeof dependencyDeclarationSchema>;

/**
 * A domain this engine is authoritative for.
 *
 * `notAuthoritativeFor` is required and must be non-empty. Constitution §23.6
 * requires a charter to name "significant adjacent information for which it is
 * not authoritative", and that half is the one that gets skipped: an engine
 * listing only what it owns reads as owning everything nearby.
 */
export const sourceOfTruthDeclarationSchema = z
  .object({
    domain: z.string().min(1),
    description: z.string().min(1),
    notAuthoritativeFor: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type SourceOfTruthDeclaration = z.infer<typeof sourceOfTruthDeclarationSchema>;

/**
 * What the engine needs permission to do.
 *
 * A REQUEST, not a grant. Governance answers it. Named `requirements` rather
 * than `permissions` for the same reason `assertedCapabilities` was renamed:
 * a field called permissions will eventually be read as one.
 */
export const authorityRequirementSchema = z
  .object({
    action: identifierSchema,
    purpose: z.string().min(1),
    /** Why the engine cannot do its job without it. */
    justification: z.string().min(1),
  })
  .strict();
export type AuthorityRequirement = z.infer<typeof authorityRequirementSchema>;

/** How to ask whether this engine is well, and what its answers mean. */
export const healthContractSchema = z
  .object({
    /** States this engine can actually report. A subset of the Hive five. */
    reportableStates: z.array(healthStateSchema).min(1),
    /** How often a consumer should expect a fresh signal, in ms. */
    expectedIntervalMs: z.number().int().positive().optional(),
    /**
     * What `degraded` means HERE.
     *
     * Required, because "degraded" alone sends somebody digging through logs.
     * The same word means different things in a costing engine and a device
     * gateway, and only this engine can say which.
     */
    degradedMeans: z.string().min(1),
  })
  .strict()
  .refine((h) => h.reportableStates.includes("healthy"), {
    message: "An engine that cannot report healthy cannot report anything useful.",
    path: ["reportableStates"],
  });
export type HealthContract = z.infer<typeof healthContractSchema>;

/** What Sentinel may observe here. Declared by the engine, verified by Sentinel. */
export const sentinelHookSchema = z
  .object({
    hook: z.enum([
      "authorization_decisions",
      "consequential_actions",
      "state_transitions",
      "external_calls",
      "data_access",
      "health_transitions",
    ]),
    /** Whether the engine emits this today. Declaring a hook is not providing it. */
    implemented: z.boolean(),
  })
  .strict();
export type SentinelHook = z.infer<typeof sentinelHookSchema>;

/**
 * What the engine assumes about where it runs.
 *
 * Constitution §23.14: no host, provider, cloud, repository or database "shall
 * unnecessarily become the permanent owner or architectural jailer of an
 * engine." An engine that cannot list its assumptions has not examined them.
 */
export const portabilityMetadataSchema = z
  .object({
    /** Ports the host must bind. Empty means it needs nothing from a host. */
    requiresHostBindings: z.array(z.string().min(1)).default([]),
    /** Named providers it depends on. EMPTY is the target state. */
    providerDependencies: z.array(z.string().min(1)).default([]),
    /** Anything that would need work to move. Stated, not implied. */
    portabilityCaveats: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type PortabilityMetadata = z.infer<typeof portabilityMetadataSchema>;

export const RUNTIME_MANIFEST_VERSION = 1;

/**
 * The constitutional manifest.
 *
 * `.strict()` throughout: an unknown field in a governing declaration is a typo
 * that reads as a value. `charterVersion` misspelled would silently mean
 * "no charter version", and an engine's charter binding is exactly the thing
 * that must not go quietly missing.
 */
export const runtimeEngineManifestSchema = z
  .object({
    manifestVersion: z.literal(RUNTIME_MANIFEST_VERSION),

    // ── Identity ────────────────────────────────────────────────────────────
    /**
     * Permanent constitutional identity.
     *
     * Stable across repository moves, package renames, hosts, providers,
     * databases and version upgrades. Implementation identity and
     * constitutional identity are not the same thing, and this is the second.
     */
    engineId: identifierSchema,
    canonicalName: z.string().min(1),
    classification: hiveClassificationSchema,
    lifecycleState: lifecycleStateSchema,

    // ── Versions, independently ─────────────────────────────────────────────
    versions: versionReferenceSchema,
    charter: charterReferenceSchema,
    /** Constitution versions this engine was validated against. */
    constitutionCompatibility: z.array(z.string().min(1)).min(1),

    // ── What it does ────────────────────────────────────────────────────────
    capabilities: z.array(identifierSchema).default([]),
    contractsProvided: z.array(contractReferenceSchema).default([]),
    contractsConsumed: z.array(contractReferenceSchema).default([]),
    eventsPublished: z.array(identifierSchema).default([]),
    eventsConsumed: z.array(identifierSchema).default([]),

    // ── What it needs ───────────────────────────────────────────────────────
    dependencies: z.array(dependencyDeclarationSchema).default([]),

    // ── What it owns, and does not ──────────────────────────────────────────
    sourceOfTruth: z.array(sourceOfTruthDeclarationSchema).default([]),

    // ── What it must be permitted to do ─────────────────────────────────────
    authorityRequirements: z.array(authorityRequirementSchema).default([]),
    /** Whether this engine refuses to act without a Governance decision. */
    requiresGovernance: z.boolean(),

    // ── How it is watched ───────────────────────────────────────────────────
    health: healthContractSchema,
    sentinelHooks: z.array(sentinelHookSchema).default([]),

    // ── Where it can live ───────────────────────────────────────────────────
    portability: portabilityMetadataSchema,
  })
  .strict()
  .refine(
    (m) =>
      m.classification === "SHARED_PLATFORM" ||
      m.lifecycleState === "CHARTERED" ||
      m.requiresGovernance,
    {
      message:
        "An implemented engine outside the platform layer must require Governance. Capability does not imply permission (Constitution §1.9), and an engine that acts without an authorization decision is the leak that rule exists to close.",
      path: ["requiresGovernance"],
    },
  )
  .refine(
    (m) => m.lifecycleState === "CHARTERED" || m.sourceOfTruth.length > 0 || m.classification === "SHARED_PLATFORM",
    {
      message:
        "An implemented engine must declare what it is authoritative for, even if the answer is a single narrow domain. Silence here is how two engines end up both believing they own the same state.",
      path: ["sourceOfTruth"],
    },
  );
export type RuntimeEngineManifest = z.infer<typeof runtimeEngineManifestSchema>;

export interface ManifestProblem {
  readonly engineId: string;
  readonly reason: string;
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: RuntimeEngineManifest }
  | { readonly ok: false; readonly problem: ManifestProblem };

/**
 * Parses a manifest, returning the failure rather than throwing.
 *
 * A registry loading forty manifests wants every problem at once; stopping at
 * the first hides the other thirty-nine.
 */
export function parseRuntimeManifest(input: unknown): ManifestParseResult {
  const parsed = runtimeEngineManifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };

  const engineId =
    typeof input === "object" && input !== null && "engineId" in input
      ? String((input as { engineId: unknown }).engineId)
      : "<unidentified>";

  return { ok: false, problem: { engineId, reason: JSON.stringify(parsed.error.flatten()) } };
}

/**
 * Whether a manifest may be relied on for consequential work.
 *
 * Lifecycle alone is not enough — a PRODUCTION engine that declares no
 * Governance requirement is not trustworthy regardless of its label.
 */
export function isTrustedForConsequentialWork(manifest: RuntimeEngineManifest): boolean {
  const lifecycleOk =
    manifest.lifecycleState === "VALIDATED" || manifest.lifecycleState === "PRODUCTION";
  return lifecycleOk && manifest.requiresGovernance;
}

/**
 * The domains an engine claims, for conflict detection across a fleet.
 *
 * Two engines claiming one domain is the single most damaging thing a registry
 * can fail to notice, so the check is offered here rather than left to callers.
 */
export function claimedDomains(manifest: RuntimeEngineManifest): readonly string[] {
  return manifest.sourceOfTruth.map((s) => s.domain);
}
