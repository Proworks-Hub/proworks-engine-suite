# Migration audit — Family Table receipt intelligence → ReceiptIQ

Audited against `skreutzer-arch/Family-Table` @ `4a674a1`, 2026-08-27.
No Family Table code has been modified. This document is the inspection that precedes it.

## The headline finding

**Family Table already contains the architecture this migration is meant to create — in SQL,
not in JavaScript.** The receipts module in `deploy/sql/supabase_family_v87.sql` is written as
two layers with a hard boundary, and says so in its own header comment:

> This module is TWO layers with a hard boundary so the price database can be extracted
> later as its own service, serving other apps. […] Lifting the price database out later =
> move the `ci_*` tables + their functions. Nothing app-side needs to change except pointing
> that one function at the new service.

That is ReceiptIQ, described a year early. The privacy model the directive calls non-negotiable
is likewise already designed and *enforced as code* — `supabase_knowledge_v87.sql` ends with a
guard that fails the install if anyone ever adds a column matching
`household|user|member|person|family|account|device|email|phone|address|postcode|zip|lat|lon|ip_`.

So this migration is less an extraction than a **completion**. Three things follow from it:

1. The data-ownership model does not need inventing. It needs porting from SQL into portable
   TypeScript, where both hosts can share it.
2. The canonical/private split should be carried as **types**, not conventions, so a host
   cannot accidentally hand a private record to the shared layer.
3. There is a real gap, described below, that ReceiptIQ should close.

## The gap: the intelligence is built and never used

The shared knowledge base exists in two independent designs — `ci_*` inside the family project
(`supabase_family_v87.sql:1030-1180`) and a standalone project (`supabase_knowledge_v87.sql`,
304 lines) — with a working write door, a read function, RLS, grant hardening, and the column
guard. **Neither is called by the application.**

| Claim | Evidence |
|---|---|
| No client calls `submit_price_observation` | Zero matches in `app/*.js`; the only caller anywhere is `test_v87_live_cloud.py:60`, which hits `lookup_price` over REST |
| No client calls `share_price_observation` | Zero matches in `app/*.js` |
| `communityOptIn` is declared and never read | Set at `app/022-…:12`; that is its only appearance in the source |
| Receipts never reach the cloud at all | The sync allowlist at `app/061-…:31` has no `receipt` entity; `D.receipts` lives only in the local document |
| The `receipts` / `receipt_items` SQL tables are unused by the client | No `from('receipts')` or equivalent anywhere in `app/` |

So today every price observation Family Table learns dies inside one browser's `localStorage`.
The engine that would make it shareable was written, hardened, tested against a live project —
and never wired up. **ReceiptIQ is how that work finally gets used, by two applications instead
of none.**

## Where the module actually lives

Family Table has no module system. `build.py` concatenates `app/*.js` (111 files) into one
`public/index.html` inside a single global namespace; the build's own duplicate-function check
exists because that namespace has caused real outages. Receipt code is therefore identified by
**naming convention** (`ftReceipt*`, `ftCI*`, `ftScan*`, `ftItem*`) and by the numbered slices
it was added in, not by directory.

`public/index.html` is build output, not source — its 203 receipt matches are the same code
counted twice. It is excluded from everything below.

The user's description of the module as "relatively modular" holds up: the receipt work is
concentrated in a contiguous run of slices (022–030) plus two earlier hosts, and the pure
functions genuinely avoid reaching into household state. What they do reach for is ambient
globals (`D`, `ui`, `FT()`, `render()`, `autosave()`), which is the actual portability problem.

### Every receipt-relevant file

| File | Lines | Receipt content |
|---|---|---|
| `app/013-v46-new-feature-capture-smart-money-intellig.js` | 638 | `ftReceiptParse`, `ftMerchNorm` + `FT_BRANDS`, `ftItemCat`, receipt save/apply/delete, transaction matching |
| `app/018-v49-universal-family-engine-phase-3.js` | 427 | Retention classes, purge sweep, `finalizeReceiptMatch`, `saveReceipt` |
| `app/022-v52-meals-intelligence-cost-intelligence-por.js` | 167 | `ftCI` store, `ftCINormName`, `ftCIProduct`, `ftCIRecord`, `ftCIEstimate`, `ftCIBestEstimate` |
| `app/023-v53-receipt-cost-intelligence-phase-r1-found.js` | 157 | `ftCIStoreKey`, `ftItemConf`, `ftItemTeach`, `ftCIRegionalSummary`, AI vision transport, photo scan |
| `app/024-v54-receipt-cost-intelligence-phases-2-4.js` | 13 | Phase header only |
| `app/025-phase-3-capture-adapter-registry-honest-stat.js` | 22 | `FTReceipts` adapter registry, `ftReceiptFingerprint`, `ftReceiptDuplicate` |
| `app/026-phase-2-guided-section-scan.js` | 140 | Sectioned capture of long receipts, `ftScanMerge` |
| `app/027-phase-3-e-receipt-text-ingestion-same-pipeli.js` | 37 | E-receipt paste → same pipeline |
| `app/028-phase-4a-needs-review-queue.js` | 33 | `ftReviewQueue`, `ftReviewTeach` |
| `app/029-phase-4b-pantry-suggestions-from-receipts.js` | 41 | Pantry suggestions from recent receipts |
| `app/030-phase-4c-build-my-week-budget-aware-spec-3-2.js` | 161 | Budget-aware week planning; `ftCICatalogToggle` |
| `app/039-…` / `app/040-…` | — | `ftProductOffers`, `ftRecordOffer`, `ftCIOfferEstimate` |
| `app/059-v53-1-shared-household-safety-product-learni.js` | 80 | `FT_CI_UNITS`, `ftCIUnitNorm`, `ftCIConvert`, `ftCIUnitPrice`, `ftCIIngredientCost` |
| `app/064-…` / `app/074-…` | — | Pantry wizard product metadata; `ftPantrySharedContribute` |
| `deploy/sql/supabase_family_v87.sql` | §3/8 | App layer + `ci_*` layer + `share_price_observation` bridge |
| `deploy/sql/supabase_knowledge_v87.sql` | 304 | Standalone knowledge base, write door, read function, column guard |
| `deploy/sql/ft_harden_knowledge.sql` | — | Grant hardening (revoke-all-then-grant-select) |

## Classification

### 1. Portable ReceiptIQ core → `packages/receiptiq/`

Pure logic. Depends on its arguments and nothing else, once the ambient globals are lifted
into parameters.

| Source | Capability | Why it is portable |
|---|---|---|
| `ftReceiptParse` (`013:190-236`) | **The line parser.** Discounts and coupons applied to the line above, `was`/`reg` prices, `%-off`, BOGO, `2 @ 2.50` vs `2/5.00`, printed weights (`lb/oz/kg/g/ct/pk`), tax lines | String in, structured lines out. No state at all |
| `ftMerchNorm` + `FT_BRANDS` (`013:36-62`) | Merchant normalization to a stable key, with a brand table and a fallback that strips POS noise, card digits and TLDs | Pure; the brand table is data |
| `ftCINormName` (`022:15`) | Canonical name key | Pure |
| `ftCIProduct` (`022:18`) | Canonical item with aliases, brand, size, UPC | Needs a repository instead of `c.products` |
| `ftCIRecord` (`022:26`) | Price observation writer with dedupe key, unit price, sale facts, confidence, scope | Same |
| `ftCIEstimate` (`022:43`) | **The estimator.** Store/region narrowing, *regular price preferred over sale price*, median + average, recency-and-count confidence tiers | Pure over a row set |
| `ftCIBestEstimate` (`022:68`) | Source hierarchy: preferred store → region → everything | Pure wrapper |
| `ftCIRegionalSummary` (`023:36`) | Same item, store by store: median, latest, sale flag | Pure over observations |
| `ftCIStoreKey` (`023:16`) | Store identity as chain+region — *never a branch or address* | Pure, and a privacy primitive |
| `ftItemConf` / `ftItemTeach` (`023:21,27`) | Confidence, and correction as learning | Teach needs a knowledge repository |
| `ftItemCat` (`013:175`) | Category classification: learned overrides beat a lexicon beat unknown | **Mechanism** portable, **taxonomy** is not — see below |
| `ftReceiptFingerprint` / `ftReceiptDuplicate` (`025:15,18`) | One duplicate identity across photo, guided, email and manual | Pure; lookup needs a repository |
| `ftScanMerge` (`026:94`) | Dedupe overlapping sections of a long receipt | Pure |
| `FT_CI_UNITS`, `ftCIUnitNorm`, `ftCIConvert` (`059:8-20`) | Mass/volume/count unit table and conversion | Pure, and the best-isolated code in the module |
| `ftCIUnitPrice`, `ftCIIngredientCost` (`059:23,24`) | Package-size normalization → true price per unit | Pure given product metadata |
| `ftReceiptSplitFrom` (`013:237`) | Group lines by category, allocate the remainder | Pure |
| `ftProductOffers`, `ftRecordOffer`, `ftCIOfferEstimate` | Retailer offers, deliberately stored apart from observations because an offer is a weaker signal | Pure |

One caveat worth stating plainly: `ftItemCat`'s lexicon maps to Family Table's **budget**
categories (`CATS` at `app/001-data.js:8` — Housing, Utilities, Food, Insurance, Transportation,
Child Support, …). Those are household-budget lines, not product categories, and ProWorks would
never want them. The classifier *mechanism* — learned override, then lexicon, then unknown, with
a confidence per tier — is portable. The **category set must become a parameter**, with each host
supplying its own taxonomy. This is the single most important thing not to copy verbatim.

### 2. Shared contract → `packages/contracts/`

Types that cross an engine boundary. `NormalizedReceipt` and `PriceObservation` must be visible
to CostIQ without CostIQ importing ReceiptIQ, exactly as `ManufacturingPlan` is today.

- `NormalizedReceipt` / `NormalizedReceiptLine` — merchant, store identity, date, lines, totals,
  tax, discounts, confidence, `receiptVersion`
- `CanonicalItem`, `MerchantIdentity`, `MerchantItemRef` (SKU/UPC)
- `PriceObservation` — the one CostIQ consumes as a material cost basis
- `ReceiptExtractor` port (image/text → raw extraction) so no AI vendor is baked in
- `OwnershipClass` — see the privacy section
- `CorrectionEvent` — learning, carrying no source record

### 3. Family Table adapter → stays in Family Table

| Source | Why it stays |
|---|---|
| `ftReceiptSave` (`013:257`) | Writes `D.receipts`, sets Family Table retention fields, calls `autosave()`/`render()` |
| `ftReceiptCandidates` (`013:246`) | Matches against `D.txns` — the household ledger |
| `ftReceiptApply` (`013:283`), `finalizeReceiptMatch` (`018:309`) | Turns a receipt into a categorized household transaction with a budget split |
| `ftReviewTeach` (`028:14`) | Rewrites household receipts and observations in place; the *teaching* half moves, the rewrite stays |
| `ftPantrySuggestions` (`029:3`) | Pantry is a Family Table concept |
| `ftGroceryCostSummary`, `ftRecipeCalcCost`, `ftMealPlanCost` (`022:109-135`) | Meals and groceries are Family Table |
| `ftCIApplyToMaterial` (`059:28`) | Projects/materials are Family Table |
| `FTReceipts` registry (`025`) | Capability reporting is host-specific — the *adapters* differ per host, the registry idea can be mirrored |

### 4. Family Table persistence → stays in Family Table

The entire local-first document (`D.costIntel`, `D.receipts`, `D.merchants`), `autosave()`,
Supabase sync (`app/060`, `app/061`), and every household-scoped SQL table:
`receipts`, `receipt_items`, `household_price_observations`, `household_ci_settings`, and
their adult-only RLS policies.

These become **implementations of ReceiptIQ ports**, not part of the engine.

### 5. Family Table UI → stays in Family Table

`ftReceiptModal`, `ftCISummaryHTML`, `ftCIRegionalHTML`, `ftReviewQueueHTML`, `ftScanModal`,
`ftEmailReceiptModal`, `ftPantrySugHTML`, `ftCIProductMetaModal`, `ftPrivacyNote`, and every
`prompt()`/`alert()`/`confirm()` interaction (`ftCIManualPrice`, `ftCISetProductMeta`).

Worth noting: several otherwise-portable functions are **welded to the UI by `prompt()`** rather
than by any real dependency. Splitting the decision from the dialog is most of the porting work
for those.

### 6. Unrelated / dead / duplicate

| Item | Status |
|---|---|
| `communityOptIn` (`022:12`) | **Dead** — declared, never read. Its intent is realized by ReceiptIQ's ownership model |
| `catalogPrices`, `external` | **Deliberately removed** in `_migrateV6` (`023:130`) — an external price catalog was dropped because "a catalog price is not a price your family paid". Do not resurrect it |
| `gmailSync` / `outlookSync` adapters (`025`) | Honest stubs: *"OAuth needs a server to hold the token exchange; this file cannot do it honestly."* Now buildable, but out of scope |
| Two knowledge-base designs | `ci_*` (in-project) and `supabase_knowledge_v87.sql` (standalone) overlap. The standalone one is stricter and is the better model for ReceiptIQ |
| `ftCIRecord` vs `submit_price_observation` | The same concept implemented twice, in JS and PL/pgSQL, with different field names (`price`/`price_cents`, `region` free text / `US-CO` shape). **ReceiptIQ must reconcile these** |

## Data schemas that already exist

Three representations of the same concepts, which is the strongest argument for a single engine:

| Concept | Local JS | Household SQL | Shared SQL |
|---|---|---|---|
| Canonical item | `c.products[key]` — key, name, aliases, brand, size, upc, category | — | `ci_products` / `products` — normalized_name, brand, size, upc, aliases |
| Receipt | `D.receipts[]` | `receipts` | *(none — by design)* |
| Receipt line | `rec.items[]` | `receipt_items` | *(none)* |
| Price observation | `c.observations[]` | `household_price_observations` | `ci_shared_observations` / `price_observations` |
| Store | `storeKey` string | `store_name` + `store_region` | `stores` (chain + region) |
| Summary | `ftCIRegionalSummary` (derived) | — | `ci_regional_summaries` (cached) |

The mismatches are informative. The shared layer uses `price_cents` **integer** where the local
layer uses floating `price`; it constrains region to `^[A-Z]{2}(-[A-Z]{2,3})?$` where the local
layer accepts `"Brighton, CO"` free text. ReceiptIQ should adopt the **stricter** forms — integer
minor units and a constrained region shape — because they are the ones that survive being shared.

## Extraction / OCR / AI

There is no OCR. Extraction is a vision-model call, and it is already funnelled through a single
transport, `FTAI.requestVision` (`023:64`), which every image feature shares.

Three capture paths converge on one pipeline:

```
photo (023)  ─┐
guided sections (026) ─┼→ vision/text model → JSON → ftReceiptScanApply → ftReceiptParse → lines
e-receipt paste (027) ─┘                              (editable review — never auto-saved)
manual typing ────────────────────────────────────────┘
```

Two properties are worth preserving verbatim:

- **The prompts are privacy instructions.** They direct the model to read product names, prices,
  sale prices, store, date and total, and explicitly *never* to output personal information,
  loyalty or membership numbers, payment-card digits, or signatures.
- **Images are never stored.** Processed in memory, discarded, and the discard is logged
  (`RAW_RECEIPT_IMAGE_DISCARDED`). The SQL carries the same rule structurally: there is
  deliberately no image column anywhere in the module.

For ReceiptIQ this becomes a `ReceiptExtractor` port. Family Table's direct-to-Anthropic browser
call is a host implementation, not engine code — a browser-side API key is a Family Table
deployment choice that ProWorks must not inherit.

## Correction and learning

The behavior the directive asks to preserve exists and is well-shaped:

1. `ftItemTeach` (`023:27`) writes the correction to `costIntel.itemCats` keyed by **normalized
   name**, and emits `RECEIPT_ITEM_TAUGHT`.
2. `ftItemConf` (`023:21`) returns `0.95` for a learned name, `0.7` for a lexicon hit, `0.3` for
   unknown.
3. `ftReviewQueue` (`028:3`) surfaces everything below `0.5`.
4. `ftReviewTeach` (`028:14`) applies the correction forward across existing receipts and
   observations.

The key already separates cleanly: **what is learned is a normalized name → category mapping.**
It carries no household, no transaction, no receipt id. It is canonical knowledge by
construction, which is exactly the split the directive requires — and it means correction
learning can be shared while the receipt that produced it stays private.

## Tests that exist

50 `test_*.py` files drive the **built** `index.html` in Chromium via Playwright and assert
against live page state. Receipt coverage lives in `test_merge.py`:

- `M-02` — all four receipt phases present
- `M-11` — **receipts never enter the member-visible stream**, asserted against a deliberately
  non-empty projection so the test cannot pass vacuously
- `M-20` — `ftReceiptParse('Milk was 4.99 3.89')` → `3.89`, and `'Chips BOGO 3.50'` → `saleType
  "bogo"`
- `M-21` — `ftCIEstimate` still returns a result after the cloud-layer merge
- `M-22` — `ftScanMerge` dedupes overlapping sections (2 items from 3), and the adapter registry
  reports honest availability

`test_v87_live_cloud.py` exercises `lookup_price` against a live Supabase project.

**These tests cannot run as-is here.** They hardcode `file:///home/claude/Family Budget
Studio.html`, need Playwright and Chromium, and `test_v87_live_cloud.py` needs live credentials.
They are excellent behavioral *specifications* and poor regression harnesses for this migration.
The practical consequence: ReceiptIQ's parity evidence must come from **new unit tests that
encode the same assertions** — starting with M-20's exact cases — run under Vitest in the suite.
Family Table parity is then demonstrated by its adapter reproducing the same outputs.

## What must be newly built

Nothing below exists in Family Table in any form.

| Item | Why it is new |
|---|---|
| **Ownership classification as a type** | The concept exists only as SQL structure and a column-name guard. ReceiptIQ needs `canonical` / `host-private` / `tenant-private` on every record, enforced by the type system so a host cannot pass a private record where a canonical one is expected |
| **Repository ports** | `ReceiptRepository`, `MerchantKnowledgeRepository`, `ItemKnowledgeRepository`, `PriceObservationRepository`. Family Table has direct object access and SQL functions; neither is a port |
| **The contribution boundary in TypeScript** | `share_price_observation` exists as PL/pgSQL only. Its de-identification logic must become portable engine code so both hosts share one implementation |
| **CostIQ join** | `PriceObservation → material cost basis`. The exact counterpart of `manufacturingPlanToJobCostInput`, and exists in neither codebase |
| **ProWorks adapter** | Vendor purchase / inventory / expense mapping. No prior art |
| **Merchant SKU mapping** | `products.upc` exists; a *merchant-scoped SKU* (Home Depot `123456` → canonical item) does not. This is the directive's own worked example and is genuinely missing |
| **Category taxonomy as a parameter** | Currently hardcoded to household budget categories |
| **Portable privacy guard test** | The SQL guard is real and should be mirrored as a suite test, so the rule holds in TypeScript too |

## What should move, and in what order

Sequenced so each step is verifiable before the next depends on it:

1. **Contracts first** — `NormalizedReceipt`, `PriceObservation`, `CanonicalItem`,
   `OwnershipClass`, ports. Nothing to port yet; this is the boundary everything else targets.
2. **The pure functions** — parser, merchant normalization, unit conversion, estimator,
   fingerprinting. These carry the most value per line and have the fewest dependencies. Port
   with tests that encode `M-20` and the estimator's sale-vs-regular rule.
3. **Knowledge layer** — canonical item, aliases, merchant/SKU mapping, category classification
   with an injected taxonomy, correction learning.
4. **The contribution boundary** — private observation → canonical observation, porting
   `share_price_observation`'s de-identification into TypeScript, with the privacy guard test.
5. **CostIQ join** — price observation → material cost basis.
6. **Family Table adapter**, then parity, then removal of the duplicated logic — and not before.
7. **ProWorks adapter.**

## What must not move

Stated explicitly because each is a trap the shape of this code makes easy:

- **Family Table's budget categories.** Portable mechanism, host taxonomy.
- **The `D` document, `ui` state, `render()`, `autosave()`.** Every one of these is ambient in
  the source and must become a parameter or a port.
- **`prompt()` / `alert()` / `confirm()`.** Several otherwise-pure functions are welded to
  dialogs; the decision must separate from the interaction.
- **The direct browser call to `api.anthropic.com` with a user-supplied key.** A Family Table
  deployment choice, behind the `ReceiptExtractor` port.
- **Household transaction matching, budget splits, pantry, meals, recipes, projects.**
- **Any household or user identifier.** The SQL guard is right, and ReceiptIQ inherits the rule.
