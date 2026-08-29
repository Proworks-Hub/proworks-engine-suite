# ProWorks Engine Suite

Copyright © 2026 Steven Kreutzer. All Rights Reserved. Proprietary — UNLICENSED.

The portable engine suite of **the Hive** — 24 packages, ~1,630 tests, no host
dependencies anywhere.

> **Rewritten 2026-08-29.** This document previously described a single ForgeIQ
> package and stated that CostIQ and Prime were *"not implemented here"*. Both
> have been implemented in this repository for some time — `costiq` is 25 source
> files, `prime` is 5 — and the README had simply not kept up. If anything below
> drifts from the code again, the code is right.

---

## What this is

Engines that each understand one business domain, own nothing outside it, and can
be lifted into any host application. **No package here imports host code**, and a
test enforces it. Hosts consume the engines; never the reverse.

Governance is enforced at runtime: a Core will not execute a capability without an
authorization decision, whoever asks. Constitution §1.9 —
**capability does not imply permission.**

```
Hive Constitution  →  Engine Charter  →  Contract standard  →  Implementation
```

The Constitution is synchronized at `Documents/ProWorks-Ecosystem/constitution/`.
All 58 approved Engine Charters are referenced with integrity hashes in
[`charters/registry.json`](charters/registry.json).

---

## The layers

Two planes. The **capability plane** obeys a downward-only dependency law; the
**constitutional plane** sits outside it, because Governance authorizes *across*
the system and "across" is not a rank.

```
                    HUMAN CONSTITUTIONAL AUTHORITY
                                │
                         HIVE CONSTITUTION
                                │
            ┌───────────────────┼───────────────────┐
       GOVERNANCE           SENTINEL            FOUNDRY          ← Overwatch
            └───────────────────┼───────────────────┘
                               ARIA                              ← Intelligence
                                │
                          PRIME ENGINE                           ← Orchestration
                                │
            ───────────── CAPABILITY PLANE ─────────────
                         8 CORE ENGINES
                   SHARED PLATFORM ENGINES
                    SPECIALIZED ENGINES
                      INDUSTRY ENGINES
                       HOST APPLICATIONS
```

Enforced by `tests/hiveArchitecture.test.ts`. The rule that matters most is the
absence: **nothing depends upward**, and a Specialized engine may depend only on
the platform layer — not even on its own Core.

---

## Packages

### Constitutional plane

| Package | Version | State | What it does |
|---|---|---|---|
| `governance-engine` | 0.1.0 | Experimental | Decides whether consequential activity is permitted. Grants, Core Protections, purpose-binding, risk ceilings, expiry. Owns authorization decisions and no domain state. |
| `prime` | 0.13.0 | Experimental | Orchestration and decision-making. Deliberately lightweight and hard-codes no engine. Nexus/Pulse chambers and the durable Execution Ledger are not built. |

*Sentinel IQ, Foundry EvolutionIQ and ARIA are chartered and unimplemented.*

### Core engines — 4 of 8 built

| Package | Version | What it coordinates |
|---|---|---|
| `foundation-core` | 0.1.0 | The universal structural language: identity, canonical references, versions, relationships, health vocabulary. |
| `finance-core` | 0.18.0 | Monetary reasoning. Routes to CostIQ and ReceiptIQ. |
| `operations-core` | 0.16.0 | Work: ordered sequences with honest partial-failure state. |
| `resources-core` | 0.2.0 | What an organization has. Distinguishes a **reading** from a **commitment** — stock goes stale, cost does not. |

*Knowledge, Communication, Intelligence and Domain Cores are chartered and unbuilt.*

### Shared platform

| Package | Version | What it provides |
|---|---|---|
| `contracts` | 0.14.0 | The shared vocabulary: tenancy, capabilities, events, tracing, governance, identifiers, classification, charter registry. Depends on nothing but zod. |
| `core-kit` | 0.16.0 | The machinery every Core shares — registry, routing, timeouts, typed refusals, governed resolution. |
| `platform-events` | 0.13.0 | In-memory `EventBus`, resilient delivery, processed-event ledger for idempotent consumers. |
| `platform-runtime` | 0.13.0 | In-memory job queue, structured logger, metrics collector. |
| `control-plane` | 0.14.0 | Engine manifests, health, topology, diagnostics, incidents, releases — the Hive console's data layer. |
| `intelligence-core` | 0.14.0 | Provider-independent AI contracts. Nothing here names a vendor. |
| `model-runtime` | 0.14.0 | Provider adapters, model registry, routing, retry, fallback, structured-output validation. |
| `model-evals` | 0.14.0 | Measurable regression testing for models and instructions. |

### Specialized portable engines

| Package | Version | What it owns |
|---|---|---|
| `forgeiq` | 0.13.0 | *Configure it, validate it, manufacture it.* Produces the `ManufacturingPlan`. |
| `costiq` | 0.13.0 | *Cost it, margin it, price it.* The only place money is computed. |
| `workorderiq` | 0.13.0 | The canonical work order and its production execution state. |
| `visioniq` | 0.13.0 | How a digital asset should be prepared for a process, machine and material. |
| `receiptiq` | 0.13.0 | *Read it, normalize it, learn from it.* Receipts into purchases and price observations. |
| `inventoryiq` | 0.13.0 | What is on hand, spoken for, and about to run out. Holds no cost. |
| `senseiq` | 0.14.0 | Physical-world intelligence: devices, spaces, observations, authorized command intent. |

### Services — not engines

| Package | Version | What it does |
|---|---|---|
| `order-ingestion` | 0.13.0 | Normalizes an order from any channel into the canonical contract, once. |
| `tracking` | 0.13.0 | Where an order actually is, merged across production and carrier. |
| `notifications` | 0.13.0 | Who should be told what, and told once. |

The distinction is deliberate and recorded in the engine map: a service has no
chartered domain ownership.

---

## The V1 runtime slice

Six specialists form the closed shop loop, flagged `v1Runtime: true` in the
charter registry:

**ForgeIQ → CostIQ → Prime → WorkOrderIQ → InventoryIQ**, with **VisionIQ**
preparing assets.

`tests/verticalSlice.test.ts` drives that path end to end, and a test fails if an
out-of-scope engine is added to the V1 allowlist.

---

## Working here

```bash
npm run verify      # typecheck + full suite
npm run build       # tsc -b, project references
npm run test        # vitest
```

### Adding a package

`workspaces` is `packages/*` and cannot drift. Four lists still must be updated,
and `tests/packageWiring.test.ts` fails if any is missed:

1. the `build` script — order matters
2. the `clean` script — must match `build` exactly
3. `tsconfig.json` path mapping
4. `vitest.config.ts` alias

Then add a row to `charters/registry.json` with a truthful
`implementationLifecycle`, and a component to `hiveMap.ts`. **A `partial`
component must state its gap** — the schema refuses one that does not.

### Architecture tests you will meet

| Test | Enforces |
|---|---|
| `hiveArchitecture` | The dependency law; the eight Cores; the Core admission bar |
| `hiveClassification` | The two planes; constitutional classes have no tier |
| `portability` | No host imports; no ambient I/O in pure engines |
| `packageWiring` | Every package in every list |
| `charterRegistry` | 58 charters + 1 framework, integrity-hashed |
| `governedResolution` | Governance decides before capability resolution |
| `verticalSlice` | The V1 shop loop, end to end |

---

## Rules that will not bend

- **Capability does not imply permission.** Governance is a required coordinator
  dependency; the only way to express "no governance" is to pass
  `createDenyAllGovernance()` and mean it.
- **Nothing depends upward.** A specialist that imports its Core can never be
  reused under a different one.
- **An engine owns one domain.** Movement does not transfer ownership: a
  projection of inventory is not inventory.
- **Unknown ≠ zero ≠ healthy.** An engine that cannot answer says so rather than
  answering emptily.
- **A `partial` component states its gap**, or the schema refuses it.
- **No false validators.** An assertion that cannot fail is worse than none —
  Engineering Rule 24.
