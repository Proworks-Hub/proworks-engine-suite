# VisionIQ — cross-repository audit

Owner: Steven Kreutzer · 2026-08-27
**Audit only. No code written, nothing moved, nothing deleted** — per §49 and addendum §1.

> **Revision.** My first pass concluded Prep Studio was unreachable and that KSix held all the
> preparation intelligence. Both were wrong. Steven pointed me at
> `C:\Users\ksixd\InvoFlowHub\src\modules\ksix-prep-studio` — **330 files, 58,535 lines** — and the
> conclusion inverts. It is recorded here rather than quietly replaced, because the corrected
> finding changes what VisionIQ *is*.

---

## Headline: VisionIQ substantially exists

Prep Studio is not a UI with some helpers behind it. It is a mature engine with a UI on top, and it
already contains most of what the directive describes as VisionIQ:

| Already built | Where | Lines |
|---|---|---|
| Recipe engine + **recipe operating system** | `core/recipeEngine.ts`, `core/recipeOperatingSystem.ts` | 851 |
| Profile engine | `core/profileEngine.ts` | 321 |
| Shared prep engine (+ tests) | `core/sharedPrepEngine.ts` | 247 |
| Preflight engine | `core/preflightEngine.ts` | 159 |
| Issue taxonomy + quick-fix registry | `core/intelligence/` | 658 |
| **Process capabilities, already decomposed** | `modules/laser-prep` (35 files), `dtf-prep` (20), `sublimation-prep` (14) | — |
| AI abstraction with governance + sanitizers | `ai/` | 1,768 |
| **Photoshop gateway** | `photoshop-tools/` | 1,962 |
| Inbound adapter + migration tests | `adapters/` | 888 |
| Halftone, vector prep, spot channels, machine presets | `lib/` | 9,641 |

**The task is extraction and portability, not construction.**

Two things sharpen that further.

**The intended decomposition is already sketched — and empty.** `artwork-analysis/`,
`color-separations/`, `image-prep/`, `output-engineering/`, `recipes/`, `studio-session/` are all
two-line placeholders: *"Scaffolding entrypoint for the X bounded context."* Someone had precisely
VisionIQ's structure in mind and never filled it, so the real code sits undecomposed in `lib/`.

**The core is already portable.** Measured, not assumed:

| Area | Files touching DOM or React |
|---|---|
| `core/` | **0 / 16** |
| `adapters/` | **0 / 2** |
| `lib/` | 8 / 36 |
| `modules/laser-prep` | 11 / 35 |
| `modules/dtf-prep` | 5 / 20 |
| `modules/sublimation-prep` | 4 / 14 |
| `ai/` | 5 / 18 |

The engine kernel — recipes, profiles, preflight, intelligence — has **no browser dependency at
all.** In every other area the DOM-touching files are the minority. And the host imports are
overwhelmingly UI: `@/components/ui/button` (58), `badge` (37), `select` (28), `card` (27), plus
`useTenantWorkspace`, `use-auth`, `use-toast`. Those are the UI layer, which is exactly what the
addendum says stays in the host.

---

## The two versions

| | Files | Lines | What it is |
|---|---|---|---|
| `src/modules/ksix-prep-studio` | 330 | 58,535 | **The engine + its application** |
| `src/modules/prep-studio` | 26 | 1,447 | **The integration layer** — adapters, zod contracts, migrations, workflow resolution, launch cards, `PrepResult` |

They are not competing implementations. `prep-studio` is the *host bridge* — and it already holds
`lib/contracts/{zod,migrations,audit,dualDelivery}.ts` plus `types/PrepResult.ts`, the same contract
ProWorks consumes through fourteen `prep-bridge` components.

**`PrepResult` is at schema version 2 and carries `recipeUsed`, `recipeRequested`,
`recipeMigrationFrom`.** Recipes are already first-class *and have already survived one migration*.
VisionIQ's output must reconcile with this contract, not replace it.

Other copies exist (`InvoFlowHub-ExactParity`, two under `Downloads`). **Treat
`C:\Users\ksixd\InvoFlowHub` as authoritative** unless told otherwise; the others need a diff before
anyone reads them.

---

## Migration matrix

| Capability | Current location | Target |
|---|---|---|
| Recipe engine, recipe OS | `ksix-prep-studio/core` | **VisionIQ core** — already portable |
| Profile engine | `ksix-prep-studio/core` | **VisionIQ core** — already portable |
| Preflight, issue taxonomy, quick-fix registry | `ksix-prep-studio/core/intelligence` | **VisionIQ core** — already portable |
| Halftone, vector prep, spot channel, accent layer | `ksix-prep-studio/lib` | **VisionIQ core**, after the DOM split |
| Machine presets / template engine | `lib/machinePresets.ts` **and** `lib/canvas-ops/machinePresets.ts` | **VisionIQ profiles** — consolidate, they are duplicated |
| Laser / DTF / sublimation prep | `ksix-prep-studio/modules/*` | **VisionIQ process capabilities** |
| AI decision tree, governance, sanitizers | `ksix-prep-studio/ai` | **VisionIQ**, behind the provider port (§35). `ai/legacy/` duplicates the current tree — resolve first |
| Photoshop gateway, pack executor | `ksix-prep-studio/photoshop-tools` | **VisionIQ adapter** — optional, never a dependency |
| `PrepResult`, zod contracts, migrations | `prep-studio/lib/contracts` | **Contracts package** |
| Inbound adapter, prep result sink | `ksix-prep-studio/adapters` | **Host adapter** |
| Canvas ops, `canvasProcessing`, `dualDelivery` | `lib/canvas-ops` | **Split**: algorithm → core, canvas → adapter |
| Components, pages, shell, studio, tabs | `ksix-prep-studio/{components,pages,shell,studio,tabs}` | **Keep as host UI** (~28k lines) |
| KSix `laserExport`/`printExport`/`smartBgRemoval` | KSix `client/src/lib` | **Compare against `modules/laser-prep` first** — likely superseded |
| ProWorks `prep-bridge` (14 components) | ProWorks | **Do not touch** |
| ForgeIQ `imageResolutionRule` | Suite | **Do not move** — extract the DPI primitive only |

---

## Duplication found — resolved

**1. `machinePresets.ts` exists twice — and one copy is dead.**

| | Consumers | Key vocabulary |
|---|---|---|
| `lib/machinePresets.ts` | **11 files** | `"DTF"`, `"LASER_ENGRAVING"` — uppercase |
| `lib/canvas-ops/machinePresets.ts` | **0 files** | `'dtf'`, `'laser'`, `'laser_engrave'` — lowercase |

Not merely duplicated: the two use **incompatible key conventions**, and the orphan has a `'laser'`
key the live one does not. Its apparently-unique exports (`KSIX_PALETTE`, `BACKGROUND_REMOVAL_PRESETS`)
resolve from elsewhere — `KSIX_PALETTE` comes from `@ksix/lib/ksixPalette`.

**Verdict: `lib/machinePresets.ts` is authoritative.** `canvas-ops/machinePresets.ts` is an
unadopted fork. Extract the former; leave the latter for the host to delete.

**2. `ai/legacy/` is not dead — it is a live divergence.**

Two files still import it: `components/ai/AiResultPanel.tsx` (type-only) and, more seriously,
`pages/CanvasStudio.tsx`, which calls `runAiPrepFlow` from `legacy/` (75 lines) while the rest of the
application uses the current one (213 lines).

**One page is running an older decision tree.** That is a host bug, not an extraction problem.

**Verdict: `ai/` is authoritative.** Extract it; flag `CanvasStudio.tsx` to the host as unmigrated.

**3. `PrepResult` exists three times — and they have not drifted.**

`ksix-prep-studio/types/PrepResult.ts` is canonical; `prep-studio/types/PrepResult.ts` is a
self-described deprecated shim re-exporting it; ProWorks holds an independent copy. Compared field
by field, **the canonical definition and ProWorks' copy are identical** — no drift, across separate
repositories with no shared package. That is the argument for promoting it rather than redesigning.
3. **KSix `laserExport.ts` vs `modules/laser-prep` (35 files)** — near-certain overlap. KSix's is
   253 lines; Prep Studio's is an order of magnitude larger. The directive says compare
   capability-by-capability rather than taking the newest, and this is the pair that needs it.
4. **ForgeIQ `imageResolutionRule` vs any Prep Studio DPI check** — the shared primitive.

---

## Missing everywhere

**The learning loop.** No repository has a difference operator (§23), operator-correction capture
(§21), external-edit comparison (§22), feedback records (§27), or scoped learning (§26). The
`photoshop-tools` gateway is the closest thing and it pushes work *out*, not observations *back*.

This is the genuinely new construction, and it is smaller than the extraction.

---

## Migration order

1. Read `core/prepStudioArchitecture.ts` and `printPrepArchitecture.ts` first — 159 lines that state
   the existing design in its authors' own words
2. Diff `InvoFlowHub` against `InvoFlowHub-ExactParity` to confirm which is authoritative
3. Resolve the three internal duplications before moving anything
4. Lift `core/` **as-is** into `packages/visioniq` — it is already portable, and this proves the
   package boundary with zero algorithmic risk
5. `PrepResult` + zod contracts into `contracts`, reconciled with `ProductionAssetManifest`
6. Effective-DPI primitive; ForgeIQ consumes it
7. `PixelBuffer` seam, then `lib/` algorithms area by area
8. Process capabilities: laser first (largest, best developed), then DTF
9. Compare KSix's `laserExport` against `modules/laser-prep`; retire the loser
10. Learning loop — difference operator, feedback, scoped observations
11. Hosts consume VisionIQ; delete duplicates **only after** the §26 comparison passes

---

## Risks and open questions

**Prep Studio is a separate deployable.** It lives in `InvoFlowHub`, not in the three repos I have
been working in, and ProWorks stubs it as an add-on. Extracting into
`@proworks-hub/visioniq` means Prep Studio itself must then consume the engine it currently owns —
a bigger change than adding a package to ProWorks.

**58k lines is a lot of behaviour to preserve**, and §26 requires proving old output matches new.
There are existing tests (`sharedPrepEngine.test.ts`, `exportFinalPrep.test.ts`, adapter migration
tests) — a genuine starting point, and I have not yet run them.

**Questions:**

1. **Is `C:\Users\ksixd\InvoFlowHub` the live one?** `InvoFlowHub-ExactParity` and two `Downloads`
   copies exist. Extracting from a stale tree would be expensive to unwind.
2. **Is InvoFlowHub a git repository with a remote?** It is not one of the three I have been pushing
   to, and I will not push anything there without being told where.
3. **Does Prep Studio still ship as a KSix add-on**, or is it becoming a ProWorks/MakerOps module?
   It changes who consumes the extracted engine first.
4. **Sample assets for §26** — a real photo plus its known-good slate output.

---

---

## Extraction pass 1 — done

`packages/visioniq` exists. **Seven files, ~1,530 lines, plus the host's own two test files, moved
without behavioural change.**

| Extracted | Lines |
|---|---|
| `types.ts`, `sharedChecks.ts` | 112 |
| `profileEngine.ts` | 355 |
| `colorEngine.ts` | 95 |
| `recipeEngine.ts` | 508 |
| `preflightEngine.ts` | 185 |
| `sharedPrepEngine.ts` | 275 |
| `__tests__/{recipeEngine,sharedPrepEngine}.test.ts` | — |

Chosen because they are the only core files with **zero dependencies outside `core/`**. Import paths
were rewritten (bundler alias → relative ESM with `.js`); the logic is untouched.

**The host's own 9 tests pass unchanged against the extracted code.** That is core parity for what
they cover.

### The one seam extraction required

The portability guard rejected `recipeEngine.ts`: it reached for `window.localStorage` to persist
operator recipe variants. Ambient I/O — a licensee running VisionIQ in a Node service has no window.

It is now a port, `RecipeVariantStore`, with `setRecipeVariantStore()`.

My first attempt kept a `globalThis.localStorage` default "to preserve behaviour", and **the guard
rejected that too — correctly.** Reaching for ambient storage is the thing being forbidden, whatever
it is guarded by. The browser default belongs in a host adapter.

**Hosts must inject to keep persistence:** `setRecipeVariantStore(window.localStorage)`. Without one,
variants last the session — already the behaviour outside a browser, so no existing path regressed.

### Not done, deliberately

Nothing deleted. Prep Studio is untouched and still owns this code; the extracted copy has no
consumer yet. `recipeOperatingSystem.ts` and `intelligence/` stayed behind — they import
`@ksix/lib/*`, `@/modules/machines/*` and `@workspace/api-client-react`, and belong in a later pass.

That last one is trivial when it comes: `import type { Job }` in all four intelligence files is
**type-only**, so it erases. Replacing it with a local structural type is the whole job.

## Extraction pass 2 — contracts

`PrepResult` promoted into `@proworks-hub/contracts` with zod validation, plus the bridge to
`ProductionAssetManifest`. 13 tests.

**They are complementary, and merging them would lose something.** A `PrepResult` is the OUTCOME of
preparing one asset — readiness, issues, recommendations, which recipe ran. A manifest is the SET of
files reaching machines and what each is for. `prepResultToProductionAsset` bridges them.

Three decisions worth recording:

- **`source` became an open string.** The original union named the two Studios by name; a closed
  list would make the contract refuse the third-party licensee VisionIQ is being extracted for.
- **`machineClass` is supplied by the caller**, never parsed from `machinePreset`. A preset is a
  host's label, and inferring a machine class from it is filename-sniffing wearing a different hat.
- **A critical issue blocks regardless of score.** A high score beside a critical issue means the
  scorer and the checker disagree, and the safe reading of a disagreement is the pessimistic one.

## Extraction pass 3 — machines and recipes

Four files, ~1,290 lines: `machinePresets`, `machineTargeting`, `machineTemplateEngine`,
`recipeOperatingSystem`. **`packages/visioniq` now holds ~3,010 lines with zero host imports.**

Steps 3 and 4 of the order (preflight, profile resolution) were already satisfied — both engines
came across in pass 1 as part of the dependency-clean set.

### The finding: an API schema owned the domain vocabulary

Every external import in this layer was `import type`, so all of it erased at runtime — the
extraction was type substitution, not rewriting.

But *what* they imported matters. `BackgroundSettings`, `CleanupSettings`, `ColorSettings`,
`HalftoneSettings`, `VectorSettings` and `ExportSettings` came from
`lib/api-client-react/src/generated/api.schemas.ts` — **OpenAPI-generated code**. That made an HTTP
schema the source of truth for what "cleanup" means. Background-removal strength and halftone cell
size are domain concepts that happen to travel over HTTP, not the reverse.

They are now declared in `core/prepSettings.ts`, **structurally identical** — every field, every
optionality, every union member. The host can pass its generated types straight in and TypeScript
accepts them, so it migrates when it chooses rather than when this package lands.

`PrepJob` and `PrepMachine` are deliberately *structural minimums* — only what the engine reads. A
portable engine that accepted the host's whole `Job` would quietly acquire a dependency on every
field the host later adds.

### Characterization tests added

The machine layer arrived with no tests. Eleven now pin what it does today — most importantly the
**rule ordering** in `inferProcessFamilyFromMachine`, which walks most-specific to least: `"UV DTF"`
contains `"dtf"`, so checking DTF first would route every UV DTF machine wrongly *and the label
would still look right*.

## Extraction pass 4 — the PixelBuffer seam and the prep algorithms

18 more files. **`packages/visioniq` is now 37 files, ~9,070 lines, with zero host imports.**

`core/pixelBuffer.ts` is the raster seam. `ImageData` is structurally
`{ width, height, data: Uint8ClampedArray }`, so `PixelBuffer` accepts one **without a cast** — a
browser host passes its own objects straight in. Only *construction* needed real work:
`new ImageData(...)` is a runtime call, not a type, so it became `createPixelBuffer(...)`.

Extracted: halftone, vector prep, spot channels and their validator, accent layers, background
removal, quality scoring, preflight checks, print-mode rules, QA checklist, workflow mapping, auto-tune,
studio settings, recipes, and `actionPacks` (956 lines).

Deferred: `detectArtworkType` (14 DOM refs) and `canvas-ops/canvasProcessing` (23). Those need a real
canvas adapter, not a type swap.

### Three findings

**An automated coupling count over-reports.** `actionPacks` was flagged with 3 DOM references; all
three were the English word "document" in comments about Photoshop documents. It is entirely
DOM-free. Counts locate candidates; they do not classify them.

**A third `MACHINE_PRESETS` exists** — beyond the two found earlier — in `prep/quickPrepConstants`.
And it is not a copy: `machines/machinePresets` is `Record<MachinePresetKey, MachinePresetConfig>`
keyed uppercase (routing identity), while this one is `Record<string, QuickMachinePreset>` keyed
lowercase with entirely different fields (`cleanupAggression`, `targetDpi`, `sharpen`). **Different
concepts sharing a name**, invisible while they sat in separate module scopes. Both are exported;
`quickPrepConstants`, `spotChannels` and `spotChannelValidator` are namespaced so the ambiguity is
explicit rather than resolved by whoever imported first.

**Three modules persisted to `localStorage` directly** — recipe variants, QA checklist, studio
settings. They now share **one** port (`core/storage.ts`), wired once:
`setVisionStorage(window.localStorage)`. Three separate ports would let a host wire two and silently
lose the third. It fails *quiet*, not closed: without a store, preferences last the session and
preparation is unaffected — a shop losing a checklist tick should not be a shop that stops working.

## Pass 5 — WIRED. Prep Studio now consumes the engine

Four passes of *extract* with no consumer is the risk the directive warns about, so this pass wired
before extracting anything further.

**Result: Prep Studio's `core/` is now seven re-export shims. Its 166 passing tests run against
`@proworks-hub/visioniq@0.10.0`, and nothing else in the Studio changed.**

### Parity, measured against a captured baseline

| | Typecheck | Tests |
|---|---|---|
| Before wiring | 0 errors | 7 failed / 166 passed (4 files) |
| After wiring | **0 errors** | **7 failed / 166 passed (4 files)** |

The seven failures are **pre-existing** — I restored the originals, re-ran, and got the identical
count *and* the identical set of failing files, then re-applied the shims and diffed the failing
lists to confirm. They are unrelated to the extraction.

### One real behaviour change, found and closed

The engine will not reach for `localStorage` — it has to run in a Node service for a licensee with
no browser. So three preferences (operator recipe variants, QA checklist, studio settings) stopped
persisting the moment the shims landed.

Closed by `src/modules/ksix-prep-studio/visionIqStorage.ts`, imported first from the Studio's index.
Nothing breaks without it and no preparation is affected — **which is exactly why it was worth doing
deliberately rather than discovering.** A silently unsaved recipe variant looks like the operator
forgetting to save.

### Changes made to InvoFlowHub (local only — not pushed, and it has no git remote)

| File | Change | Reversal |
|---|---|---|
| `.npmrc` | Added `@proworks-hub:registry` | `.npmrc.before-visioniq` |
| `pnpm-workspace.yaml` | `@proworks-hub/*` added to `minimumReleaseAgeExclude` | `.before-visioniq` |
| `package.json` | Added the dependency | `.before-visioniq` |
| `core/*.ts` (7) | Replaced with re-export shims | `.visioniq-backup/core/` |
| `visionIqStorage.ts` | New — wires the storage port | delete |
| `index.ts` | One import line | remove the line |

`minimumReleaseAge: 1440` blocked the install: pnpm refuses packages published within 24 hours. The
exclusion is what that setting is for — the delay guards against a compromised third-party publish,
and these are first-party packages from our own org.

## Pass 6 — the laser capability

19 files, the whole intelligence half of `modules/laser-prep`. **`packages/visioniq` is now 60 files,
~11,640 lines.** The other 16 files are React panels, pages and hooks, and stay in the host.

Every one of its imports pointed at its own siblings — **zero dependencies outside the module** — and
the whole layer was already free of the DOM and of React.

### It had already solved the seam better than I had

The tone pipeline works on **normalized grayscale `Float32Array`**, not RGBA. It had separated tone
from pixel storage on its own, so it needed no `PixelBuffer` conversion at all. A better internal
boundary than the one I assumed before reading it.

### `LaserToneBuilderConfig` exists twice

`LaserPrepConfig.ts` and `tone/LaserToneBuilderTypes.ts` each declare one. Fields match; the `mode`
union does not — `LaserToneMode` versus `LaserToneMethod`. Merging them would be a behavioural change
disguised as tidying, so `tone` is namespaced and the split is visible in the import path.

That is the fourth duplicate-with-divergence found in this codebase. The pattern is consistent:
separate module scopes hide them, and one package boundary surfaces them all.

### Tests: 14, and two of them failed against correct code first

Written against the invariants a laser depends on, not exact pixels: **two-state output** (a laser
fires or it does not — grey reaches the machine as a guess about what grey means, and machines guess
differently), input immutability (Prep Studio previews several methods against one upload), and
**monotonicity** (a darker photograph coming out with less ink is the washed-out engraving no machine
tuning fixes).

Two failed on the first run because I had the ink polarity backwards: the pipeline emits
`gray <= threshold ? 1 : 0`, so **1 means fire**. The code was right and my assumption was wrong —
which is the correct way round for a characterization test to fail.

## Passes 7–9 — DTF, the canvas boundary, and the learning loop

**`packages/visioniq` is now 72 files, ~13,540 lines. Prep Studio's core, laser and DTF
intelligence all run through it — 27 more shims, parity re-proven.**

**DTF** (6 files, 685 lines) had zero DOM, zero `ImageData` and no imports outside its own module.
The layout engine is the substance: packing designs onto a gang sheet is where a shop wins or loses
film cost.

**Artwork analysis** split cleanly — scoring, classification and colour-mode inference are pure and
came across unchanged. Resampling became a **port** rather than something I reimplemented: the host
does it by drawing to a canvas, and writing a resampler inside the engine would change results
subtly. A different filter is a different answer, and this analysis feeds classification decisions.
Canvas resampling stays canvas resampling.

Capabilities now have subpath exports — `visioniq/laser`, `visioniq/dtf` — so a host can take one
without the whole engine.

### The learning loop — the one genuinely new thing

Three modules, 23 tests. Everything else in VisionIQ was extraction; this did not exist anywhere.

**Provenance** records what happened and *who decided it*. The actor is on every step because
"contrast +18" means three different things depending on whether the engine proposed it, a customer
chose it, or an operator overrode it — and only the third is evidence the engine was wrong.

**The difference operator** compares before and after when somebody edits outside the system. It
recognises knockouts, resizes, crops, grayscale conversion, brightness and contrast shifts — and
says `unknown_visual_change` when nothing fits, because §23 is explicit that VisionIQ must not
pretend to understand an edit it cannot. It asks for confirmation unless a change is both confident
**and singular**: two competing explanations mean it does not know which the operator intended,
however sure it is of each.

**Feedback** turns corrections into observations and observations into *proposals*. Two rules shape
it:

- **No customer artwork leaves its tenant.** Observations record the structure of a correction —
  "operators raised contrast by 6 on black slate" — never the image. `assertObservationIsSafe`
  refuses any unrecognised field and any record without an `organizationId`, failing towards keeping
  data out.
- **It recommends; it does not rewrite.** Median rather than mean, so one operator's typo cannot
  move a profile. An agreement threshold, because operators disagreeing with each other is not the
  engine being wrong. A minimum sample size, because a profile changed on four jobs changes back on
  the next four. The output is a sentence an admin approves or ignores.

### Next

The canvas adapter for `canvasProcessing` (23 DOM refs) is the last significant coupling. Then the
host-side wiring of the learning loop — capturing Prep Studio's own edits as observations.

Still true: **nothing deleted anywhere.**
