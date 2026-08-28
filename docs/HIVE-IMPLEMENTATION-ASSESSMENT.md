# ProWorks Hive — implementation assessment

Owner: Steven Kreutzer · 2026-08-27
Per STEP 0: audit before code.

---

## What changed since the directive was written

The directive cites **1,175 tests**. The suite is now at **1,239** — the brand/motion/health-score
work landed after the directive was drafted, and it already covers several things listed as missing:

- `core/brand.ts` — Hive naming, the colour layer above the engine hues, typography (PART 3, PART 18)
- `core/motionLanguage.ts` — the board's three visual states (PART 19)
- `core/systemHealth.ts` — the headline score, as a **minimum** rather than a mean (PART 20)
- `navLabel()` derives "Engine"/"Service" from `kind`, so the UI cannot call a service an engine

---

## Already complete — do not rebuild

| Directive part | Status |
|---|---|
| Engine manifests, registry, forward compatibility | Complete |
| Health derivation, seven states, worst-not-average | Complete |
| Hive topology, computed positions, derived edges (PART 9 Flow) | Complete |
| Console RBAC + dangerous-operation authorization (PART 2 *model*) | Complete |
| Telemetry→visualization adapter, budget, alerts-never-dropped (PART 8) | Complete |
| `EngineVisual`, `HiveBoard`, nine scenes, palette (PART 4, PART 18) | Complete |
| Motion / reduced-motion / pause (PART 19) | Complete |
| Global-knowledge promotion safeguards (PART 15 *model*) | Complete |
| Model spend, estimated-cost honesty (PART 14 *model*) | Complete |
| Portability enforcement — no engine may import the console (PART 23) | Complete |

## Added in this pass

| Part | What was missing | Built |
|---|---|---|
| **6 Heartbeats** | Nothing produced an `EngineHeartbeat`; every engine read `unknown` | `core/heartbeat.ts` |
| **5 Real states** | No operational-state layer; states were health only | `core/operationalState.ts` + 40 activity annotations across the manifests |
| **12 Alerting** | None | `core/alerts.ts` |
| **10 Trace + redaction** | None | `core/tracing.ts` |

## Genuinely still missing

Everything in ProWorks Hub — PARTs 1, 4, 9, 11, 14 (UI), 15 (UI), 16, 17, 20 — plus PART 7's
transport endpoint and PART 13's AI runtime packages.

---

## The blocker, stated plainly

**PART 26 step 2 is not optional, and it needs a decision only Steven can make.**

- ProWorks Hub consumes `@proworks-hub/*` from **GitHub Packages**, currently at **0.9.0** installed.
- The suite is at **0.13.0**, and `control-plane` has **never been published**.
- Standing rule: repositories must not be coupled by filesystem path.
- Standing rule: the console's role model must not be duplicated into the host.

So the Hive shell cannot import the model it must enforce until `@proworks-hub/control-plane` is
published and the Hub's versions are bumped. Publishing is an outward-facing action requiring a
registry token, so it waits for authorization.

Everything built in this pass was chosen because it is **upstream of that blocker** — and because
the directive's own instruction applies: *do not build the flashy parts before real data can drive
them.*

---

## Where the Hive server actually goes — a finding

The directive assumes a ProWorks server exists to host Hive authorization. It does, but not where it
looks:

- `prowork-hub/hub-server` is an **Express 4 + SQLite local hub node** — pairing, stations, tablets,
  PC clients, sync. It listens on **4100**.
- `vite.config.ts` proxies `/api` → `http://localhost:4100`, so **hub-server is the API for the web
  app**.
- `/api/team/my-permissions` — which the whole client RBAC reads from — **is not implemented
  anywhere in the repository.** The client falls back to a dev-session role.

That last point matters for PART 2: Hive authorization would be among the first real permission
endpoints this server has. It also means the existing client RBAC is currently unbacked, which is
worth knowing before anything is built on top of it.

`hub-server` has a migration runner (`hub-server/src/migrations/`, ten SQL files) and declares **no**
suite dependencies today. It is the right home for the Hive grant store.

---

## Baseline before work (PART 25)

`npx tsc --noEmit -p tsconfig.json` in `prowork-hub`:

**85 errors across 22 files, every one under `src/modules/connectors/`.** Missing modules
(`core/sourceAdapter`, `core/importPipeline`, `core/connectorRegistry`, `models/normalizedFormats`,
`core/savedMappingsService`, `models/savedMapping`) and implicit-`any` parameters in
`useImportWizard.ts`.

Self-contained, unrelated to Hive, and easy to distinguish: any new failure outside
`src/modules/connectors/` is attributable to this work. Nothing in ProWorks Hub was modified in this
pass, so the baseline is unchanged.

---

## Two findings worth acting on

**The shared identity list does not cover customer payloads.** `IDENTITY_FIELD_WORDS` in the
contracts was written to keep *canonical* records anonymous — and a canonical record is about a
product or a price, so it never had cause to name a customer. It has no entry for `customerName`.
Reusing it for console payload redaction left customer names visible; it is now the **floor**, with
`CONSOLE_SENSITIVE_WORDS` layered on top in `tracing.ts`. The shared contract was deliberately not
widened — that would change what every engine is allowed to store, to fix a console problem.

**A derived heartbeat cannot tell idle from stopped.** An engine that publishes events is
demonstrably alive, but an idle engine publishes nothing and so does a dead one. `heartbeatCaveat()`
makes the console say which kind of not-knowing it has, because an operator who reads "No telemetry"
on a healthy-but-quiet engine learns to ignore the state that matters most.

---

## Recommended next order

1. **Publish `@proworks-hub/control-plane`** and bump the Hub. Unblocks everything below.
2. Hive grant store in `hub-server` — migration, repository, resolver, audit.
3. Hive route boundary + shell, outside `/platform` and outside the nav registry.
4. SSE transport (PART 7) — the Hub already runs Express; SSE fits it and survives proxies.
5. Grid and Flow views over the existing topology and adapter.
6. AI foundation packages (PART 13) — independent of the blocker, and a large piece of work in its
   own right.
