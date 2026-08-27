# Migration audit — mature ProWorks engines → portable engine suite

Audited against `skreutzer-arch/prowork-hub` @ `393a73a`, 2026-08-26.

## The headline finding

The mature ProWorks implementations and the small contract-facing implementations in
this repository are **not competing versions of the same thing**. They are different
layers that compose:

| | Mature (ProWorks) | Small (this repo) |
|---|---|---|
| **CostIQ** | Costs a *job / work order*: 6-layer breakdown, margin modes, finished-product recipes, estimate-vs-actual variance | Costs a *ManufacturingPlan*: stock, operations, flat overhead |
| **Prime** | Runs a work order through its *lifecycle*: intake → template → routing → priority → task flow → tracking, over an event log | Evaluates a *DecisionContext* and returns proceed / review / blocked |

Neither replaces the other. The mature code is the **depth**; the small code is the
**contract-facing surface**. The migration keeps both: the shells stay as the public
boundary, and the mature calculators and rules move in behind them.

Concretely, the intended composition after the port:

```
ForgeIQ → ManufacturingPlan
            ↓  (adapter, new)
          JobCostInput → calculateJobCost → CostBreakdown → calculateJobPricing
            ↓
          CostResult                       ← the existing public contract
            ↓
          DecisionContext → Prime evaluation → DecisionResult
```

## CostIQ classification — 30 files

### 1. Portable engine logic → `packages/costiq/`

Pure, no I/O, no host imports. The core files state it outright: *"Pure function… No
I/O, no async, no service lookups."*

| File | Lines | Capability |
|---|---|---|
| `core/costCalculator.ts` | 257 | 6-layer job cost calculation |
| `core/pricingEngine.ts` | 117 | Job pricing from cost input |
| `core/marginCalculator.ts` | 101 | Margin application (`applyMargin`) |
| `core/finishedProductPricingCalculator.ts` | 350 | Recipe-based finished-product pricing |
| `models/jobCostInputModel.ts` | 152 | Material / labor / consumable / workstation usage, overhead model |
| `models/costBreakdownModel.ts` | 58 | Cost breakdown shape |
| `models/pricingResultModel.ts` | 99 | Margin modes, pricing result |
| `models/workstationCostModel.ts` | 123 | Workstation cost profiles, timed cost rules |
| `models/finishedProductPricingModel.ts` | 218 | Recipes, price-status thresholds |
| `models/actualCostSnapshotModel.ts` | 135 | Actual-cost snapshots, variance summary |
| `services/actualsTrackerService.ts` | 317 | Snapshot recording, variance computation |
| `services/actualsCapturePipeline.ts` | 220 | Estimate→actual capture, layer breakdown |
| `services/jobCostInputBuilder.ts` | 238 | Builds cost input from a **structural** `WorkOrderLike` — no ProWorks import |
| `core/__tests__/*` + `services/__tests__/*` (7 files) | 2,158 | Behavioural coverage; port with the code |

`jobCostInputBuilder.ts` deserves note: it defines its own `WorkOrderLike` interface
rather than importing ProWorks' `WorkOrder`, so it is already host-independent.

### 2. Host adapter → stays in ProWorks

| File | Why |
|---|---|
| `services/extractActualsFromWorkOrder.ts` | Imports `@/modules/work-orders/types/WorkOrder` — the only ProWorks domain dependency in the module |
| `services/__tests__/extractActualsFromWorkOrder.test.ts` | Tests the adapter |

### 3. Host UI → stays in ProWorks

`ui/CostIQTab.tsx`, `ui/FinishedProductCard.tsx`, `ui/FinishedProductsAdmin.tsx`,
`ui/PriceStatusBadge.tsx`, their 2 tests, and `runtime/CostIQActualsRuntime.tsx`.

### 4. Persistence

None. This module holds no database or repository code.

### 5. Barrel

`index.ts` re-exports UI alongside core; it stays in ProWorks and is rewritten to
import calculators from the package.

## Prime classification — 68 files

The `core/` tree is spec-driven (`docs/PRIME-ENGINE-SPEC.md`, "the 10 PRIME modules")
and every file in it is pure and I/O-free by design.

### 1. Portable engine logic → `packages/prime/`

| Area | Files | Capability |
|---|---|---|
| `core/intake/` | 3 | Work-order intake validation and creation rules |
| `core/template/` | 3 | Template resolution to tentative steps |
| `core/routing/` | 3 | Step→station routing (spec §3.3) |
| `core/priority/` | 3 | Priority scoring, colour, ordering (§3.4) |
| `core/taskflow/` | 3 | Pure task-flow state machine (§3.5) |
| `core/change/` | 5 | Change orders, reroute approval |
| `core/change-consequence/` | 4 | Cascades an approved change into ETA / routing / task effects |
| `core/tracking/` | 3 | Milestone rules and advancement (§3.7) |
| `core/terminal/` | 3 | Terminal-state rules (§3.8) |
| `core/logging/` (partial) | `eventLog.ts`, `inMemoryEventLog.ts`, `migrations.ts`, `replay.ts` | Event-log contract, in-memory impl, replay |
| `models/events.ts` | 1 | The event vocabulary every module emits |
| `projections/` | 7 | Pure reducers: work-order summary, customer, master tablet, pre-production, station kiosk |
| `bootstrap/createPrimeProjectionsBundle.ts` | 1 | Wires projections; no host types |
| `core/**/__tests__/` + `projections/__tests__/` | ~15 | Behavioural coverage |

### 2. Host persistence → stays in ProWorks

| File | Why |
|---|---|
| `core/logging/idbEventLog.ts` | IndexedDB implementation of the event-log port |
| `core/logging/eventLogFactory.ts` | Chooses the IndexedDB implementation |

The `eventLog.ts` **contract** is portable; only its IndexedDB binding is not.

### 3. Host UI / runtime → stays in ProWorks

`hooks/usePrimeProjections.ts`, `hooks/usePrimeSubscriptionRuntime.ts`,
`runtime/PrimeRuntime.tsx`, `runtime/PrimeHubSseListener.tsx` (React, SSE, and
`@/modules/work-orders/api/workOrdersClientSingleton`).

### 4. Barrel

`index.ts` (358 lines) re-exports UI; stays in ProWorks, rewritten against the package.

### 5. Legacy / dead / duplicated

None identified. No file appeared unreferenced or superseded.

## Prime vs InvoFlow — no duplication

InvoFlow is a distinct module (`src/modules/invoflow-hub`, 43 files) and is entirely
pages and UI: station kiosks, master tablet, station boards, command centre. Prime's
routing decides *which station a step belongs to*; InvoFlow is the shop-floor surface
that displays and drives the work. Porting Prime's core does not move InvoFlow logic.

## What must be built, not moved

1. **`packages/contracts/`** — `ManufacturingPlan`, `CostEngine`/`CostResult`,
   `DecisionEngine`/`DecisionContext`/`DecisionResult`. `manufacturingPlan.ts`
   currently holds both the schema and ForgeIQ's `buildManufacturingPlan()`; the
   schema moves to contracts, the builder stays in ForgeIQ, so contracts depend on
   nothing.
2. **A ManufacturingPlan → JobCostInput adapter** in `packages/costiq`, so the mature
   6-layer calculator can cost a ForgeIQ plan. This is the join between the two
   implementations and does not exist in either today.
3. **Real tooling** — the engine suite has peer dependencies only, no devDependencies,
   no scripts, no `node_modules`; it currently runs on the host's toolchain. Independent
   install / typecheck / build / test requires its own.

## Sequence

Port → adapt to contracts → restore tests → verify the suite standalone → switch
ProWorks to consume → verify parity → **only then** remove the duplicated core from
ProWorks. Nothing is deleted from ProWorks in this migration until parity is proven.
