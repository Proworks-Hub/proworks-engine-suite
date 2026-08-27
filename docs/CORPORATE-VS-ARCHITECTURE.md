# Corporate ownership vs software architecture

Owner: Steven Kreutzer · 2026-08-27

**Read this before naming anything.**

## Interaxis is a company

Interaxis is the proposed parent software company. It **owns** the products and the intellectual
property. It does not appear in a request path.

```
Interaxis  (company — owns and develops)
    │
    ▼
Products / hosts
    ├── ProWorks Hub        production OS for real shops
    ├── MakerOps            maker-facing product and operations experience
    ├── KSix Designs        customer-facing commerce and production host
    └── FabriOps (future)
            │
            ▼
Reusable engine + platform IP
    ├── ForgeIQ         what is this product, and how can it be made
    ├── CostIQ          what does it cost to make
    ├── Prime           what should happen next
    ├── WorkOrderIQ     what work must be executed, and what state is it in
    ├── InventoryIQ     what is on hand, spoken for, and about to run out
    ├── ReceiptIQ       normalized purchase knowledge
    ├── VisionIQ        an engine, placed; domain not yet specified
    └── shared services  tracking · notifications · order ingestion · event bus
```

## Interaxis is NOT

an engine · a host · an API gateway · a runtime · an order service · a data model · a manufacturing
contract · a SKU namespace · a layer requests flow through.

**This is wrong** and must never appear:

```
App → Interaxis → Engine
```

Interaxis is a company. Requests do not pass through a company.

## The mistake this document exists to prevent

A Grok-authored brief used "Interaxis" as an architectural prefix — *Interaxis SKU*, *Interaxis
order contract*, *Interaxis data model*. Building from it, an early draft of the product catalogue
shipped `InteraxisSku`, `buildInteraxisSku` and an `IX-` SKU prefix.

That is a real cost, not a cosmetic one: a contract named after the owning company makes every
consumer of a portable package depend on a corporate identity in order to describe a product. If the
company is ever renamed, restructured, or the engines licensed to a shop that has never heard of
Interaxis, the name is a liability in every type signature.

Corrected to `ProductSku`, `buildProductSku`, `SKU-` — and a portability guard now fails the build
if `interaxis` appears in any non-comment source.

## The symmetrical mistake

Do **not** solve it by renaming to `ProWorksX`. A portable engine cannot require whichever host
happens to ship first. ForgeIQ must not need ProWorks Hub; WorkOrderIQ must be independently
consumable; MakerOps may *author* a `ProductDefinition`, but ForgeIQ consumes the **portable
contract**, never MakerOps.

```
MakerOps ─┐
KSix     ─┼─► shared contract ─► ForgeIQ
future   ─┘
```

A second guard checks that no exported contract type is named for an application.

## Naming rule

Domain contracts are named for **what they are**, not who owns or ships them:

`CanonicalProduct` · `ProductSku` · `ProductDefinition` · `SalesChannel` · `ChannelListing` ·
`ExternalOrder` · `NormalizedOrder` · `ManufacturingPlan` · `CostResult` · `DecisionContext` ·
`WorkOrder` · `OrderTrackingSnapshot`

Company and application names are legitimate in: package scope (`@proworks-hub/*`, a registry
namespace), copyright headers, documentation, host adapter names (`ksixOrderTrackingSource`), and
channel *values* (`"etsy"`, `"ksix"` — data, not structure).

## Where a new capability belongs

| Question | Answer |
|---|---|
| Owns a major independent business domain with reusable intelligence? | **Engine** |
| Functionality within an existing domain? | **Module** |
| Infrastructure everyone needs? | **Shared platform service** |
| Presentation or workflow for one application? | **Host feature** |

Applied: idea tracker → **module** (ProWorks). Tracking, notifications, order ingestion → **shared
services**. Event bus → **platform infrastructure**.

**Not every feature becomes an IQ engine.** Order ingestion was briefly built as `OrderIQ` and
renamed to `order-ingestion`: it normalizes, deduplicates and resolves identity — plumbing, not
domain intelligence.
