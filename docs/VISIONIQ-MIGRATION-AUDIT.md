# VisionIQ — cross-repository audit

Owner: Steven Kreutzer · 2026-08-27
**Audit only. No code written, nothing moved, nothing deleted** — per §49 and addendum §1.

---

## Headline: two findings change the plan

**1. Prep Studio's implementation is not in any repository I can reach.**

ProWorks `src/App.tsx` carries:

```
// [reconcile] Studio-addon stub — KSixPrepStudioModule ships with the KSix Prep Studio add-on.
const KSixPrepStudioModule = ((() => null) as unknown as ...);
```

Two routes (`prep-studio`, `ksix-prep-studio`) resolve to that stub. There is no Prep Studio source,
no Fabric.js anywhere, and no MakerOps repository on this machine. **The addendum's central task —
extract Prep Studio intelligence — cannot be performed on code I can see.** See §10 for what I need.

**2. ProWorks already defines the integration contract, and it is further along than expected.**

`src/modules/work-orders/types/PrepResult.ts` is at **schema version 2** and already carries
`dpi`, `colorProfile`, `machinePreset`, `readinessScore`, `issues[]`, `recommendations[]` — and
`recipeUsed`, `recipeRequested`, `recipeMigrationFrom`.

**Recipes already exist as a first-class concept and have already been through one migration.** The
addendum §12 asks for them to be promoted into VisionIQ; the vocabulary is already in the host.
Fourteen `prep-bridge` components consume this contract today, one of which is commented "bridges to
Prep Studio without duplicating it."

**VisionIQ's output contract should be derived from `PrepResult`, not invented beside it.**

---

## 1–3. Existing features that belong in VisionIQ

### KSix — the real, working preparation intelligence

| File | Lines | What it does | Verdict |
|---|---|---|---|
| `client/src/lib/laserExport.ts` | 253 | `engraveProcessCanvas` (luminance grayscale, auto-levels, **material-driven inversion**), `prepareEngraveImage`, `recommendLaser`, `buildLaserManifest` | **MOVE TO VISIONIQ** — core + laser capability |
| `client/src/lib/printExport.ts` | 339 | `setPngDpi` (pHYs chunk), `fitExportScale`, `traceAlphaContour`, `contourToSvgCutFile`, `canvasToPrintBlob` | **MOVE TO VISIONIQ** — core + print capability |
| `client/src/lib/smartBgRemoval.ts` | 165 | `smartRemoveBackground` | **MOVE TO VISIONIQ CORE** |
| `client/src/components/PhotoEditorModal.tsx` | 1652 | The editing surface — KSix's Prep Studio analogue | **KEEP AS HOST UI**; intelligence inside it needs a line-by-line split |
| `client/src/lib/autoBuild.ts` | 142 | `multiSheetPack` — gang-sheet nesting | **DO NOT TOUCH** — nesting is ForgeIQ's, not asset prep |
| `client/src/lib/rosterArt.ts` | 373 | Roster name/number art generation | **KEEP IN KSIX** — product-specific content generation |
| `server/productionZip.ts` | — | `classifyFile` regex cascade over filenames | **REPLACE WITH MANIFEST** (already contracted) |

`engraveProcessCanvas` is worth calling out: it already implements §12's photo→slate-vs-anodized
distinction via `ENGRAVES_LIGHT`, and `recommendLaser` already returns a machine **with a reason**.
This is genuine VisionIQ intelligence that exists and works.

### ProWorks — integration surface, no duplicate intelligence

Searched for canvas, ImageData, DPI, dither, grayscale, background removal, upscaling,
vectorisation. **ProWorks contains no image-processing implementation.** What it has:

| Location | What | Verdict |
|---|---|---|
| `types/PrepResult.ts` | The prep output contract, v2, with recipes | **MOVE TO CONTRACTS** — align VisionIQ's output with it |
| `components/prep-bridge/` (14) | Launch/resume/readiness/recommendation UI | **KEEP AS HOST UI** |
| `utils/buildPrepRecommendationReasons.ts` | Turns prep issues into operator-readable reasons | **INSPECT** — likely VisionIQ explainability (§36) |
| `lib/prepReleasePolicy.ts` | Whether prep is complete enough to release work | **KEEP IN PROWORKS** — a release decision, not asset intelligence |

ProWorks is a clean consumer. Nothing to deprecate.

### MakerOps

**Does not exist on this machine.** No repository, no `makerops/` directory.

---

## 4. Where each thing goes

**VisionIQ core** — effective-DPI calculation · grayscale/luminance · auto-levels · background
removal · alpha-contour tracing · crop detection · pHYs DPI stamping · export scale fitting.

**VisionIQ process capability** — laser/engraving (material inversion, tonal prep, machine-class
recommendation) · print/DTF (contour, cut file, print-size validation).

**Host UI** — `PhotoEditorModal`, all fourteen `prep-bridge` components, machine/material pickers.

**Host adapter** — canvas ⇄ pixel buffer, blob upload, file storage.

**Contracts** — `PrepResult` promoted and reconciled with `ProductionAssetManifest`.

---

## 5. ForgeIQ overlap — real, and narrower than it looks

| ForgeIQ file | Overlaps | Recommendation |
|---|---|---|
| `validation/rules/imageResolution.ts` | Effective DPI — computes `naturalWidthPx / widthIn` | **Extract the primitive, keep the rule** |
| `validation/rules/artworkIslands.ts` | Interior-island detection (§9 vector) | **Keep in ForgeIQ** — manufacturability |
| `validation/geometry.ts` | Minimum feature, bounds | **Keep in ForgeIQ** |
| `export/cutlineSvg.ts` | Cutline generation | **Inspect** — generation may be VisionIQ, constraint is ForgeIQ |
| `repair/designRepair.ts` | Geometry repair | **Inspect** — repair is preparation |

The clean line, and the one the directive itself draws:

- **"Is this below this product's minimum DPI?"** → ForgeIQ. It is a product-definition constraint.
- **"What is this image's effective DPI?"** → a shared primitive, computed once.
- **"Make it good enough for this process."** → VisionIQ.

So the fix is **not** to move `imageResolutionRule`. It is to stop two engines each computing
`px / inches` from first principles. One primitive, two consumers.

---

## 6. Duplication across hosts

**Almost none, and that is the surprise.** The expected three-way overlap between ProWorks, MakerOps
and KSix does not exist:

- ProWorks has **no** preparation implementation — only the contract and the bridge UI
- MakerOps has no repository
- KSix holds **all** of it, in three files totalling ~757 lines

The duplication risk is between **KSix and the unreachable Prep Studio add-on**, and I cannot assess
that without the add-on's source.

---

## 7. Missing capabilities

Nothing in any repository does: upscaling · denoising · sharpening · dithering/halftone ·
threshold · ICC/colour management · white-layer or underbase preparation · vector path cleanup ·
open/closed path analysis · duplicate-path detection · bridges and tabs · embroidery ·
asset difference (§23) · operator-correction capture (§21) · the learning loop (§20).

**The learning architecture is entirely new.** No repository has any of it.

---

## 8. The architectural problem, and the proposed package shape

**Every piece of working intelligence is browser-coupled.** `laserExport.ts`, `printExport.ts` and
`smartBgRemoval.ts` carry 11–15 references each to `HTMLCanvasElement`, `ImageData`, `document`,
`Blob`. The algorithms are portable; the I/O is not.

A portable engine cannot depend on a browser, and §33 requires the core to work outside React and
outside a browser entirely — a licensee's Node service must be able to call it.

So extraction is not a `git mv`. It needs a pixel-buffer abstraction the algorithms operate on, with
canvas as one adapter:

```
packages/visioniq/src/
  core/
    raster/      analyze · grayscale · levels · crop · background · contour
    vector/      paths · bounds · cleanup (new)
    pixels.ts    PixelBuffer — the portability seam
  capabilities/
    laser/       from laserExport.ts
    print/       from printExport.ts
  profiles/      machine · material · production
  provenance/    transformation chain
  learning/      difference operator · feedback (new)
  ports.ts       VisionAssetStore · AiProvider · decoders
```

`PixelBuffer` is `{ width, height, data: Uint8ClampedArray }` — which `ImageData` already satisfies
structurally, so the canvas adapter is nearly free and the algorithms move almost unchanged.

---

## 9. Migration order

1. `PixelBuffer` + the port surface — nothing moves until there is somewhere portable to move to
2. Effective-DPI primitive into contracts; ForgeIQ consumes it (removes the only real duplication)
3. Raster core from `smartBgRemoval` + the grayscale/levels half of `laserExport`
4. Laser capability — engrave prep, material inversion, machine-class recommendation
5. Reconcile `PrepResult` with `ProductionAssetManifest` in contracts
6. Print capability — contour tracing, cut files, DPI stamping
7. KSix adapter: `laserExport`/`printExport` become thin re-export shims — **behaviour preserved,
   originals not deleted**
8. Provenance and the transformation chain
9. Difference operator and feedback
10. Delete KSix duplicates **only after** the comparison in §26 passes

---

## 10. Risks, and what I need from you

**The blocking one: Prep Studio is unreachable.** Its intelligence is the addendum's stated target.
I can extract KSix's, which is real and works — but I would be building VisionIQ from one of the two
sources you named, and the other may be better. **Where is the Prep Studio add-on source?**

**Second: `PrepResult` v2 is live.** Fourteen ProWorks components consume it and it has already
survived a recipe migration (`recipeMigrationFrom` exists). VisionIQ's output must reconcile with
it rather than replace it, or the bridge UI breaks.

**Third: KSix's prep code is used by live builders.** `SignBuilder`, `OrnamentBuilder`,
`CanvasBuilder`, `PosterBuilder` and `Order` all import these libraries. Extraction touches the
deployed storefront's production-file path — the highest-consequence code in the ecosystem, since a
mistake there means a wrong file on a machine.

**Fourth: no reference assets.** §26 requires comparing old output against new for the same input.
I have no sample customer photograph, no known-good slate output. **A handful of real before/after
files would make that acceptance test meaningful instead of synthetic.**

---

## What I did not do

No `packages/visioniq`. No code moved. No files deleted. §49 says audit first, and the Prep Studio
gap means a decision is needed before extraction order is settled.
