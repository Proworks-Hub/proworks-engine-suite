// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// WorkOrder Engine — the canonical work order, and its production execution state.
//
// Extracted from Prime, because they were never the same thing. Prime decides
// what should happen next; this owns what a work order IS. Keeping both in one
// package meant a maker who wanted a printable work order had to take an
// orchestrator with it.
//
// The capability levels are the point of the split. The SAME canonical work
// order serves a one-person shop that prints it and carries it around, and a
// production floor running routing, scheduling and shop-floor execution against
// it. Not two implementations — one entity, progressively more capability.
//
// Everything here is pure and I/O-free. Storage is the host's, through the
// EventLog port.

// Capability names live in @proworks-hub/contracts, not here. An engine that
// owned its own entitlement vocabulary would be deciding what customers may
// buy, which is a host's business and not a domain's.

// ── Subcontracting: what crosses to another shop, and nothing else ───────
export * from "./collaboration/subcontract.js";

// ── The event vocabulary the whole domain speaks ─────────────────────────
export * from "./models/events.js";

// ── Basic: create a work order, and know what is on it ───────────────────
export * from "./core/intake/intakeTypes.js";
export * from "./core/intake/intakeValidator.js";
export * from "./core/intake/createWorkOrderUseCase.js";

// ── Templates: what work this product normally requires ──────────────────
export * from "./core/template/templateTypes.js";
export * from "./core/template/resolveTemplateUseCase.js";
export * from "./core/template/inMemoryTemplateLibrary.js";

// ── Routing: which station types can perform each step ───────────────────
export * from "./core/routing/routingTypes.js";
export * from "./core/routing/routeStepsUseCase.js";
export * from "./core/routing/inMemoryStationRegistry.js";

// ── Priority ─────────────────────────────────────────────────────────────
export * from "./core/priority/priorityTypes.js";
export * from "./core/priority/priorityScore.js";
export * from "./core/priority/assignPriorityUseCase.js";

// ── Production execution: steps, milestones, completion ──────────────────
export * from "./core/taskflow/taskFlowTypes.js";
export * from "./core/taskflow/taskFlowRules.js";
export * from "./core/taskflow/advanceStepUseCase.js";

export * from "./core/tracking/trackingTypes.js";
export * from "./core/tracking/milestoneRules.js";
export * from "./core/tracking/advanceMilestoneUseCase.js";

export * from "./core/terminal/terminalTypes.js";
export * from "./core/terminal/terminalRules.js";
export * from "./core/terminal/terminalUseCase.js";

// ── Change and rework, and what they cost downstream ─────────────────────
export * from "./core/change/changeOrderTypes.js";
export * from "./core/change/changeOrderUseCase.js";
export * from "./core/change/rerouteApprovalTypes.js";
export * from "./core/change/rerouteApprovalUseCase.js";
export * from "./core/change/executeRerouteUseCase.js";
export * from "./core/change-consequence/changeConsequenceEngine.js";

// ── The event log: the contract, plus an in-memory binding ───────────────
export * from "./core/logging/eventLog.js";
export * from "./core/logging/inMemoryEventLog.js";
export * from "./core/logging/migrations.js";
export * from "./core/logging/replay.js";

// ── Projections: an event stream becomes the views a floor reads ─────────
export * from "./projections/workOrderSummaryTypes.js";
export * from "./projections/workOrderSummaryReducer.js";
export * from "./projections/createWorkOrderSummaryProjection.js";
export * from "./projections/customerProjection.js";
export * from "./projections/masterTabletProjection.js";
export * from "./projections/preProductionProjection.js";
export * from "./projections/stationKioskProjection.js";
export * from "./bootstrap/createWorkOrderProjectionsBundle.js";

// The public tracking answer. The milestone-to-stage mapping lives with the
// engine that owns the milestone names, so a rename cannot escape into a
// public contract without the compiler noticing.
export * from "./tracking/toOrderTrackingSnapshot.js";

// The one door into this engine's mutations: entitlement, tenancy and trace
// enforced once instead of in ten use cases.
export * from "./commands/workOrderCommands.js";

// Quality outcomes and packaging, the four facts the audit found genuinely
// missing from an otherwise complete vocabulary.
export * from "./models/lifecyclePayloads.js";
