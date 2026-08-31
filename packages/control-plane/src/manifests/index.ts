// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineManifest } from "../core/manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// The suite, described for the console.
//
// Data, not code. Every one of these is a value the console reads — none of it
// is imported by an engine, and deleting this file would not change what a
// single engine does. That is the §17 requirement made structural: the console
// is a consumer, and the engines do not know it exists.
//
// `id` matches the `source.service` an engine puts on its events. That equality
// is the whole wiring: telemetry finds its scene by name.
// ─────────────────────────────────────────────────────────────────────────────

const RATE = { key: "successRate", label: "Success rate", unit: "percent", betterWhen: "higher" } as const;
const JOBS = { key: "jobsProcessed", label: "Jobs (24h)", unit: "count", betterWhen: "neither" } as const;
const LATENCY = { key: "avgLatencyMs", label: "Avg response", unit: "ms", betterWhen: "lower" } as const;

/** The orchestrator. Routes; does not do the work. */
export const primeManifest: EngineManifest = {
  manifestVersion: 2,
  id: "prime",
  name: "Prime",
  description: "Orchestration core",
  kind: "engine",
  packageName: "@proworks-hub/prime",
  colorToken: "engine-blue",
  icon: "orchestration-core",
  visualizationType: "orchestration-core",
  // The one manifest that claims the centre. Everything else rings it.
  layer: "prime",
  coreDomain: null,
  hivePlacement: "core",
  visualizationConfig: { rings: 3, routeGlowMs: 700 },
  capabilities: ["prime.orchestration", "prime.automation"],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance", "configuration", "versions",
  ],
  eventMappings: [
    // Prime's scene should read as delegation, never as doing the work. A pulse
    // arrives at the core and leaves along one route — the destination engine
    // is what lights up next.
    { eventType: "manufacturing.request.routed", effect: "emit", intensity: 0.6, to: "forgeiq", activity: "routing" },
    { eventType: "cost.request.routed", effect: "emit", intensity: 0.5, to: "costiq", activity: "routing" },
    { eventType: "workorder.request.routed", effect: "emit", intensity: 0.5, to: "workorderiq", activity: "routing" },
    { eventType: "inventory.request.routed", effect: "emit", intensity: 0.5, to: "inventoryiq", activity: "routing" },
    { eventType: "workflow.started", effect: "activate", intensity: 0.4, activity: "coordinating" },
    { eventType: "workflow.step.awaiting", effect: "activate", intensity: 0.2, activity: "waiting", normalizedActivity: "waiting" },
    { eventType: "workflow.compensated", effect: "alert", intensity: 0.9 },
  ],
};

export const forgeIqManifest: EngineManifest = {
  manifestVersion: 2,
  id: "forgeiq",
  name: "ForgeIQ",
  description: "Manufacturing intelligence",
  kind: "engine",
  packageName: "@proworks-hub/forgeiq",
  colorToken: "engine-orange",
  icon: "fabrication-cell",
  visualizationType: "fabrication-cell",
  layer: "industry",
  coreDomain: "domain",
  hivePlacement: "ring",
  visualizationConfig: { armTravelMs: 2400, sparkOnPlan: true },
  capabilities: ["forgeiq.basic", "forgeiq.builder", "forgeiq.manufacturing"],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance",
    "configuration", "rules", "testing", "versions", "intelligence",
  ],
  eventMappings: [
    { eventType: "manufacturing.request.routed", effect: "receive", intensity: 0.5, to: "forgeiq", activity: "configuring" },
    { eventType: "configurator.rules.evaluated", effect: "activate", intensity: 0.4, activity: "validating" },
    { eventType: "manufacturability.checked", effect: "activate", intensity: 0.5, activity: "manufacturability_check" },
    { eventType: "manufacturing.plan.generated", effect: "emit", intensity: 0.8, to: "costiq", visualHint: "workpiece", activity: "generating_plan" },
    { eventType: "configurator.rule.blocked", effect: "alert", intensity: 0.7 },
  ],
};

export const costIqManifest: EngineManifest = {
  manifestVersion: 2,
  id: "costiq",
  name: "CostIQ",
  description: "Cost calculation engine",
  kind: "engine",
  packageName: "@proworks-hub/costiq",
  colorToken: "engine-green",
  icon: "cost-stack",
  visualizationType: "cost-stack",
  layer: "specialized",
  coreDomain: "finance",
  hivePlacement: "ring",
  visualizationConfig: { layers: 4, settleMs: 900 },
  capabilities: ["costiq.basic", "costiq.advanced", "costiq.realtime"],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance", "configuration", "rules", "testing", "versions",
  ],
  eventMappings: [
    { eventType: "manufacturing.plan.generated", effect: "receive", intensity: 0.5, to: "costiq", activity: "calculating", normalizedActivity: "calculating" },
    { eventType: "cost.calculation.completed", effect: "emit", intensity: 0.7, to: "prime", visualHint: "stack", activity: "calculating", normalizedActivity: "calculating" },
    { eventType: "cost.variance.evaluated", effect: "activate", intensity: 0.4, activity: "evaluating_variance", normalizedActivity: "calculating" },
    { eventType: "material.purchase.detected", effect: "receive", intensity: 0.4, to: "costiq", activity: "updating_cost_basis", normalizedActivity: "updating" },
  ],
};

export const visionIqManifest: EngineManifest = {
  manifestVersion: 2,
  id: "visioniq",
  name: "VisionIQ",
  description: "Computer vision engine",
  kind: "engine",
  packageName: "@proworks-hub/visioniq",
  colorToken: "engine-purple",
  icon: "vision-lens",
  visualizationType: "vision-lens",
  layer: "specialized",
  coreDomain: "intelligence",
  hivePlacement: "ring",
  visualizationConfig: { scanMs: 1800, detectionPoints: 6 },
  capabilities: [],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance",
    "configuration", "testing", "versions", "intelligence",
  ],
  eventMappings: [
    { eventType: "artwork.submitted", effect: "receive", intensity: 0.5, to: "visioniq", activity: "analyzing" },
    { eventType: "artwork.scanned", effect: "activate", intensity: 0.5, activity: "scanning" },
    { eventType: "artwork.rendered", effect: "activate", intensity: 0.5, activity: "rendering" },
    { eventType: "vision.correction.captured", effect: "activate", intensity: 0.3, activity: "learning", normalizedActivity: "updating" },
    { eventType: "artwork.prepared", effect: "emit", intensity: 0.8, to: "forgeiq", visualHint: "lens", activity: "preparing" },
    { eventType: "artwork.rejected", effect: "alert", intensity: 0.8 },
  ],
};

export const workOrderIqManifest: EngineManifest = {
  manifestVersion: 2,
  id: "workorderiq",
  name: "WorkOrderIQ",
  description: "Work order management",
  kind: "engine",
  packageName: "@proworks-hub/workorderiq",
  colorToken: "engine-cyan",
  icon: "production-line",
  visualizationType: "production-line",
  layer: "specialized",
  coreDomain: "operations",
  hivePlacement: "ring",
  visualizationConfig: { stations: 4, travelMs: 3200 },
  capabilities: [
    "workorder.basic", "workorder.print", "workorder.digital",
    "workorder.production_tracking", "workorder.routing",
    "workorder.machine_assignment", "workorder.scheduling", "workorder.shop_floor",
  ],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance", "configuration", "rules", "testing", "versions",
  ],
  eventMappings: [
    { eventType: "workorder.request.routed", effect: "receive", intensity: 0.5, to: "workorderiq", activity: "routing" },
    { eventType: "work.order.created", effect: "activate", intensity: 0.5, visualHint: "station-1", activity: "creating" },
    { eventType: "work.order.quality.checked", effect: "activate", intensity: 0.4, activity: "quality_check", normalizedActivity: "monitoring" },
    { eventType: "work.order.packaged", effect: "activate", intensity: 0.4, activity: "packaging" },
    { eventType: "work.order.step.completed", effect: "activate", intensity: 0.4, activity: "updating", normalizedActivity: "updating" },
    { eventType: "work.order.completed", effect: "emit", intensity: 0.8, to: "prime" },
  ],
};

export const receiptIqManifest: EngineManifest = {
  manifestVersion: 2,
  id: "receiptiq",
  name: "ReceiptIQ",
  description: "Receipt processing engine",
  kind: "engine",
  packageName: "@proworks-hub/receiptiq",
  colorToken: "engine-magenta",
  icon: "document-scanner",
  visualizationType: "document-scanner",
  layer: "specialized",
  coreDomain: "finance",
  hivePlacement: "ring",
  visualizationConfig: { scanMs: 1500, extractedFields: 5 },
  capabilities: ["receipts.capture", "receipts.cost_intelligence"],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance",
    "configuration", "testing", "versions", "intelligence",
  ],
  eventMappings: [
    { eventType: "receipt.ingested", effect: "receive", intensity: 0.5, to: "receiptiq", activity: "extracting" },
    { eventType: "receipt.awaiting.review", effect: "activate", intensity: 0.2, activity: "awaiting_review", normalizedActivity: "waiting" },
    { eventType: "receipt.normalized", effect: "activate", intensity: 0.6, activity: "normalizing" },
    { eventType: "material.purchase.detected", effect: "emit", intensity: 0.7, to: "costiq", visualHint: "fields" },
  ],
};

export const inventoryIqManifest: EngineManifest = {
  manifestVersion: 2,
  id: "inventoryiq",
  name: "InventoryIQ",
  description: "Inventory intelligence engine",
  kind: "engine",
  packageName: "@proworks-hub/inventoryiq",
  colorToken: "engine-gold",
  icon: "inventory-racks",
  visualizationType: "inventory-racks",
  layer: "specialized",
  coreDomain: "resources",
  hivePlacement: "ring",
  visualizationConfig: { bins: 12, settleMs: 800 },
  capabilities: [
    "inventory.basic", "inventory.multi_location", "inventory.reservations",
    "inventory.reorder", "inventory.consumption_variance",
  ],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance", "configuration", "rules", "testing", "versions",
  ],
  eventMappings: [
    { eventType: "inventory.request.routed", effect: "receive", intensity: 0.4, to: "inventoryiq", activity: "checking" },
    { eventType: "inventory.availability.checked", effect: "activate", intensity: 0.4, activity: "checking", normalizedActivity: "monitoring" },
    { eventType: "inventory.reserved", effect: "activate", intensity: 0.4, activity: "reserving" },
    { eventType: "inventory.consumed", effect: "activate", intensity: 0.4, activity: "consuming" },
    { eventType: "inventory.reconciled", effect: "activate", intensity: 0.4, activity: "reconciling", normalizedActivity: "updating" },
    { eventType: "inventory.oversold", effect: "alert", intensity: 0.9, activity: "oversold" },
    { eventType: "inventory.level.changed", effect: "activate", intensity: 0.5, visualHint: "bin", activity: "updating", normalizedActivity: "updating" },
    // Restrained on purpose. A low-stock warning that flashes is a low-stock
    // warning people turn off.
    { eventType: "inventory.reorder.reached", effect: "alert", intensity: 0.6, activity: "shortage" },
  ],
};

export const orderIngestionManifest: EngineManifest = {
  manifestVersion: 2,
  id: "order-ingestion",
  name: "Order Ingestion",
  description: "Multi-channel intake",
  kind: "engine",
  packageName: "@proworks-hub/order-ingestion",
  colorToken: "engine-aqua",
  icon: "channel-funnel",
  visualizationType: "channel-funnel",
  layer: "specialized",
  coreDomain: "operations",
  hivePlacement: "ring",
  visualizationConfig: { channels: ["shopify", "etsy", "phone", "website", "manual"], convergeMs: 1400 },
  capabilities: [],
  metrics: [JOBS, RATE, LATENCY],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance", "configuration", "testing", "versions",
  ],
  eventMappings: [
    { eventType: "shop.order.received", effect: "receive", intensity: 0.4, to: "order-ingestion", activity: "receiving", normalizedActivity: "receiving" },
    { eventType: "shop.order.deduplicated", effect: "activate", intensity: 0.3, activity: "deduplicating" },
    { eventType: "shop.order.product.resolved", effect: "activate", intensity: 0.4, activity: "resolving_product" },
    { eventType: "shop.order.normalized", effect: "emit", intensity: 0.7, to: "prime", visualHint: "converge", activity: "normalizing" },
    // A line that cannot be matched to a product is the failure this engine
    // exists to catch, so it is the one thing its scene raises its voice about.
    { eventType: "shop.order.line.unmatched", effect: "alert", intensity: 0.8, activity: "needs_review" },
  ],
};

/**
 * The model layer.
 *
 * `kind: "intelligence"` rather than `"engine"` — it owns no domain, and
 * counting it would make "8 of 8 engines online" wrong.
 */
export const intelligenceManifest: EngineManifest = {
  manifestVersion: 2,
  id: "ai-intelligence",
  name: "AI / Intelligence",
  description: "The shared brain powering the hive",
  kind: "intelligence",
  colorToken: "engine-violet",
  icon: "intelligence-core",
  visualizationType: "intelligence-core",
  // No hiveMap row exists for this component, so no classification is
  // recorded for it. `plane` states that truthfully; naming a tier here
  // would be inventing one. Tracked as a Phase 1 reconciliation gap.
  layer: "plane",
  coreDomain: null,
  hivePlacement: "ring",
  visualizationConfig: { synapseMs: 2600 },
  capabilities: [],
  metrics: [
    { key: "aiRequests", label: "AI requests (24h)", unit: "count", betterWhen: "neither" },
    { key: "tokenUsage", label: "Token usage (24h)", unit: "count", betterWhen: "neither" },
    { key: "avgLatencyMs", label: "Avg latency", unit: "ms", betterWhen: "lower" },
    { key: "successRate", label: "Success rate", unit: "percent", betterWhen: "higher" },
    // Rising fallback means the primary provider is failing and nobody noticed,
    // because the fallback kept the feature working.
    { key: "fallbackRate", label: "Fallback rate", unit: "percent", betterWhen: "lower" },
  ],
  supportedAdminPanels: [
    "overview", "liveActivity", "events", "diagnostics", "performance", "configuration", "versions", "intelligence",
  ],
  eventMappings: [
    { eventType: "model.request.completed", effect: "activate", intensity: 0.3 },
    { eventType: "model.request.failed", effect: "alert", intensity: 0.7 },
    { eventType: "model.provider.fell.back", effect: "alert", intensity: 0.8 },
  ],
};

// ── Platform services ────────────────────────────────────────────────────────
//
// Deliberately not engines. Tracking is a projection over what the engines
// already publish, and notifications is a delivery policy. Both were kept out
// of the engine tier on purpose, and a console that listed them beside ForgeIQ
// would quietly undo that.

export const trackingManifest: EngineManifest = {
  manifestVersion: 2,
  id: "tracking",
  name: "Tracking",
  description: "Where an order actually is, narrowed per audience",
  kind: "service",
  packageName: "@proworks-hub/tracking",
  colorToken: "service-slate",
  icon: "route",
  visualizationType: "service-strip",
  layer: "specialized",
  coreDomain: "operations",
  hivePlacement: "ring",
  visualizationConfig: {},
  capabilities: [],
  metrics: [JOBS, RATE],
  supportedAdminPanels: ["overview", "events", "diagnostics", "versions"],
  eventMappings: [{ eventType: "shipment.*", effect: "activate", intensity: 0.3 }],
};

export const notificationsManifest: EngineManifest = {
  manifestVersion: 2,
  id: "notifications",
  name: "Notifications",
  description: "Delivery policy and quiet hours",
  kind: "service",
  packageName: "@proworks-hub/notifications",
  colorToken: "service-slate",
  icon: "bell",
  visualizationType: "service-strip",
  layer: "specialized",
  coreDomain: "communication",
  hivePlacement: "ring",
  visualizationConfig: {},
  capabilities: [],
  metrics: [JOBS, RATE],
  supportedAdminPanels: ["overview", "events", "diagnostics", "versions"],
  eventMappings: [{ eventType: "notification.*", effect: "activate", intensity: 0.2 }],
};

/**
 * Array order is display order.
 *
 * Prime first because it is the core of the hive; the rest in the order they
 * ring it. No sort key on the manifest — a number that has to be kept in step
 * across ten files drifts, and the drift shows up as two engines swapping
 * places between the grid and the nav.
 */
export const SUITE_MANIFESTS: readonly EngineManifest[] = [
  primeManifest,
  forgeIqManifest,
  costIqManifest,
  visionIqManifest,
  workOrderIqManifest,
  receiptIqManifest,
  inventoryIqManifest,
  orderIngestionManifest,
  intelligenceManifest,
  trackingManifest,
  notificationsManifest,
];
