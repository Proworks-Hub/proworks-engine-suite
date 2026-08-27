# WorkOrder extraction — Phase A inventory

Owner: Steven Kreutzer · 2026-08-27 · Suite `v0.6.0`
**Inventory only. No code changed to produce this.**

## Headline

**Prime is already two unrelated things in one package, and they do not touch.**

| | Files | Imports |
|---|---|---|
| Work-order lifecycle (`core/`, `models/`, `projections/`, `bootstrap/`) | 57 incl. tests | **nothing at all** — not even `@proworks-hub/contracts` |
| Orchestration (`primeEngine.ts`, `workflow/`) | 4 | `@proworks-hub/contracts` only |

The lifecycle does not import the decision layer. The decision layer does not import the lifecycle.
Verified by grepping every non-relative import in both halves.

**So this is a MOVE, not a refactor.** There is no coupling to break, no behaviour to preserve
through a rewrite, and no shared state to disentangle. The directive's Phase C ("extract domain
logic while preserving behaviour") is satisfied by relocating files whose behaviour cannot change,
because nothing they depend on is changing.

That is a fortunate accident of how Prime was built, and it is worth saying plainly rather than
manufacturing work to look thorough.

## What moves

Everything under these, with their tests:

`core/intake` · `core/template` · `core/routing` · `core/priority` · `core/taskflow` ·
`core/tracking` · `core/terminal` · `core/change` · `core/change-consequence` · `core/logging` ·
`models/events.ts` · `projections/` (7) · `bootstrap/`

`core/logging` goes with them: its `EventLog` is typed to `WorkOrderEvent` and the workflow runner
does not use it. It is the work-order event log, not a general one.

## What stays

`primeEngine.ts` — `decide(DecisionContext) → DecisionResult`
`workflow/` — the durable workflow runner and its in-memory store
`index.ts`

**Prime becomes ~4 files.** That is not a diminishment; it is the directive's point. Prime is the
conductor, and a conductor who also plays every instrument is the bottleneck the architecture
exists to avoid.

## Consumers

| Host | Files importing `@proworks-hub/prime` |
|---|---|
| ProWorks Hub | 12 |
| KSix | 0 |

ProWorks reaches Prime through **one barrel** — `src/modules/prime-engine/index.ts` — which
re-exports 236 names. That barrel exists precisely so internal layout stays invisible to the app.

**So the compatibility strategy is: the barrel absorbs the split.** It imports the lifecycle from
`@proworks-hub/workorderiq` and the decision layer from `@proworks-hub/prime`. Its 12 consuming
files change by zero lines.

This is better than the alternative the directive allows (§32 Phase E, a temporary compatibility
adapter inside Prime). Prime re-exporting WorkOrder would make one engine depend on another,
which the architecture guard forbids and which would have to be unpicked later. One two-line
change in a host barrel avoids inventing debt we would then have to schedule removing.

## Database and API ownership

Neither half owns persistence. Prime is pure and I/O-free across all 47 shipped files, enforced by
two architecture guards. Storage reaches it through ports — `EventLog`, `WorkflowStateStore` — and
hosts bind them. There is no schema to divide and no migration to write.

## Capability levels — genuinely new work

Nothing in the suite expresses "this consumer gets basic work orders, that one gets shop-floor
execution". `FeatureFlags` exists but answers a different question: it is for rolling a capability
out, not for describing what a subscription includes.

This is the one part of the directive that is not a relocation, and it is the part that makes
MakerOps possible without ProWorks.

## What this does NOT require

- No behaviour changes to the lifecycle
- No database migration
- No change to KSix
- No change to ProWorks' 12 consuming files
- No compatibility shim inside Prime
