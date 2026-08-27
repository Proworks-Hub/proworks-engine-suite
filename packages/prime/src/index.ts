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
export * from "./primeEngine";

// ── The event vocabulary every module speaks ─────────────────────────────
export * from "./models/events";

// ── Lifecycle: intake through terminal ───────────────────────────────────
export * from "./core/intake/intakeTypes";
export * from "./core/intake/intakeValidator";
export * from "./core/intake/createWorkOrderUseCase";

export * from "./core/template/templateTypes";
export * from "./core/template/resolveTemplateUseCase";
export * from "./core/template/inMemoryTemplateLibrary";

export * from "./core/routing/routingTypes";
export * from "./core/routing/routeStepsUseCase";
export * from "./core/routing/inMemoryStationRegistry";

export * from "./core/priority/priorityTypes";
export * from "./core/priority/priorityScore";
export * from "./core/priority/assignPriorityUseCase";

export * from "./core/taskflow/taskFlowTypes";
export * from "./core/taskflow/taskFlowRules";
export * from "./core/taskflow/advanceStepUseCase";

export * from "./core/tracking/trackingTypes";
export * from "./core/tracking/milestoneRules";
export * from "./core/tracking/advanceMilestoneUseCase";

export * from "./core/terminal/terminalTypes";
export * from "./core/terminal/terminalRules";
export * from "./core/terminal/terminalUseCase";

// ── Change, rework, and their downstream consequences ────────────────────
export * from "./core/change/changeOrderTypes";
export * from "./core/change/changeOrderUseCase";
export * from "./core/change/rerouteApprovalTypes";
export * from "./core/change/rerouteApprovalUseCase";
export * from "./core/change/executeRerouteUseCase";
export * from "./core/change-consequence/changeConsequenceEngine";

// ── Event log: the contract plus an in-memory binding ────────────────────
export * from "./core/logging/eventLog";
export * from "./core/logging/inMemoryEventLog";
export * from "./core/logging/migrations";
export * from "./core/logging/replay";

// ── Projections: an event stream becomes the views a floor reads ─────────
export * from "./projections/workOrderSummaryTypes";
export * from "./projections/workOrderSummaryReducer";
export * from "./projections/createWorkOrderSummaryProjection";
export * from "./projections/customerProjection";
export * from "./projections/masterTabletProjection";
export * from "./projections/preProductionProjection";
export * from "./projections/stationKioskProjection";
export * from "./bootstrap/createPrimeProjectionsBundle";
