# @proworks/receiptiq

**ReceiptIQ Engine** — read it, normalize it, learn from it.

Copyright © 2026 Steven Kreutzer. All rights reserved. Proprietary and confidential.

The shared receipt-intelligence layer. One application scans a receipt; another benefits from
what was learned — without either seeing the other's records.

## The problem it solves

Family Table scans a Home Depot receipt:

```
1/8" steel flat bar   SKU 123456   2 @ 18.97
```

ReceiptIQ normalizes it to a canonical item, a merchant identity, and an observed unit price of
$18.97 on 2026-08-26 in US-CO.

Months later ProWorks buys the same SKU at the same chain. ReceiptIQ recognizes it and can say
what it has cost. ProWorks never sees the household, its budget, or its members; Family Table
never sees the shop's customers, jobs, or finances.

**Canonical knowledge is shared. Private records are not.**

## Using it

```ts
import { createReceiptIqEngine } from "@proworks/receiptiq";

const receiptiq = createReceiptIqEngine();

// A raw capture becomes a private, normalized record.
const receipt = await receiptiq.read(
  { kind: "text", text: printedReceipt },
  { ownerRef: householdId, ownership: "tenant-private" },
);

// Only on an explicit opt-in does anything become shareable.
const { observations, withheld } = receiptiq.contribute(receipt, { optedIn: true });

// What an item costs, from observations alone.
const estimate = receiptiq.estimate("steel flat bar", observations);
```

`read` and `contribute` are separate calls on purpose. A single `process()` that did both would
make contribution the default path and privacy the thing you have to remember — which is how a
shared-knowledge system becomes a shared-data system without anyone deciding to.

## The privacy boundary

Four refusals, enforced in `boundary/contribute.ts` and tested in `__tests__/privacy.test.ts`:

1. **Not opted in, nothing crosses.** There is no default that shares.
2. **No region, nothing crosses.** A price with no region cannot be compared to anything.
3. **Tax and unpriced lines do not cross.** Tax is a fact about a jurisdiction, not a product.
4. **Nothing identifying crosses.** Enforced twice — `.strict()` schemas reject unknown keys, and
   `assertNoIdentityFields` rejects anything *named* like an identifier, at any nesting depth.

Absent from every observation by construction: the receipt, its id, its owner, the host, the
tenant, and any time more precise than a date. An exact timestamp says when someone shops, which
is a behavioural fingerprint; a date does not.

This is the portable form of a boundary Family Table already enforces in SQL, whose schema guard
refuses to install if a column appears that could tie a row to a person.

## What it knows how to do

| Area | Capability |
|---|---|
| **Parsing** | Discounts applied to the line above, was/regular prices, %-off, BOGO, `2 @ 2.50` vs `2/5.00`, printed weights, tax lines, labelled SKUs |
| **Merchants** | Collapses the ways one chain prints itself; strips payment-rail noise, card and store numbers |
| **Items** | Canonical items with aliases, brand, UPC, package size; merchant SKU mapping |
| **Units** | Mass, volume and count conversion; true unit pricing from package size |
| **Prices** | Median-led estimates that prefer regular prices over sale prices, with confidence from count *and* age |
| **Learning** | Human corrections outrank the lexicon, and carry no trace of the record that produced them |

## Ports, not storage

ReceiptIQ opens no connection to anything. Persistence is a set of interfaces a host implements:
`ReceiptRepository`, `MerchantKnowledgeRepository`, `ItemKnowledgeRepository`,
`PriceObservationRepository`, and `ReceiptExtractor`.

`ReceiptRepository` has deliberately **no "list all"**. An API that cannot express a cross-host
query cannot accidentally run one.

The built-in `textExtractor` needs no AI provider, no API key and no network, so the pipeline is
testable and reproducible offline. Image extraction is a host's `ReceiptExtractor` — the choice
of vision model, and who pays for it, is a deployment decision.

## Taxonomy is a parameter

The classifier mechanism is portable; the categories are not. A household files a purchase under
budget lines and a shop files the same steel bar under an expense account. Hosts supply their own
lexicon; ReceiptIQ supplies the three-tier resolution — human correction (0.95), lexicon match
(0.70), unknown (0.30) — and the 0.5 threshold below which a host should ask rather than act.

## Provenance

Migrated from Family Table, where this intelligence was built and proven against real grocery,
hardware and clothing receipts. The parser's behaviour is preserved exactly, including Family
Table's own `M-20` assertions, which are carried over as the parity anchor in
`__tests__/parseReceiptLines.test.ts`.

See `docs/RECEIPTIQ-MIGRATION-AUDIT.md` for the file-by-file audit.
