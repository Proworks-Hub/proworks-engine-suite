// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The shape of the Hive.
//
//   External application → Prime → Core → Specialized → Industry
//
// This file is the machine-readable half of that. The prose half is THE HIVE
// ENGINE CONSTITUTION; this is what tests can enforce, because an architecture
// that exists only in a document is one that drifts the first time somebody is
// in a hurry.
//
// The reason for the hierarchy, stated once: a flat model has Prime knowing
// every engine. At eight that is fine. At eighty it is a routing table nobody
// can reason about, a dependency graph nobody can test, and a Prime that has
// quietly become the whole system. Prime should know eight domains, not eighty
// implementations.
//
// It lives in `contracts` rather than in the console, because Prime must be
// able to route by Core ownership and Prime does not import the console.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The eight Core domains.
 *
 * DELIBERATELY HARD TO ADD TO. Specialized engines may grow without limit;
 * industry packs may grow without limit; this list should barely move. Every
 * addition costs Prime a domain it must understand, and the value of the layer
 * comes entirely from that number staying small.
 *
 * The bar for a ninth is in `CORE_ADMISSION_TEST` below.
 */
export const hiveCoreSchema = z.enum([
  /** Who is here, what may they do, where does the data belong, is it healthy. */
  "foundation",
  /** What the system knows, and how the right engine retrieves it. */
  "knowledge",
  /** What must happen, when, by whom, and what follows. */
  "operations",
  /** What things cost, what is owed, what the financial impact is. */
  "finance",
  /** What an organization has, where it is, and whether it is available. */
  "resources",
  /** What it all means: patterns, predictions, recommendations. */
  "intelligence",
  /** Who needs to know, through which channel, in what form. */
  "communication",
  /** What industry this is, and what the universal capabilities mean here. */
  "domain",
]);
export type HiveCore = z.infer<typeof hiveCoreSchema>;

/** Where a component sits in the hierarchy. */
export const hiveTierSchema = z.enum([
  /** Prime. Exactly one. */
  "prime",
  /** A Core domain coordinator. */
  "core",
  /** A specialized engine owning one domain capability. */
  "specialized",
  /** An industry pack composing reusable capabilities. */
  "industry",
  /** Shared infrastructure that is not an engine at all. */
  "platform",
]);
export type HiveTier = z.infer<typeof hiveTierSchema>;

/**
 * How much of a thing actually exists.
 *
 * The most important field in this file. An architecture document that lists
 * planned engines beside built ones, indistinguishably, is a document that
 * makes the system look finished — and the first person to rely on that is
 * building against something that is not there.
 */
export const buildStatusSchema = z.enum([
  /** Built, tested, published. */
  "existing",
  /** Some of it exists. The gap is documented. */
  "partial",
  /** Agreed and scheduled. No code. */
  "planned",
  /** An idea recorded so it is not lost. Not a commitment. */
  "conceptual",
]);
export type BuildStatus = z.infer<typeof buildStatusSchema>;

export const hiveComponentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    tier: hiveTierSchema,
    /**
     * Which Core owns it. Exactly one.
     *
     * Shared ownership is how a capability ends up implemented twice, with the
     * two copies disagreeing and nobody able to say which is authoritative. If
     * something genuinely belongs to two Cores, it is two capabilities.
     */
    core: hiveCoreSchema.optional(),
    status: buildStatusSchema,
    /** The npm package, when one exists. */
    packageName: z.string().min(1).optional(),
    /** One sentence. What this owns that nothing else does. */
    responsibility: z.string().min(1),
    /** For `partial`: what is missing. Required, so a gap cannot hide. */
    gap: z.string().min(1).optional(),
  })
  .strict()
  .refine((component) => component.tier === "prime" || component.tier === "platform" || Boolean(component.core), {
    message: "Every core, specialized and industry component must name exactly one owning Core.",
    path: ["core"],
  })
  .refine((component) => component.status !== "partial" || Boolean(component.gap), {
    // A partial component with no stated gap is one nobody has examined, and it
    // reads on a diagram exactly like a finished one.
    message: "A partial component must say what is missing.",
    path: ["gap"],
  });
export type HiveComponent = z.infer<typeof hiveComponentSchema>;

/**
 * The questions a proposed ninth Core has to pass.
 *
 * Kept as data rather than prose so it can be quoted verbatim in a review,
 * rather than remembered approximately.
 */
export const CORE_ADMISSION_TEST: readonly string[] = [
  "Is this responsibility universal across most industries?",
  "Is it substantially different from every existing Core?",
  "Would adding it reduce architectural complexity rather than increase it?",
  "Will there be several specialized engines beneath it?",
  "Will the concept still be valid in ten years?",
];

/**
 * Which tiers may depend on which.
 *
 * Downward only, and one step where practical. The rule that matters most is
 * the absence: nothing depends UPWARD. A specialized engine that imports its
 * Core cannot be reused under a different one, and an engine that imports
 * Prime cannot be used without the orchestrator.
 */
export const ALLOWED_DEPENDENCIES: Readonly<Record<HiveTier, readonly HiveTier[]>> = {
  // Prime and the Cores COORDINATE the tier below them; they do not IMPORT it.
  // A Core that imported CostIQ could not be tested without CostIQ, could not
  // be deployed without it, and would drag every specialist into the bundle of
  // anything that touched the Core. Specialists are registered at runtime by
  // the host, exactly as `tracking` already takes its sources.
  //
  // So the compile-time law is stricter than the conceptual hierarchy: only
  // downward to PLATFORM. The Prime → Core → Specialized relationship is real
  // and is expressed through ports, not imports.
  prime: ["platform"],
  core: ["platform"],
  specialized: ["platform"],
  // The one exception, and it is what an industry pack IS: composition. ForgeIQ
  // legitimately assembles reusable capabilities into a manufacturing answer.
  industry: ["platform"],
  platform: [],
};

export interface DependencyViolation {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/**
 * Checks a dependency against the hierarchy.
 *
 * Returns the violation rather than throwing: the caller is usually a test
 * reporting every problem at once, and stopping at the first would hide the
 * rest of them.
 */
export function checkDependency(
  from: HiveComponent,
  to: HiveComponent,
): DependencyViolation | null {
  // Checked first so the message names the real problem. A cross-domain import
  // and a same-domain one are both refused, but they are different mistakes:
  // one welds two domains together, the other just skips the event bus.
  if (from.tier === "specialized" && to.tier === "specialized" && from.core !== to.core) {
    return {
      from: from.id,
      to: to.id,
      reason: `${from.name} (${from.core}) must not depend on ${to.name} (${to.core}). Cross-domain work goes through Prime.`,
    };
  }

  const allowed = ALLOWED_DEPENDENCIES[from.tier];

  if (!allowed.includes(to.tier)) {
    return {
      from: from.id,
      to: to.id,
      reason:
        from.tier === to.tier
          ? `${from.name} and ${to.name} are both ${from.tier}; peers must communicate through events, not imports.`
          : `A ${from.tier} component may not depend on a ${to.tier} one. Dependencies run downward.`,
    };
  }

  return null;
}

/**
 * Every specialized engine has exactly one Core.
 *
 * Checked as a set operation rather than per-engine because the failure being
 * guarded against is two Cores both claiming something — which no single
 * engine's own record can reveal.
 */
export function findOwnershipConflicts(
  components: readonly HiveComponent[],
): { id: string; cores: HiveCore[] }[] {
  const cores = new Map<string, Set<HiveCore>>();

  for (const component of components) {
    if (!component.core) continue;
    const existing = cores.get(component.id) ?? new Set<HiveCore>();
    existing.add(component.core);
    cores.set(component.id, existing);
  }

  return [...cores.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([id, owners]) => ({ id, cores: [...owners] }));
}

/** What is actually built, for a reader who needs the truth rather than the plan. */
export function summariseBuildStatus(
  components: readonly HiveComponent[],
): Record<BuildStatus, number> {
  const counts: Record<BuildStatus, number> = {
    existing: 0, partial: 0, planned: 0, conceptual: 0,
  };
  for (const component of components) counts[component.status] += 1;
  return counts;
}
