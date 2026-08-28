# Engine Control Center — architecture

Owner: Steven Kreutzer · 2026-08-27
Package: `@proworks-hub/control-plane`

---

## What was found before anything was built

Per §26, the three repositories were inspected first.

**Reusable, and reused rather than reinvented:**

| Needed | Already existed | Used as |
|---|---|---|
| Event envelope | `contracts/events.ts` — `PlatformEvent`, `eventTypeMatches`, `EventBus` port | The telemetry the console reads. No second event shape. |
| Structured logs, metrics, audit | `contracts/observability.ts` — `Logger`, `Metrics`, `AuditEntry`, `METRIC_NAMES` | The console produces `AuditEntry`-shaped records; it does not own an audit system. |
| Circuit breakers | `platform-runtime/resilienceRuntime.ts` | An open circuit is the input to the `degraded` state. |
| Ownership model | `contracts/tenancy.ts` — `assertNoIdentityFields` | The global-knowledge promotion gate calls exactly this function. |
| Capability names | `contracts/capabilities.ts` | Listed on manifests for the entitlement view. |
| Package conventions | 13 packages, workspaces, project references, portability guards | Followed exactly; the guards were extended, not exempted. |

**Existed under another name:** ProWorks Hub already has a full **platform administration** module — `src/modules/platform-admin/`, 20 pages including `PlatformSystemHealthPage`, mounted at `/platform`. That is layer 2 of the directive's three layers, and it was left alone.

**Did not exist:** any engine manifest, health/status model, engine registry, or console authorization. Engines expose no `/health` endpoint and publish no heartbeat. Nothing named `EngineManifest` appears anywhere in the three repos.

### One finding worth stating plainly

`prowork-hub/src/core/admin/access.tsx`:

```ts
const isPlatformAdmin = role === "owner" || hasPlatformPermission(rawPermissions);
```

`role` comes from `/api/team/my-permissions` — it is the caller's role **in their own shop**. `ShopRole` is `'owner' | 'admin' | 'worker'`. So **every shop owner on the platform currently satisfies the platform-admin guard.**

Whatever that means for platform administration — it is the host's decision and was not changed here — it is precisely what §1 forbids for engine administration: *"Never available because someone owns a shop."*

It is the reason engine console access is a separate list of named people rather than anything derived, and the reason `access.ts` has a test that reads its own source.

---

## Where it lives, and why

**Portable core → `packages/control-plane` in the engine suite.**
Manifests, health derivation, console authorization, hive topology, the telemetry-to-visualization adapter, and the AI/intelligence model. Pure TypeScript and zod; React is an **optional** peer used only by `./react`.

**The application shell → ProWorks Hub**, mounted separately from `/platform`, gated by its own authority. Not built in this pass; see *Remaining work*.

Three properties this arrangement buys:

1. **The console is optional.** A portability guard fails the build if any engine imports `@proworks-hub/control-plane`, or declares it as a dependency. §17's hard requirement — *if the console is offline, every engine keeps working* — is therefore enforced by CI rather than by intention.
2. **The rules are testable without a browser.** Authorization, health thresholds, layout and event mapping are pure functions. 119 tests, no DOM.
3. **A future dedicated console gets the same core.** If the shell should later be its own application, nothing in this package changes.

---

## The three layers

| Layer | Authority | Who |
|---|---|---|
| **Customer / shop administration** | The tenant's own roles and permissions | Shop owners, their staff |
| **Platform administration** | `platform.read` / `platform.manage` | Tenant support, platform operations |
| **Engine administration** | An explicit `EngineConsoleGrant` naming a person | Named internal engineers |

Engine access is never inferred. Not from a role, not from a tier, not from ownership of anything.

### How that is enforced

`access.ts` **has nothing to be careless with**. It does not import `@proworks-hub/contracts`. It contains no `TenantContext`, no `organizationId`, no `shopId`, no capability lookup. `engineConsoleGrantSchema` is `.strict()`, so a grant carrying `organizationId` is *refused*, not ignored.

A test reads the module's own source and fails if any of those words appear outside a comment. It was verified by adding a violation and watching it fail.

---

## Role model

| Role | Holds |
|---|---|
| **Owner** | Everything, including granting access |
| **Engineer** | Diagnostics, sandbox testing, development configuration, intelligence, audit |
| **Operations** | Monitoring, safe operational controls, read-only configuration |
| **Support** | Read-only diagnostics — *and no intelligence access* |
| **Auditor** | History and configuration, nothing live |

Roles are written out per role rather than layered. An inheritance chain is shorter but much easier to widen by accident, and a permission arriving on `support` because it belonged on `engineer` is invisible in a diff.

Four permissions belong to the owner alone, asserted by name in a test: `engine.data.clear`, `engine.migration.run`, `engine.rollback`, `engine.intelligence.promote`.

Sandbox and production testing are **separate permissions**. An engineer has one and not the other.

---

## Production safety

`authorizeDangerousOperation()` checks everything and **returns the audit record**. The caller cannot perform the operation without holding the thing that has to be written down — a separate `audit()` call is the one somebody forgets in the error path, which is the path that matters.

Refused unless all of:

- the caller holds the operation's permission;
- a reason of at least 10 characters — a field that accepts `"x"` is decoration, and this is read months later by whoever is asking why production changed;
- the target's name typed back, for the operations that destroy something;
- a re-authentication within 5 minutes, and **not one timestamped in the future** — otherwise clock skew buys an indefinite elevation.

`engine.access.revoke` is deliberately the one destructive-sounding operation that needs no re-authentication. During an incident, locking someone out quickly matters more than being certain. It is still audited.

---

## Engine manifest specification

```ts
EngineManifest {
  manifestVersion, id, name, description
  kind: "engine" | "service" | "intelligence"
  packageName?
  colorToken, icon
  visualizationType, visualizationConfig, hivePlacement: "core" | "ring"
  capabilities[], metrics[], supportedAdminPanels[], eventMappings[]
}
```

`id` **must equal** the `source.service` the engine puts on its events. That equality is the entire wiring: telemetry finds its scene by name.

`kind` is load-bearing. Tracking and notifications were deliberately not made engines; the console counts `kind: "engine"` and nothing else, so *"8 of 8 engines online"* means engines. `intelligence` exists so the AI layer gets its own section without inflating that count.

`colorToken` is a palette name, never a hex value — otherwise a theme change becomes a manifest edit.

### Forward and backward compatibility

`parseEngineManifest()` treats two cases differently on purpose:

- **Higher `manifestVersion`** → unknown fields are dropped and reported in `droppedFields`. One upgraded engine must not blank the dashboard, including the seven engines that are fine.
- **Current version, unknown field** → *rejected*. It is a typo, and accepting it leaves `colourToken` spelt wrong and silently ignored while somebody wonders why that engine renders grey.

A malformed manifest becomes a `registry.problems` entry. The other engines still render — the reason to open the console is that something is wrong.

---

## Telemetry and event integration

```
PlatformEvent  →  VisualizationAdapter  →  EngineVisualizationEvent  →  scene
                  (manifest eventMappings)
```

**No UI fields were added to any domain contract.** An `intensity` field on `manufacturing.plan.generated` would make an animation's brightness part of a contract ForgeIQ, CostIQ and three projections all have to honour. The mapping lives in console metadata.

The adapter:

- **never throws** — a console that dies on a malformed event goes blank during the incident that produced it;
- **returns null for unmapped events** — no event, no motion, and no invented motion either;
- **carries no payload** — a console that renders payloads into a scene has put customer data on a wallboard. Payload inspection is a deliberate, permissioned click in the trace view;
- **prefers exact over prefix over wildcard** — otherwise an audit-style `*` mapping silently outranks the specific mapping somebody wrote.

`createVisualizationBudget()` caps effects per engine per second, counts what it dropped, and **never drops an `alert`**. Sampling throughput is fine; an alert dropped for a graphics card is a failure the operator was not shown.

---

## Health, and why `unknown` exists

The directive lists six states. There are seven.

**Silence is not health.** An engine the console has heard nothing from — or whose heartbeat is stale, or whose timestamp will not parse — is `unknown`, never `operational`. A dashboard that renders green because no telemetry arrived is worse than no dashboard: it is actively reassuring during the exact incident it was built for.

Other decisions in `deriveEngineHealth`:

- Maintenance beats everything. A planned outage should page nobody.
- Staleness beats the metrics. Numbers from an engine that stopped reporting describe a moment that has passed.
- **An open circuit is `degraded` regardless of failure rate** — the rate looks healthy precisely because the engine stopped calling the dependency.
- Rates need a denominator. Below 20 jobs, two failures out of two is not a 100% failure rate worth colouring a dashboard with.
- Every state carries a `reason` in numbers. *"Degraded"* alone sends someone digging through logs to find what the console already knew.

`summariseFleet()` reports the **worst** engine, never an average. Averaging is how seven healthy engines hide one that is on fire, and "87% healthy" is a number nobody can act on.

---

## Visualization architecture

```
core/topology.ts     positions + edges, computed, no DOM
react/motion.tsx     paused / reducedMotion
react/activity.tsx   one subscription, pulses + counts
react/EngineVisual   manifest → scene, no per-engine branching
react/scenes/*       the artwork
```

**Positions are computed, never authored.** Hand-placed coordinates turn a ninth engine into a layout ticket, and then it lands in whichever gap looked empty. `computeHiveLayout` spaces the ring evenly for any count; a test runs it for 1, 3, 6, 7 and 12.

**Edges are the manifests' own event mappings.** The diagram cannot claim a connection the system does not have — the failure every hand-drawn architecture diagram eventually develops. Mappings pointing at an engine that is not deployed are reported as `danglingEdges` rather than drawn.

Animation is CSS keyframes, not a library and not a per-card `requestAnimationFrame`. Compositor-driven transforms keep running while the main thread is busy — which on this console is exactly when the picture most needs to stay readable — and `animation-play-state: paused` freezes every scene in the same frame with no state to reconcile.

### Accessibility (§9)

**Pause** freezes scenes where they are *and clears every pulse in flight*, so it feels immediate rather than gradual.

**Reduced motion** removes animation rather than pausing it — a paused animation leaves an element wherever its keyframes had put it, and that is not a design. It is read live via `matchMedia` with a listener, so turning it on mid-incident does not need a reload, and it wins over pause in either order.

Information is never sacrificed for it. Counts are kept whether or not pulses are drawn, and scenes render a static arc proportional to recent throughput in place of movement.

**Colour is never the only signal.** Every state carries a distinct label *and* a distinct icon; states demanding attention get a ring as well as a fill. Tests assert that labels and icons are unique across states.

Failure **slows towards stillness** rather than flashing. The red marker and the word "Failed" already did the alarming; the operator now needs to think.

---

## AI / Intelligence

Two things the console shows together and keeps separate internally.

**Model operations.** `estimateModelCost` returns `estimated: true` and `pricingAsOf` **structurally**, so no caller can render the number without the caveat being available. An unpriced model returns `cents: null`, **not zero** — zero renders as `$0.00`, reads as a measurement, and quietly reports that a local model is free. A price table older than 45 days is flagged stale.

**Learned knowledge.** `summariseDecisions` excludes unreviewed decisions from the denominator; treating "nobody looked" as "nobody objected" is how a model reports 99% accuracy on a queue nobody reviews.

`assessPromotion` is the gate between one shop and everybody (§12). Four independent conditions, all reported at once:

1. **No identifying fields** — checked with `assertNoIdentityFields`, the same function the shared-knowledge layer uses, so the rule cannot drift between the two places it matters.
2. **Three distinct tenants** — one shop agreeing with itself a thousand times is one shop. This is the actual §12 failure: an engine notices one shop always offsets a cut because their machine is worn, and teaches every other shop to do the same.
3. **Twenty observations** — three tenants who each saw it once is a coincidence.
4. **Complete provenance** — a promotion that cannot say where it came from cannot be reversed.

It **assesses and never promotes**. Promotion is a dangerous operation requiring the owner role, a reason and a re-authentication.

---

## How to add a new engine to the console

1. Add a manifest to `packages/control-plane/src/manifests/index.ts`. `id` must equal the engine's `source.service`.
2. Add its `colorToken` to `ENGINE_PALETTE` in `react/palette.ts`.
3. Append it to `SUITE_MANIFESTS`. Array order is display order.

That is the whole list. It renders on the dashboard, joins the hive ring at a recomputed position, appears in filters, and gets its detail tabs from `supportedAdminPanels`. Miss step 2 and it renders neutral grey; miss the artwork and it gets the generic hexagon. Neither blanks a card.

## How to add or update artwork

Scenes take `EngineSceneProps` and nothing else — they read no metrics, fetch nothing, and decide nothing. Add a component, register it in `SCENE_REGISTRY` under a `visualizationType`, and point a manifest at it.

Rules a scene must keep: draw into 200×120; take colour from `var(--engine-base)` / `--engine-dim` / `--engine-bright`; prefix every `<defs>` id with `props.uid` (**SVG ids are document-global** — eight cards each defining `#glow` all resolve to whichever rendered last); and route every animation through `motionStyle(props.motion, …)` so pause and reduced motion work without the scene thinking about them.

## How to add an event animation

Add an `eventMapping` to the manifest — event type, one of four effects, an intensity, optionally a `to` for a hive packet and a `visualHint` the scene can read. No component changes. Point it at an engine that exists; a test enforces that.

---

## Tests

119 in this package, plus two extended portability guards. Both new guards were verified by injecting the violation they claim to catch and confirming failure.

- **RBAC boundaries** — every role's permissions, the four owner-only ones by name, no-grant refusal, expiry, unparseable expiry treated as expired
- **Customer accounts cannot reach engine administration** — grant list, `.strict()` refusal of a tenant field, and a source-reading guard on the module itself
- **Dangerous operations** — permission, reason quality, target confirmation, elevation, future-dated elevation, audit content
- **Manifests** — defaults, typo refusal, forward tolerance, junk input
- **Registry** — one bad manifest does not blank the rest, duplicate ids, engine counting
- **Topology** — even spacing for any count, reproducible start, declared edges only, dangling edges
- **Health** — silence, staleness, unreadable timestamps, thresholds, sample size, open circuits, maintenance precedence, worst-not-average
- **Accessibility** — unique labels and icons per state, failure slows rather than flashes
- **Telemetry adapter** — malformed input of twelve shapes, no payload leakage, mapping specificity, budget, alerts never dropped
- **Reduced motion** — removal vs pause, precedence
- **Unknown / future manifests** — dropped fields reported, generic scene, neutral palette
- **Console optional** — no engine may import or depend on this package

Not covered: React component rendering. The visual layer's *decisions* are pure and tested; its pixels are not, and would need jsdom and testing-library, which the suite does not carry.

---

## Remaining work

**Phase 1 remainder — the application shell.** The core is complete and published-ready; the ProWorks Hub shell is not built. It needs: a route tree outside `/platform` and outside the navigation registry, a server-side grant store, an authorization endpoint that reads *only* that store, and the dashboard/detail pages composing `EngineVisual`, `HiveBoard` and `EngineStatusBadge`. **It is blocked on publishing `@proworks-hub/control-plane`** — the Hub consumes suite packages from GitHub Packages at `^0.9.0`, and coupling the repos by filesystem path is prohibited.

**Phase 1 remainder — heartbeats.** No engine currently reports one. `deriveEngineHealth` correctly returns `unknown` for all of them, which is honest but not useful. Each engine needs to emit an `EngineHeartbeat`, or the host needs to derive one from the metrics it already collects.

**Phase 2** — real telemetry transport, distributed tracing by correlation id in the trace view, alerting.

**Phase 3** — intelligence panels over `EngineDecision`, the test harness with its sandbox boundary, per-engine configuration editors, knowledge provenance browsing.
