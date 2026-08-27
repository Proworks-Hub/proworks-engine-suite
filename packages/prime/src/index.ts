// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// Prime — decide what happens next, and coordinate whoever does it.
//
// Prime used to contain the entire work-order lifecycle. That moved to
// @proworks-hub/workorder, because they were never the same domain: this
// decides, that executes. Keeping them together meant a maker who wanted a
// printable work order had to take an orchestrator with it.
//
// What is left is deliberately small, and small is the point. Prime is the
// conductor; a conductor who also plays every instrument is the bottleneck the
// architecture exists to avoid. It should grow in importance without growing
// in size.
//
// Prime references a workOrderId. It does not hold a second copy of the work
// order, and it does not import the engine that owns one.
//
// Pure and I/O-free, enforced by architecture guards. Durable workflow state
// arrives through the WorkflowStateStore port; a host supplies the storage.

// ── The decision boundary: a context in, a decision out ──────────────────
export * from "./primeEngine.js";

// ── Durable workflows: the state machine here, the storage in a host ─────
export * from "./workflow/workflowRunner.js";
export * from "./workflow/inMemoryWorkflowStateStore.js";
