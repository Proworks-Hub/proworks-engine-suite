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

### Hosts

KSix Designs, MakerOps, or any other application can consume these engines. The
engines never depend on the host.

```
Customer
   ↓
Host builder UI (e.g. KSix)
   ↓
ForgeIQ  →  configuration · manufacturability · BOM · parts · nesting
   ↓
ManufacturingPlan          ← the contract between the two engines
   ↓
CostIQ   →  true cost · margin · recommended price
   ↓
Host builder UI  →  customer price
```

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
| `src/core/` | `zod` only | Schemas, PricingEngine, ValidationEngine, BOM/nesting, ManufacturingPlan, CostEngine port — pure & isomorphic |
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
- Production files: the host's generic `printExport.ts` / `laserExport.ts` libraries
  migrate into `src/core/export/`; an engine-emitted file manifest
  (`{file, operation, machineClass, material}`) replaces filename-regex routing.
- Admin "builder builder" — create products without code.
