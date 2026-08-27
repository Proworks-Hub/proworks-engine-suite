# WorkOrderIQ, tracking and event-flow — Phase 1 audit

Owner: Steven Kreutzer · 2026-08-27 · Suite `v0.8.0` (published `0.7.0`)
**Audit only. No code changed to produce this**, per §56 Phase 1 and §61.

## Headline

**Most of this directive describes things that already exist.** The work-order engine was extracted
this session, the event vocabulary is 35 types deep, and customer-facing tracking — including the
"don't show the customer station names" rule — is already implemented as a projection with an
explicit internal→customer phase mapping.

The genuinely new work is narrower than the directive's length suggests: **InventoryIQ, VisionIQ, a
shared tracking service, and notifications.** Everything else is reuse, rename, or connect.

Two findings change the shape of the work, and both argue for *less* building:

1. **The tracking projection is not missing — it is unshared.** Seven projections live inside the
   work-order engine, including a customer view that already refuses to leak station names,
   operator ids and internal priority. §12 asks for a shared tracking service; what it actually
   needs is to *lift and generalise these*, not write them.
2. **The event vocabulary is richer than the directive's proposed list.** 35 existing types against
   ~25 proposed. §18 says audit before adding — the audit says add almost nothing.

---

## 1. Engines: directive vs reality

| Directive | Exists | Notes |
|---|---|---|
| ForgeIQ | ✅ 43 files | |
| CostIQ | ✅ 17 files | |
| ReceiptIQ | ✅ 13 files | |
| WorkOrderIQ | ✅ 45 files, as **`workorder`** | Extracted from Prime earlier today |
| Prime | ✅ 4 files | Orchestration only |
| **VisionIQ** | ❌ | Nothing exists |
| **InventoryIQ** | ❌ | Nothing exists |

Shared services: `platform-events` ✅, `platform-runtime` ✅, **tracking ❌**, **notifications ❌**,
**machine-connectors ❌**.

### The naming question

§27 says a third party installs `@proworks-hub/workorderiq`. The package was `@proworks-hub/workorder`.

**Recommendation: rename.** *(Done — step 1 of §8 below.)* Not for consistency's sake — because §27 is a *licensing* statement, and
the package name is what a customer types. Every other engine carries the IQ suffix; the one an
outside developer is most likely to license standalone should not be the exception. It is a
one-line change per consumer and both consumers are ours.

---

## 2. Events — reuse, do not replace

**35 event types already exist.** The directive proposes ~25. The overlap is near-total; the
difference is naming:

| Directive | Existing | Verdict |
|---|---|---|
| `workorder.created` | `work_order.intake.created` | same thing |
| `workorder.completed` | `work_order.completed` | same thing |
| `operation.started` | `step.started` | **same thing** — "step" is this codebase's word for an operation |
| `operation.completed` | `step.completed` | same |
| `operation.rerouted` | `work_order.reroute.executed` | same |
| `workorder.priority.changed` | `work_order.priority.{assigned,escalated,deescalated}` | existing is *finer* |
| `material.shortage_detected` | — | **genuinely missing** (no InventoryIQ) |
| `quality.*`, `packaging.*` | — | **genuinely missing** |

Existing types the directive does not propose, and which are worth keeping: the whole
`work_order.eta.*` family, `work_order.change_order.*`, `work_order.template.*`,
`work_order.routing.batched_with`, `step.rework.logged`, `step.issue_flagged`.

**Recommendation: keep `work_order.*` / `step.*` and add only what is missing.** Renaming 35 types to
match a proposal would be churn with a migration cost and no gain — and the directive itself says to
prefer existing semantics.

---

## 3. Tracking already exists — as projections, not a service

`packages/workorderiq/src/projections/` holds seven, including:

- **`customerProjection.ts`** — already implements §14. Its own header: *"Deliberately narrow — no
  station names, no step-level detail, no operator IDs, no internal priority."* It maps internal
  milestones to customer phases through one function so a rename never leaks outward.
- `masterTabletProjection`, `stationKioskProjection`, `preProductionProjection` — the ProWorks-depth
  views of §26 and §37.
- `workOrderSummaryReducer` + `createWorkOrderSummaryProjection` — the event-stream reducer.

And the milestone model in `core/tracking/trackingTypes.ts` is already the customer sequence:

```
intake → routed → in_production → quality_check → ready_for_pickup → completed
```

**Recommendation: the tracking service lifts these out and adds an audience policy (§41), a
normalized `OrderTrackingSnapshot` (§13), and shipment merge (§23).** It does not reimplement the
projections. Roughly a third of §11–§15 is already done.

---

## 4. Hosts

### ProWorks — `src/modules/work-orders`, 191 files

| Area | Files | Classification |
|---|---|---|
| `components/` 47, `hooks/` 10, `api/` 37 | 94 | **KEEP IN HOST** — React, HTTP, host workflow |
| `utils/` 18, `services/` 13 | 31 | **KEEP IN HOST**, pending file-level review |
| `domain/` 26 | 26 | **INSPECT** — names suggest portable logic (`workOrderExecutionProjection`, `workOrderOperationalIntelligence`, `workOrderFirstGovernance`, `workOrdersDomainPort`) |
| `projections/` 5 | 5 | **INSPECT** — likely duplicates engine projections |
| `infrastructure/`, `repository/`, `adapters/` | 8 | **KEEP IN HOST** — persistence |
| rest | 27 | types, constants, selectors — mixed |

Of the `@/` imports in `domain/`, **61 are intra-module** and only ~7 reach outside
(`production-routing`, `orders`, `shared/status`, `shared/ids`, `proworks-hub`). So it is more
self-contained than it looks — but the risk is **duplication with the engine**, not coupling.

`src/modules/workorder-engine/` (11 files) is already the correct host-binding layer: IndexedDB
event log, projection hooks, SSE runtime. **DO NOT TOUCH.**

### KSix

No work-order or tracking system. Its 48 "tracking" hits are UI components — pointer and analytics
tracking, unrelated. **KSix is a clean integration target**, and §46's vertical slice starts from
nothing rather than from a migration.

### MakerOps

**Does not exist.** §48 is therefore contract-design work, not integration work, and nothing in this
phase can be validated against it.

---

## 5. Migration map

| Category | What |
|---|---|
| **REUSE FROM EXISTING** | The 35 event types · the 7 projections · `Milestone` and `StepState` · the event log · `createWorkOrderProjectionsBundle` |
| **MOVE TO TRACKING SERVICE** | The projections, generalised — plus audience policy, snapshot contract, shipment merge |
| **MOVE TO CONTRACTS** | `OrderTrackingSnapshot`, `TrackingMilestone`, `ShipmentTrackingSnapshot`, `WorkOrderCommand`, `ProductionAssetManifest`, `EngineCapability` |
| **KEEP IN HOST** | ProWorks `components/`, `hooks/`, `api/`, `infrastructure/`, `repository/`; all of `workorder-engine/` |
| **INSPECT BEFORE MOVING** | ProWorks `work-orders/domain` (26) and `work-orders/projections` (5) — duplication risk |
| **BUILD NEW** | InventoryIQ · VisionIQ · tracking service · notification service · machine-connector interface |
| **RENAME** | `workorder` → `workorderiq` (§27) |
| **DO NOT TOUCH** | ProWorks `production-routing` (dispatch, not planning — see `docs/OWNERSHIP-TABLE.md`) · the `/api/local/prime/events/stream` wire contract |
| **DEPRECATE** | Nothing yet. Nothing has been proven redundant |

---

## 6. What the directive asks for that already holds

Worth stating so it is not rebuilt: portability guards (12, injection-verified) · the event bus and
envelope with correlation and causation · versioned contracts · the storage-port pattern (§31 —
`EventLog`, `WorkflowStateStore` already work this way) · capability-based access (§29 — `CAPABILITIES`
and `requireCapability` shipped) · multi-tenant isolation tests (§42 — 100 orgs, interleaved) ·
failure isolation (§20) · Prime kept lightweight (§2 — it is 4 files).

## 7. Honest gaps

- **Nothing calls the capability layer yet.** §49's basic-vs-advanced split is enforceable and
  unenforced; no host invokes `requireCapability`.
- **ETA grounding (§40) is unaddressed.** `work_order.eta.*` events exist; whether they carry a
  confidence level needs checking before tracking surfaces an estimate.
- **No InventoryIQ means §9 cannot be built**, and `material.shortage_detected` has no producer.
- **Public tracking tokens (§43) do not exist.**

## 8. Recommended sequence

Each step ends green — typecheck, tests, and both hosts building.

1. Rename `workorder` → `workorderiq` (§27) — small, and every later step inherits the name
2. Tracking contracts into `contracts` (§13) — snapshot, milestone, shipment
3. Tracking **service** generalising the existing projections, with audience policy (§12, §41)
4. Command boundary `WorkOrderCommand` (§10) — Prime stops being able to mutate state directly
5. The missing events only: `quality.*`, `packaging.*`, `material.*` (§18)
6. InventoryIQ (§9) — the largest genuinely new engine
7. VisionIQ + `ProductionAssetManifest` (§8)
8. Notification service (§21)
9. The engine-level vertical slice (§45)
10. KSix integration (§46), then ProWorks (§47)

**Steps 1–4 are reuse and connection. Step 6 onward is the real building.**

---

## 9. Progress

| Step | State | Note |
|---|---|---|
| 1. Rename to `workorderiq` | ✅ | Also fixed two stale `packages/workorder` paths the rename left behind |
| 2. Tracking contracts | ✅ | Redaction is structural — narrowing deletes a block rather than re-picking fields |
| 3. Tracking service | ✅ | Does **not** depend on WorkOrderIQ; WorkOrderIQ implements its port |
| 4. Command boundary | ✅ | First enforcement of the capability layer on the write side |
| 5. Missing events | ✅ | `quality.*` and `packaging.*` only; `material.*` deferred to step 6 |
| 6. InventoryIQ | ✅ | Holds no cost; quantities carry units and accumulate as integers |
| 7. VisionIQ | ⛔ | **Blocked** — §8 was never saved, and inferring an engine's whole domain is the expensive kind of guess |
| 8. Notifications | ✅ | Decides and records; the host sends |
| 9. Vertical slice | ✅ | Closed the `DecisionContext.inventory` seam, open since Prime was written |
| 10. KSix, then ProWorks | ✅ | Both on **branches**. Neither `main` touched, so nothing is deployed |

### Two findings from doing the work

**The portability guard named a pair, not a rule.** It forbade `prime ↔ workorderiq`
specifically, so every package added afterwards was unguarded by default. Verified by injecting an
import of `workorderiq` into the new `tracking` package: **12 tests passed.** The rule is now stated
generally — no package imports another, contracts excepted — and catches that injection by name.

**The top-level `tests/` directory was never typechecked.** The root tsconfig included
`packages/*/src` and `packages/*/tests` but not `tests/`, so eight integration tests were checked by
vitest alone — which strips types. That is the mechanism behind the tests-pass-typecheck-fails trap
that has recurred repeatedly here. Adding it surfaced seven real errors, including two assertions
typed against a union so wide the properties they checked did not exist on it.

**The vitest alias list and the tsconfig paths are hand-maintained, and were disagreeing.**
Typecheck resolved suite packages through each package's built `dist`; vitest resolved through
`src`. The symptom is a phantom "has no exported member" for code that plainly exports it — the same
disagreement-between-checkers family as the trap above. Both lists are now guarded, and the guard
was verified by removing an alias and watching it fail by name.

### Gaps closed since §7 was written

- **ETA grounding (§40) was already done.** `EtaConfidence` (`firm | tentative | at_risk`) exists
  with documented derivation from real step estimates. I listed it as open; it was not.
- **The capability layer now has callers** — tracking's deep audiences and every work-order command.
  Both fail closed: no resolver configured means refused, not allowed.
- **`DecisionContext.inventory` now has a producer.** It has existed since Prime was written with
  nothing filling it — the decision engine asking whether there is material and getting silence.

### Still open

- **VisionIQ has no specification here.** §8 was not saved to the docs folder and only this audit
  mentions the engine. What it owns needs stating before it is built.
- **`material.*` events are defined and unpublished.** InventoryIQ returns them; no host drains them
  to a bus yet.
- **Nothing is deployed.** Both host integrations sit on branches —
  `ksix/feat/tracking-integration` and `prowork-hub/feat/engine-suite-0.8`. Merging either to `main`
  is the deploy, and that decision is not mine.
- **KSix reports no shipment block**, because the `orders` table has no carrier or tracking number.
  Wiring a `ShipmentProvider` is what makes the merge rule earn its place.
- **`workOrderTrackingProjector.test.ts` in ProWorks is failing and was failing before.** It is worth
  returning to now that a shared tracking service exists.
