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

### Next

Steps 3–6: preflight, profile resolution, recipes, machine targeting — then rewire Prep Studio as
the first consumer, per §"FIRST CONSUMER".
