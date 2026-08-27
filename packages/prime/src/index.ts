// Prime — evaluate it, route it, decide what happens next.
//
// Two layers, one engine.
//
// The boundary is `createPrimeEngine`: a DecisionContext in — normalized
// output from ForgeIQ and CostIQ plus operational signals — and a
// DecisionResult out. That is the surface a host or another engine talks to,
// and it depends on the shared contracts at the type level only.
//
// Behind it is the work-order lifecycle migrated from ProWorks: intake,
// template resolution, routing, priority, task flow, change and reroute,
// tracking, terminal states, an event log, and the projections that turn an
// event stream into the views a shop floor reads. Those answer a different
// question — not "should this proceed?" but "where is this work order now, and
// what happens to it next?" — and are exported directly because a host with
// its own work orders needs them without a ManufacturingPlan in sight.
//
// Everything here is pure and I/O-free. The IndexedDB event log and the React
// runtime stay in ProWorks: this package defines the EventLog contract and
// ships an in-memory implementation, and a host binds whatever storage it has.

// ── The decision boundary ────────────────────────────────────────────────
export * from "./primeEngine.js";

// ── The event vocabulary every module speaks ─────────────────────────────
export * from "./models/events.js";

// ── Lifecycle: intake through terminal ───────────────────────────────────
export * from "./core/intake/intakeTypes.js";
export * from "./core/intake/intakeValidator.js";
export * from "./core/intake/createWorkOrderUseCase.js";

export * from "./core/template/templateTypes.js";
export * from "./core/template/resolveTemplateUseCase.js";
export * from "./core/template/inMemoryTemplateLibrary.js";

export * from "./core/routing/routingTypes.js";
export * from "./core/routing/routeStepsUseCase.js";
export * from "./core/routing/inMemoryStationRegistry.js";

export * from "./core/priority/priorityTypes.js";
export * from "./core/priority/priorityScore.js";
export * from "./core/priority/assignPriorityUseCase.js";

export * from "./core/taskflow/taskFlowTypes.js";
export * from "./core/taskflow/taskFlowRules.js";
export * from "./core/taskflow/advanceStepUseCase.js";

export * from "./core/tracking/trackingTypes.js";
export * from "./core/tracking/milestoneRules.js";
export * from "./core/tracking/advanceMilestoneUseCase.js";

export * from "./core/terminal/terminalTypes.js";
export * from "./core/terminal/terminalRules.js";
export * from "./core/terminal/terminalUseCase.js";

// ── Change, rework, and their downstream consequences ────────────────────
export * from "./core/change/changeOrderTypes.js";
export * from "./core/change/changeOrderUseCase.js";
export * from "./core/change/rerouteApprovalTypes.js";
export * from "./core/change/rerouteApprovalUseCase.js";
export * from "./core/change/executeRerouteUseCase.js";
export * from "./core/change-consequence/changeConsequenceEngine.js";

// ── Event log: the contract plus an in-memory binding ────────────────────
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
export * from "./bootstrap/createPrimeProjectionsBundle.js";
