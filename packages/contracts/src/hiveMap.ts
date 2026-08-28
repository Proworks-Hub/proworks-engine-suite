// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { hiveComponentSchema, type HiveComponent } from "./hiveArchitecture.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engine map, as data.
//
// Kept here rather than only in a markdown file for one reason: a document
// drifts and nothing notices. This is imported by tests, so a package that
// exists and is missing here — or is listed here as `existing` and is not —
// fails a build.
//
// STATUS IS THE LOAD-BEARING FIELD. Most of this tree is `planned` or
// `conceptual`, and saying so is the point. An architecture diagram where the
// built and the imagined look alike is a diagram that makes the system appear
// finished, and the first person to rely on it builds against nothing.
// ─────────────────────────────────────────────────────────────────────────────

const component = (input: unknown): HiveComponent => hiveComponentSchema.parse(input);

export const HIVE_MAP: readonly HiveComponent[] = [
  // ── Prime ──────────────────────────────────────────────────────────────────
  component({
    id: "prime", name: "Prime", tier: "prime", status: "existing",
    packageName: "@proworks-hub/prime",
    responsibility:
      "Establishes context, decides which domain answers, and coordinates work across Cores. Executes no domain logic.",
  }),

  // ── Platform ───────────────────────────────────────────────────────────────
  component({
    id: "contracts", name: "Contracts", tier: "platform", status: "existing",
    packageName: "@proworks-hub/contracts",
    responsibility: "The shared language: event envelope, tenancy, ownership, capabilities, context.",
  }),
  component({
    id: "platform-events", name: "Platform Events", tier: "platform", status: "existing",
    packageName: "@proworks-hub/platform-events",
    responsibility: "The bus. Publish, subscribe, resilient delivery.",
  }),
  component({
    id: "platform-runtime", name: "Platform Runtime", tier: "platform", status: "existing",
    packageName: "@proworks-hub/platform-runtime",
    responsibility: "Jobs, outbox, circuit breaking, observability ports.",
  }),
  component({
    id: "core-kit", name: "Core Kit", tier: "platform", status: "existing",
    packageName: "@proworks-hub/core-kit",
    responsibility:
      "The machinery every Core coordinator shares: registry, routing, timeouts, failure isolation, partial answers. Knows no domain.",
  }),
  component({
    id: "control-plane", name: "Hive Control Plane", tier: "platform", status: "existing",
    packageName: "@proworks-hub/control-plane",
    responsibility:
      "Observes and administers the Hive. Owns no domain knowledge and is not required for any engine to run.",
  }),

  // ── Foundation Core ────────────────────────────────────────────────────────
  component({
    id: "foundation-core", name: "Foundation Core", tier: "core", core: "foundation", status: "partial",
    responsibility: "Identity, access, tenancy, policy, audit, configuration and platform health.",
    gap: "No coordinator package. The capabilities exist as contracts (tenancy, capabilities, gateway) and host implementations, with no Core to route between them.",
  }),

  // ── Knowledge Core ─────────────────────────────────────────────────────────
  component({
    id: "knowledge-core", name: "Knowledge Core", tier: "core", core: "knowledge", status: "planned",
    responsibility: "What the organization knows: documents, search, memory, relationships, provenance.",
  }),

  // ── Operations Core ────────────────────────────────────────────────────────
  component({
    id: "operations-core", name: "Operations Core", tier: "core", core: "operations", status: "partial",
    packageName: "@proworks-hub/operations-core",
    responsibility: "Work: workflows, work orders, scheduling, tasks, approvals, automation.",
    gap: "ProWorks registers Order Ingestion and WorkOrderIQ against it and serves /api/operations, but the direct call sites into both engines still exist beside it, so the Core is an additional door rather than the only one. Tracking is not registered at all: it needs production and carrier sources this host has not wired, so locate_order is refused rather than answered emptily. Nothing claims schedule_work.",
  }),
  component({
    id: "workorderiq", name: "WorkOrderIQ", tier: "specialized", core: "operations", status: "existing",
    packageName: "@proworks-hub/workorderiq",
    responsibility: "Work-order lifecycle, routing, stations, change orders, event log.",
  }),
  component({
    id: "tracking", name: "Tracking", tier: "specialized", core: "operations", status: "existing",
    packageName: "@proworks-hub/tracking",
    responsibility:
      "Where an order actually is, merged across production and carrier, narrowed per audience. A projection, not an engine.",
  }),
  component({
    id: "order-ingestion", name: "Order Ingestion", tier: "specialized", core: "operations", status: "existing",
    packageName: "@proworks-hub/order-ingestion",
    responsibility: "Normalizing external orders into one internal shape. A service, not an engine.",
  }),
  component({
    id: "schedulueriq", name: "SchedulerIQ", tier: "specialized", core: "operations", status: "conceptual",
    responsibility: "Deciding when work happens against capacity and dependencies.",
  }),

  // ── Finance Core ───────────────────────────────────────────────────────────
  component({
    id: "finance-core", name: "Finance Core", tier: "core", core: "finance", status: "partial",
    packageName: "@proworks-hub/finance-core",
    responsibility: "Monetary reasoning: cost, budget, price, quote, invoice, profitability.",
    gap: "ProWorks registers CostIQ and ReceiptIQ against it and serves /api/finance, but the direct call sites into both engines still exist beside it, so the Core is an additional door rather than the only one. No production flow has been moved onto it yet.",
  }),
  component({
    id: "costiq", name: "CostIQ", tier: "specialized", core: "finance", status: "existing",
    packageName: "@proworks-hub/costiq",
    responsibility: "Cost calculation and cost intelligence. The only place money is computed.",
  }),
  component({
    id: "receiptiq", name: "ReceiptIQ", tier: "specialized", core: "finance", status: "existing",
    packageName: "@proworks-hub/receiptiq",
    responsibility: "Receipt ingestion, extraction, normalization and purchase evidence.",
  }),
  component({
    id: "budgetiq", name: "BudgetIQ", tier: "specialized", core: "finance", status: "conceptual",
    responsibility: "Budgets, allocation, variance and forecasting.",
  }),

  // ── Resources Core ─────────────────────────────────────────────────────────
  component({
    id: "resources-core", name: "Resources Core", tier: "core", core: "resources", status: "partial",
    responsibility: "What an organization has: people, equipment, inventory, capacity, locations.",
    gap: "InventoryIQ exists. Equipment and capacity live inside SenseIQ observations and host tables, uncoordinated.",
  }),
  component({
    id: "inventoryiq", name: "InventoryIQ", tier: "specialized", core: "resources", status: "existing",
    packageName: "@proworks-hub/inventoryiq",
    responsibility: "What is on hand, reserved, consumed and short.",
  }),
  component({
    id: "assetiq", name: "AssetIQ", tier: "specialized", core: "resources", status: "conceptual",
    responsibility: "Equipment and asset registry, condition and maintenance state.",
  }),

  // ── Intelligence Core ──────────────────────────────────────────────────────
  component({
    id: "intelligence-core-engine", name: "Intelligence Core", tier: "core", core: "intelligence", status: "partial",
    responsibility: "Reasoning, learning, prediction, recommendation, situational awareness.",
    gap: "intelligence-core, model-runtime and model-evals exist as an AI runtime. SenseIQ and VisionIQ sit beneath conceptually but nothing coordinates them, and no provider adapter is configured.",
  }),
  component({
    id: "intelligence-core-pkg", name: "Intelligence Core (AI contracts)", tier: "specialized",
    core: "intelligence", status: "existing",
    packageName: "@proworks-hub/intelligence-core",
    responsibility: "Provider-independent AI task contracts. Names no vendor.",
  }),
  component({
    id: "model-runtime", name: "Model Runtime", tier: "specialized", core: "intelligence", status: "partial",
    packageName: "@proworks-hub/model-runtime",
    responsibility: "Provider adapters, routing, retry, fallback, structured output, cost accounting.",
    gap: "No real vendor adapter. A stub and an unconfigured adapter prove the seam; live keys are needed to write and verify a real one.",
  }),
  component({
    id: "model-evals", name: "Model Evals", tier: "specialized", core: "intelligence", status: "existing",
    packageName: "@proworks-hub/model-evals",
    responsibility: "Measurable regression testing for models and instructions.",
  }),
  component({
    id: "senseiq", name: "SenseIQ", tier: "specialized", core: "intelligence", status: "partial",
    packageName: "@proworks-hub/senseiq",
    responsibility:
      "Physical-world intelligence: devices, spaces, observations, authorized command intents, routines.",
    gap: "Phases A–F built. No real device adapter; the digital-twin layer (Phase G) is not started.",
  }),
  component({
    id: "visioniq", name: "VisionIQ", tier: "specialized", core: "intelligence", status: "existing",
    packageName: "@proworks-hub/visioniq",
    responsibility: "Visual and manufacturing-image intelligence, artwork preparation, machine recipes.",
  }),

  // ── Communication Core ─────────────────────────────────────────────────────
  component({
    id: "communication-core", name: "Communication Core", tier: "core", core: "communication", status: "partial",
    responsibility: "Who is told what, through which channel, when.",
    gap: "A notifications service exists with delivery policy. No Core, no channel adapters beyond the port.",
  }),
  component({
    id: "notifications", name: "Notifications", tier: "specialized", core: "communication", status: "existing",
    packageName: "@proworks-hub/notifications",
    responsibility: "Deciding whether and how to notify. A service, not an engine.",
  }),

  // ── Domain Core ────────────────────────────────────────────────────────────
  component({
    id: "domain-core", name: "Domain Core", tier: "core", core: "domain", status: "partial",
    responsibility: "Which industry this is, and what the universal capabilities mean inside it.",
    gap: "Manufacturing exists as ForgeIQ, consumed directly. There is no domain-pack abstraction, so a second industry has nothing to plug into.",
  }),
  component({
    id: "forgeiq", name: "ForgeIQ", tier: "industry", core: "domain", status: "existing",
    packageName: "@proworks-hub/forgeiq",
    responsibility:
      "Manufacturing: product configuration, manufacturability, plans, BOM, nesting, cutline export.",
  }),
];

/** Everything owned by one Core, for the console and for the docs. */
export function componentsInCore(core: string): HiveComponent[] {
  return HIVE_MAP.filter((entry) => entry.core === core);
}

/** What genuinely exists today, as opposed to what is drawn. */
export function builtComponents(): HiveComponent[] {
  return HIVE_MAP.filter((entry) => entry.status === "existing");
}
