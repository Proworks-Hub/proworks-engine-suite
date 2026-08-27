# ForgeIQ Engine (`@forgeiq/engine`)

ForgeIQ is MakerOps' custom builder engine: a portable, multi-tenant, **data-driven product
configurator that understands manufacturing**. Products are data (`ProductDefinition`),
not code — one generic engine renders the builder, validates manufacturability against
machine/material profiles, prices with a rules-based engine, and (later phases)
generates production files.

KSix Designs is the first host/tenant (organization #1). **Nothing in this package may
import host-application code.** Hosts consume the engine; never the reverse.

## Layout

| Path | May import | Contents |
|---|---|---|
| `src/core/` | `zod` only | Schemas, PricingEngine, ValidationEngine — pure & isomorphic |
| `src/server/` | core, `drizzle-orm`, `express` | `mo_*` tables, storage, `createBuilderEngineRouter(deps)` |
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
  drizzle `db`, admin middleware, `getOrgId`, `getUserId`. The React component receives
  `uploadFile` and `onAddToCart` callbacks — the engine knows no host endpoints.

## Versioning model

Product definitions are immutable per version: editing inserts a new row with
`version + 1` and retires the old one. Configurations pin the exact versioned
definition row plus price/validation snapshots, so later product changes never
mutate old orders.

## Roadmap breadcrumbs

- Phase 3 (production files): the host's generic `printExport.ts` / `laserExport.ts`
  libraries migrate into `src/core/export/`; an engine-emitted file manifest
  (`{file, operation, machineClass, material}`) replaces filename-regex routing.
- Phase 4 (AI "Make It For Me"): provider-abstracted concept generation feeding
  manufacturing constraints into prompts.
- Phase 5: admin "builder builder" — create products without code.
