# ForgeIQ Engine (`@forgeiq/engine`)

ForgeIQ Engine is a **portable, host-independent product configuration and
manufacturability engine**. Products are data (`ProductDefinition`), not code — one
generic engine renders the builder, validates manufacturability against machine and
material profiles, derives the bill of materials and stock requirements, and generates
production files.

**KSix Designs is its first production host.** Other systems — including MakerOps, another
storefront, or an internal quoting application — can consume ForgeIQ without ForgeIQ
depending on them. ForgeIQ does not belong to any host.

**Nothing in this package may import host-application code.** Hosts consume the engine;
never the reverse.

## The ecosystem in plain language

| System | Role |
|---|---|
| **KSix Designs** | Sells the product. Customer-facing ecommerce host. |
| **ForgeIQ** | Understands the product. *Configure it. Validate it. Manufacture it.* |
| **CostIQ** | Understands the money. *Cost it. Margin it. Price it.* |
| **Prime** | Understands the decisions. *Evaluate it. Route it. Decide what happens next.* |
| **MakerOps** | Runs the production. Jobs, scheduling, machines, inventory, execution. |
| **ProWorks Hub** | Brings the business together. A unified platform consuming the engines and operational systems. |

**ForgeIQ, CostIQ, and Prime are a portable intelligence suite.** KSix Designs,
ProWorks Hub, and MakerOps *consume* that intelligence; none of them owns it. ProWorks
Hub is a host and platform, not the engines' architectural owner — the same is true of
KSix Designs. MakerOps is a manufacturing operations system that consumes engine output.

### Two kinds of portability

**Individual portability.** Each engine stands alone. ForgeIQ works with no CostIQ and
no Prime. CostIQ costs any valid `ManufacturingPlan` — ForgeIQ is the *preferred*
producer of one, not the only possible producer, so a foreign system that can build
the contract can be costed. Prime evaluates a `DecisionContext` assembled from whatever
is available, including contexts with no plan and no cost in them at all.

**Suite portability.** The contracts travel with the engines. Move ForgeIQ, CostIQ,
Prime, and their contracts into another compatible TypeScript application, supply host
adapters, and the three still know how to talk to each other — because their
integration is expressed in portable contracts rather than host glue. There is no
ProWorks-specific (or KSix-specific) adapter sitting between two engines, and there
must never be one.

`tests/portability.test.ts` enforces this mechanically rather than by convention.

## Architecture

### ForgeIQ — *configure it, validate it, manufacture it*

ForgeIQ understands **what is being made and how it can be produced**. It owns:

- Product definitions, options, dimensions, materials, finishes
- Customization surfaces, artwork, and text
- Manufacturability validation and machine compatibility
- Manufacturing constraints (minimum feature size, cut heights, work area)
- Bill of materials: parts, dimensions, quantities
- Sheet nesting, material utilization, required stock
- Manufacturing operations and production files (cutlines, work orders)

### CostIQ — *cost it, margin it, price it*

CostIQ understands the **economics** of producing a ForgeIQ manufacturing plan:
purchasing cost, waste, machine and labor cost, consumables, outsourcing, overhead
allocation, quantity efficiencies, margin rules, and recommended price.

CostIQ is **not implemented here**. What exists is the seam: ForgeIQ emits a
`ManufacturingPlan` and defines a `CostEngine` port
(`src/core/cost/costEngine.ts`) that a costing engine implements. A cost engine
receives the plan and nothing else — it never needs the builder UI, the host
application, or the product definition.

### Prime — *evaluate it, route it, decide what happens next*

Prime answers **what should happen next**, given everything known: routing,
prioritization, approval requirements, capacity and material exceptions, outsourcing,
risk. It replaces neither of the other engines — it coordinates specialized
intelligence.

Prime is **not implemented here** either. What exists is the seam: a `DecisionContext`
carrying normalized engine output (a `ManufacturingPlan`, a `CostResult`) alongside
operational signals a host supplies (commercial terms, capacity, inventory), and a
`DecisionEngine` port returning a `DecisionResult`
(`src/core/decision/decisionEngine.ts`). Every field but the subject is optional, so a
decision engine works on partial information instead of demanding the whole stack.

### Hosts

KSix Designs, ProWorks Hub, MakerOps, or any other application can consume these
engines. The engines never depend on the host.

```
Customer
   ↓
Host builder UI (e.g. KSix)
   ↓
ForgeIQ  →  configuration · manufacturability · BOM · parts · nesting
   ↓
ManufacturingPlan          ← portable contract
   ↓
CostIQ   →  true cost · margin · recommended price
   ↓
CostResult                 ← portable contract
   ↓
Prime    →  proceed · review · block · actions
   ↓
DecisionResult             ← portable contract
   ↓
Host / MakerOps  →  customer price, jobs, routing
```

### The first vertical slice

A real KSix fire pit travels the whole chain in `tests/verticalSlice.test.ts`:
configuration → ForgeIQ validation → `ManufacturingPlan` → CostIQ → `CostResult` →
Prime → `DecisionResult`. It runs entirely at the engine level — no host, database,
HTTP, React, ProWorks Hub, or MakerOps — which is the practical proof that the suite
is portable.

First-cut implementations of the two downstream engines live alongside ForgeIQ:

| Path | Engine | Depends on |
|---|---|---|
| `src/costiq/` | CostIQ — material, waste, machine, setup, labor, overhead, recommended price | `ManufacturingPlan` + `CostEngine`, **type-only** |
| `src/prime/` | Prime — deterministic approve / review / block rules | decision contracts, **type-only** |

Both import their contracts with `import type`, which TypeScript erases at compile
time, so **neither carries a single line of ForgeIQ code at runtime**. Living in this
repository is a convenience during development, not ownership — the portability guard
enforces the separation on every test run.

Both are deliberately shallow. CostIQ applies a flat overhead percentage rather than
allocating real shop expenses, and reports what it could not cost (finishing has no
rates yet) in `unpriced` and `assumptions` instead of guessing. Prime runs a handful of
threshold rules with no AI, scheduling, or optimization. Deepening them is Phase 3 and
Phase 4; ForgeIQ stays the first engine to deepen because it produces the physical
truth the other two consume.

**Existing ForgeIQ pricing is untouched** and still authoritative for what the customer
is charged. CostIQ is currently a production-intelligence path running beside it. The
two agree on direct cost and differ only by CostIQ's overhead, which is a useful check
while the engines mature.

### The contract surface

Three directories hold everything the engines use to talk to each other:

| Path | Contract | Produced by | Consumed by |
|---|---|---|---|
| `src/core/manufacturing/` | `ManufacturingPlan` | ForgeIQ | CostIQ, Prime, MakerOps |
| `src/core/cost/` | `CostEngine`, `CostResult` | CostIQ | ForgeIQ/host, Prime |
| `src/core/decision/` | `DecisionEngine`, `DecisionContext`, `DecisionResult` | Prime | Hosts, MakerOps |

Each contract carries an explicit version marker (`planVersion`, `resultVersion`,
`contextVersion`) so it can evolve deliberately. These three directories are the unit
that would move together if the contracts are ever extracted into their own package —
that extraction is deliberately deferred until the complexity justifies it.

### Where pricing stands today

ForgeIQ's `PricingEngine` still computes the customer price and a rough internal cost
estimate, and continues to work unchanged — nothing was removed. It is the piece a real
CostIQ is expected to supplement or replace, by routing
`ForgeIQ → ManufacturingPlan → CostIQ → CostResult` instead. The seam is in place; the
migration is not required until CostIQ exists.

One known wrinkle: production time estimates (`estMachineMinutesPerSqFt`,
`setupMinutes`, `laborMinutes`) currently live inside the definition's `pricing.internalCost`
block, though they are manufacturing facts rather than pricing ones. `ManufacturingPlan`
reports them correctly as manufacturing data. Relocating them to a dedicated `production`
block is a future cleanup, deferred because it would invalidate stored definitions.

## Layout

| Path | May import | Contents |
|---|---|---|
| `src/core/` | `zod` only | Schemas, PricingEngine, ValidationEngine, BOM/nesting, ManufacturingPlan, CostEngine and DecisionEngine ports — pure & isomorphic |
| `src/server/` | core, `drizzle-orm`, `express` | `fiq_*` tables, storage, `createBuilderEngineRouter(deps)` |
| `src/react/` | core, `react`, `@tanstack/react-query` | Generic `<BuilderEngine>` UI |
| `tests/` | relative imports only | Vitest units (run under the host's vitest) |

## Consumption rules

- **Never run `npm install` in this directory.** All peer deps resolve from the host's
  `node_modules`; a local one would duplicate React and break hooks.
- Engine-internal imports are **always relative** (tsx/esbuild resolve tsconfig `paths`
  per-file against the nearest tsconfig, so the host's alias is not visible here).
- Hosts import via their own alias, e.g. `@forgeiq/engine/server` →
  `<this repo>/src/server`.
- The host injects everything environment-specific into `createBuilderEngineRouter`:
  drizzle `db`, admin middleware, `getOrgId`, `getUserId`, and an optional `aiProvider`.
  The React component receives `uploadFile` and `onAddToCart` callbacks — the engine
  knows no host endpoints.

## Multi-tenancy

Every row belongs to an organization, so one deployment can serve several shops.
KSix Designs is organization #1 in its own deployment; that is a host detail, not an
engine assumption.

## Versioning model

Product definitions are immutable per version: editing inserts a new row with
`version + 1` and retires the old one. Configurations pin the exact versioned
definition row plus price/validation snapshots, so later product changes never
mutate old orders.

Definitions are persisted as JSON and read back by cast, so rows written before a
schema field existed come back without it. Consumers guard for absence and storage
re-parses definitions on read to apply schema defaults — any new field with a default
needs the same care.

## Roadmap breadcrumbs

- A real CostIQ implementing `CostEngine`, consuming `ManufacturingPlan`.
- A real Prime implementing `DecisionEngine`, consuming `DecisionContext`.
- Production files: the host's generic `printExport.ts` / `laserExport.ts` libraries
  migrate into `src/core/export/`; an engine-emitted file manifest
  (`{file, operation, machineClass, material}`) replaces filename-regex routing.
- Admin "builder builder" — create products without code.
