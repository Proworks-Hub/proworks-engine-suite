# Architecture gap analysis

Owner: Steven Kreutzer · 2026-08-27 · Suite `v0.3.0` (published)
Assessed against the Architecture Hardening & Scalability Directive.

**Phase 1 (inventory) complete. Phase 2 (purity guards) implemented. Phases 3+ pending.**

The three conflicts in §3 have been **resolved and are binding** — see the ecosystem decision log,
entry *"Three hardening-directive items resolved against existing architecture"*:
tenancy never touches canonical knowledge · durable workflow state arrives as a port ·
no gateway or restructure until there is a caller.

---

## Headline

The directive assumes less exists than actually does. Several of its "add now" items are already
built, and in two cases the existing implementation is **stricter** than what the directive
describes. Three directive items **conflict with architecture that is load-bearing today**, and
adopting them literally would undo the portability the directive's own §47 calls core IP.

The genuinely missing pieces are real and worth building — but they are fewer than the list of 29
suggests, and the order matters more than the count.

## Current inventory

| Package | Src files | Role | Pure? |
|---|---|---|---|
| `contracts` | 5 | Shared vocabulary. Depends on nothing but zod | yes |
| `forgeiq` | 52 | Manufacturability. `core` pure; `server` + `react` are optional layers | core yes |
| `costiq` | 25 | Cost intelligence | yes |
| `prime` | 61 | Decision + work-order lifecycle | **yes — verified, zero I/O** |
| `receiptiq` | 16 | Receipt/purchase intelligence | yes |

Consumed today by **two hosts** (KSix, ProWorks) from a published registry, plus a bare external
consumer used as a portability harness.

---

## 1. Already implemented

### Architecture tests (directive §51) — done, and verified by injection

`tests/portability.test.ts` runs 8 guards: no host imports, no host-specific branching, contracts
depend only on zod, engines never import each other, ForgeIQ core free of express/drizzle/react,
server/react layer separation, runtime deps limited to zod + suite packages.

Each guard has been **proven to fail** by injecting the violation and reverting. A guard nobody has
seen fail is a guard nobody should trust.

### Dependency inversion / storage abstraction (§36) — largely done

Eleven ports already exist: `CostEngine`, `DecisionEngine`, `AIProvider`, `ReceiptExtractor`,
`EventLog`, `SubscribableEventLog`, `ReceiptRepository`, `MerchantKnowledgeRepository`,
`ItemKnowledgeRepository`, `PriceObservationRepository`, `EventLogListener`.

No engine opens a connection to anything. Hosts inject implementations.

### Contract versioning (§7, §57) — done for contracts

Every contract carries an explicit version marker: `planVersion`, `resultVersion`,
`contextVersion`, `receiptVersion`. The discipline the directive wants for events already exists
for contracts, and the event work should copy it rather than invent a second scheme.

### Event sourcing foundations (§4, §7, §8) — **already built inside Prime**

This is the most under-recognised asset. `packages/prime/src/core/logging/` provides:

- `EventLog` — `append`, `listByWorkOrder`, `listByType`, `listSince`, `size`
- `SubscribableEventLog` — **`subscribe(listener)`, i.e. a working publish/subscribe seam**
- `replay.ts` — rebuild state from the log
- `migrations.ts` — **upgrade-on-read event versioning**, so payload shape can evolve without
  rewriting the persisted log
- `projections/` — seven read models already derived from the event stream (§44)

The directive asks for event versioning, replay and projections as new work. They exist, are
tested, and are in production use. **The platform bus should generalise this, not replace it.**

### Idempotency, in the place it mattered first (§8, §56)

ReceiptIQ computes deterministic fingerprints — `receiptFingerprint`, `observationFingerprint`,
`skuFingerprint` — specifically so the same fact contributed twice lands once, including from two
different hosts. Proven by test: two hosts, different owners, different merchant spellings, same
fingerprint.

### Tenant isolation (§16, §55) — **stricter than the directive asks**

ReceiptIQ's ownership model classifies every record `canonical` / `host-private` /
`tenant-private`, with no default. The contribution boundary refuses four ways, and
`assertNoIdentityFields` **throws** if a canonical record carries a field *named* like an
identifier, at any nesting depth.

See the conflict in §3 below — this directly contradicts one directive instruction.

### Multi-tenant persistence where persistence exists (§16)

ForgeIQ's `fiq_*` tables carry `orgId` with org-scoped unique indexes.

### Domain ownership documented (§14) — done today

`docs/OWNERSHIP-TABLE.md`: ForgeIQ proposes, CostIQ prices, Prime decides, the Work Order Engine
records, the Hub applies — with the rule that settles arguments (*live shop state → Hub;
same-in-any-shop → engine*).

---

## 2. Partially implemented

| Area | What exists | What is missing |
|---|---|---|
| **Events** | Prime's `EventLog` + subscribe + replay + migrations | Cross-engine envelope; ForgeIQ/CostIQ/ReceiptIQ publish nothing |
| **Tenancy vocabulary** | ForgeIQ `orgId`; CostIQ `tenantId`; ReceiptIQ `ownerRef` | Three names for adjacent ideas, reconciled nowhere. **Contracts has zero** |
| **Read models** | 7 Prime projections | None spanning engines |
| **Honesty signals** | `assumptions[]`, `unpriced[]`, `caveats[]`, `warnings[]`, `needsReview[]` | Domain-level, not telemetry. Not machine-queryable |
| **Health** | Engines are libraries; nothing to probe | Meaningful once anything is deployed as a service |

The tenancy divergence is the most consequential: three engines, three words, and the shared
contracts package — the one place that could reconcile them — mentions none of them.

---

## 3. Conflicts with existing architecture — **do not adopt literally**

### 3.1 §16 "every persistent entity carries organizationId" vs ReceiptIQ's privacy guard

**Direct contradiction.** ReceiptIQ's canonical records must carry *no* tenant identifier — that is
the entire point, and `assertNoIdentityFields` throws on `organizationId` by design.

**Resolution:** tenancy belongs on **host-private and tenant-private** records, never on canonical
knowledge. The existing ownership model is the better implementation and should become the
ecosystem-wide vocabulary. Do not weaken it to satisfy a general rule.

### 3.2 §21 durable Prime workflow state vs Prime's purity

Prime is **pure and I/O-free — verified, zero I/O in 61 files**. That is precisely what lets it be
consumed as a library today and deployed as a service later (§47, §49).

Adding a `workflow_instance` table *inside* Prime would make it depend on a database and end its
portability.

**Resolution:** durability arrives as a **port** — `WorkflowStateStore` — with the host supplying
Postgres, SQLite or in-memory. Same pattern as `EventLog`, which already proves it works. The
directive's goal (survive restart, multiple instances) is fully achievable this way.

### 3.3 §15 API Gateway vs the engines being libraries

The engines are npm packages consumed in-process. A gateway presumes network services. Building one
now adds an operational tier serving no current caller, which §49 explicitly warns against.

**Resolution:** define the *boundary contract* — tenant context, correlation id, identity claims —
so a gateway can be added without touching engine code. Build the gateway when a second deployment
topology actually exists.

### 3.4 §50 repository restructure vs a just-published package layout

Moving to `engines/` + `platform/` + `apps/` would relocate ~160 files and break the `exports` maps
of five packages published hours ago, along with both hosts' imports.

**Resolution:** keep `packages/`. Add platform capabilities as `packages/platform-*`. The directive
itself says not to move thousands of files to match its example.

### 3.5 §46 vs ReceiptIQ's host-independence

The directive describes Receipt Engine feeding CostIQ, inventory and analytics. Correct in spirit —
but ReceiptIQ must not learn those consumers exist. It already publishes nothing and knows nobody;
the event bus is what makes §46 possible **without** ReceiptIQ gaining a dependency.

---

## 4. Genuinely missing

Ordered by value-to-risk, not by directive numbering.

**High value, low risk — build first**

1. **Platform event envelope + `EventBus` port** (§4, §5, §48) — with an in-memory adapter.
   Generalise Prime's `EventLog`; do not duplicate it.
2. **Correlation / causation ids** (§6) — threaded through contracts. Cheap now, near-impossible to
   retrofit once workflows span engines.
3. **Tenant context contract** (§16) — reconciles `orgId` / `tenantId` / `ownerRef` into one
   vocabulary that respects the ownership model.
4. **Commands vs events split** (§11) — Prime issues commands, engines publish events.
5. **First five domain events** (§Phase 4) — `manufacturing.plan.generated`,
   `cost.calculation.completed`, `receipt.ingested`, `receipt.normalized`,
   `material.purchase.detected`.

**High value, moderate risk**

6. `WorkflowStateStore` port + durable Prime workflows (§21, §22)
7. Job / queue abstraction (§18, §19) with an in-process adapter
8. Idempotent consumers + processed-event ledger (§8)
9. Dead-letter handling (§9)
10. Structured logging + metrics ports (§29–31)

**Real, but not yet**

11. Outbox (§10) — needs a host with a transactional database; ProWorks is the candidate
12. Circuit breakers, bulkheads, rate limits (§25–27) — need network calls to protect
13. Gateway, identity service, notifications, webhooks, artifacts, cache, feature flags
    (§15, §17, §34–39) — each needs a real caller first
14. Distributed tracing (§32) — meaningful once services are separate processes
15. Knowledge-graph seam (§45) — ReceiptIQ's canonical items and merchant/SKU mappings are already
    graph-shaped; leave as contracts

---

## 5. Immediate risks

| Risk | Why it matters |
|---|---|
| **Tenancy vocabulary divergence** | Three engines, three words. Every day this persists, more code is written against the wrong one |
| **No correlation id** | Retrofitting through published contracts means a breaking version bump per engine. Cheapest it will ever be is now |
| ~~Prime's purity is undefended~~ | **CLOSED 2026-08-27.** Two guards now refuse I/O imports and ambient globals across Prime, CostIQ and ReceiptIQ |
| **Two routing implementations** | Documented today, but nothing *enforces* that eligibility stays in Prime and capacity stays in the Hub |
| **Event vocabulary uncoordinated** | Prime's `WorkOrderEventType` is work-order-scoped. Platform events need a namespace that will not collide |

---

## 6. Proposed sequence

Each step ends green — typecheck, 609 suite tests, and both hosts still building.

| Phase | Work | Ends when |
|---|---|---|
| ~~1~~ | ~~*This document*~~ | **done** |
| ~~2~~ | ~~Guard the pure engines: no I/O imports, no ambient globals~~ | **done** — 2 guards, 6 injections verified, 611 tests |
| **3** | Tenant context contract; reconcile `orgId`/`tenantId`/`ownerRef` | One vocabulary, ownership model intact |
| **4** | Correlation/causation on contracts, additive | Both hosts unaffected |
| **5** | `PlatformEvent` envelope + `EventBus` port + in-memory adapter | Publish/subscribe tested |
| **6** | Commands vs events; first five domain events | ForgeIQ/CostIQ/ReceiptIQ publish; nobody imports a consumer |
| **7** | Processed-event ledger + idempotent consumers + DLQ | Duplicate delivery proven harmless |
| **8** | `WorkflowStateStore` port; durable Prime workflows | Prime restart resumes; Prime still pure |
| **9** | Job/queue abstraction, in-process adapter | Long work off the request path |
| **10** | Observability ports — structured logging, metrics | Correlation id visible end to end |
| **11** | Contract tests Prime ↔ engines; failure tests | Breaking changes caught pre-integration |
| **12** | Read models across engines | One query per screen |

**Phases 2–4 are the ones that get harder every day.** Everything after can wait for a caller.

---

## 7. What this analysis does not recommend

- Splitting Prime (§3) — agreed, and it is already modular internally
- Building the gateway before a second deployment topology exists
- Restructuring the repository
- Adding tenant ids to canonical knowledge
- New engines (§59) — agreed
- Distributed infrastructure while a modular monolith serves both hosts correctly (§49)
