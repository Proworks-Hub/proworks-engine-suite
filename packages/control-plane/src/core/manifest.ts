// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// What the console knows about an engine.
//
// The console renders FROM THIS, not from a switch statement. Adding a tenth
// engine should be adding a manifest, not editing a dashboard — because the
// version where it is a switch statement is the version where the tenth engine
// half-appears: on the grid but not in the filter list, in the filter list but
// not in the trace view.
//
// A manifest is DESCRIPTION, never behaviour. It says an engine exists, what
// colour it is, which panels it supports and which events matter to it. It
// contains no logic and holds no credentials, which is what lets the console
// ship the whole registry to a browser.
// ─────────────────────────────────────────────────────────────────────────────

/** Bumped when a field's MEANING changes, not when one is added. */
export const MANIFEST_VERSION = 1;

/**
 * Engines own a domain. Services support them.
 *
 * The distinction is load-bearing rather than cosmetic: tracking and
 * notifications were deliberately NOT made into engines, and a console listing
 * them beside ForgeIQ would quietly re-assert the thing that decision rejected.
 * The dashboard's engine count means engines.
 */
export const engineKindSchema = z.enum([
  /** Owns a domain. These are what "8 of 8 engines online" counts. */
  "engine",
  /** Supports the engines: tracking, notifications, the bus. */
  "service",
  /**
   * The cross-cutting model layer. Neither an engine nor a service: it has no
   * domain of its own, and every engine that reasons calls into it. Separate so
   * the console can give it its own section without inflating the engine count.
   */
  "intelligence",
]);
export type EngineKind = z.infer<typeof engineKindSchema>;

/**
 * A palette name, not a colour.
 *
 * A hex value here would put presentation in the metadata and make a theme
 * change a manifest edit. The console resolves the token; an unresolvable one
 * renders neutral rather than invisible.
 */
export const colorTokenSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "colour token looks like engine-blue");

/** The console's admin surfaces. A manifest lists the ones its engine supports. */
export const adminPanelSchema = z.enum([
  "overview",
  "liveActivity",
  "events",
  "diagnostics",
  "performance",
  "configuration",
  "rules",
  "testing",
  "versions",
  /** Only for engines that actually learn. Listing it elsewhere invents an empty tab. */
  "intelligence",
]);
export type AdminPanel = z.infer<typeof adminPanelSchema>;

/** A number the engine reports, and how to render it without guessing. */
export const engineMetricSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    /** Drives formatting, not arithmetic. */
    unit: z.enum(["count", "percent", "ms", "bytes", "ratio"]),
    /**
     * Which direction is good. Without it a console cannot colour a delta, and
     * a rising failure rate gets the same green arrow as rising throughput.
     */
    betterWhen: z.enum(["higher", "lower", "neither"]).default("neither"),
  })
  .strict();
export type EngineMetric = z.infer<typeof engineMetricSchema>;

/**
 * How one domain event should look when it happens.
 *
 * This is the ONLY place a domain event name meets a visual instruction, and
 * it lives in console metadata rather than on the event. An `intensity` field
 * on `manufacturing.plan.generated` would make an animation's brightness part
 * of a business contract, and every consumer of that event would inherit it.
 */
export const eventMappingSchema = z
  .object({
    /** Exact type, or a `domain.*` prefix — the same matcher the bus uses. */
    eventType: z.string().min(1),
    /**
     * What the scene does. A closed set, so a scene never meets an effect it
     * does not know how to draw.
     */
    effect: z.enum(["receive", "activate", "emit", "alert"]),
    /** 0..1. How much of the engine lights up. */
    intensity: z.number().min(0).max(1).default(0.5),
    /** Where a packet flies, for the inter-engine view. Absent means it stays home. */
    to: z.string().min(1).optional(),
    /** A scene-specific hint, e.g. which station on the line. */
    visualHint: z.string().min(1).optional(),
  })
  .strict();
export type EventMapping = z.infer<typeof eventMappingSchema>;

export const engineManifestSchema = z
  .object({
    manifestVersion: z.number().int().positive().default(MANIFEST_VERSION),

    /**
     * Matches the event envelope's `source.service`. That equality is how
     * telemetry finds its engine, so it is not free to drift.
     */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "engine id is lowercase kebab, e.g. order-ingestion"),
    name: z.string().min(1),
    /** One line, for the grid card. What it owns, not how it works. */
    description: z.string().min(1),
    kind: engineKindSchema.default("engine"),

    /** The npm package, when there is one. Lets the console show what is deployed. */
    packageName: z.string().min(1).optional(),

    colorToken: colorTokenSchema,
    /** An icon name the console resolves. Never inline SVG — that is artwork, not metadata. */
    icon: z.string().min(1),

    /** Which scene draws it. An unknown value falls back to a generic scene. */
    visualizationType: z.string().min(1),
    /**
     * Where this sits in the hive.
     *
     * One field rather than coordinates, so a ninth engine needs a manifest and
     * not a layout edit — the ring positions are computed from however many
     * there are. Exactly one manifest should claim `core`.
     */
    hivePlacement: z.enum(["core", "ring"]).default("ring"),
    /** Scene-specific knobs. Opaque here on purpose; the scene owns its own shape. */
    visualizationConfig: z.record(z.string(), z.unknown()).default({}),

    /** Capability names from the shared contracts, for the entitlement view. */
    capabilities: z.array(z.string()).default([]),
    metrics: z.array(engineMetricSchema).default([]),
    supportedAdminPanels: z.array(adminPanelSchema).default(["overview", "events"]),
    eventMappings: z.array(eventMappingSchema).default([]),
  })
  .strict();

export type EngineManifest = z.infer<typeof engineManifestSchema>;

export interface ManifestParseSuccess {
  ok: true;
  manifest: EngineManifest;
  /**
   * Fields this build did not recognise, dropped rather than kept.
   *
   * Non-empty means the console is older than the engine that published the
   * manifest. Worth surfacing: an operator looking at a panel that is missing
   * information should be told why rather than left to assume it is broken.
   */
  droppedFields: string[];
}

export interface ManifestParseFailure {
  ok: false;
  error: string;
}

const KNOWN_FIELDS = new Set(Object.keys(engineManifestSchema.shape));

/**
 * Reads a manifest, tolerating the future and refusing the present's mistakes.
 *
 * The two cases genuinely differ, and collapsing them means handling one wrong:
 *
 *   A manifest declaring a HIGHER `manifestVersion` comes from a newer engine.
 *   Its extra fields are features this console has not learned yet, so they are
 *   dropped and reported. Refusing would let one upgraded engine blank the
 *   whole dashboard — including the seven engines that are fine.
 *
 *   A manifest at the CURRENT version with an extra field is a typo. Accepting
 *   it leaves `colourToken` sitting there spelt wrong and silently ignored,
 *   while someone wonders why that engine renders grey.
 */
export function parseEngineManifest(input: unknown): ManifestParseSuccess | ManifestParseFailure {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "manifest must be an object" };
  }

  const raw = input as Record<string, unknown>;
  const declared =
    typeof raw["manifestVersion"] === "number" ? raw["manifestVersion"] : MANIFEST_VERSION;

  let candidate = raw;
  const droppedFields: string[] = [];

  if (declared > MANIFEST_VERSION) {
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (KNOWN_FIELDS.has(key)) trimmed[key] = value;
      else droppedFields.push(key);
    }
    candidate = trimmed;
  }

  const result = engineManifestSchema.safeParse(candidate);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, manifest: result.data, droppedFields };
}
