<!-- Copyright © 2026 Steven Kreutzer. All Rights Reserved. -->
# CostIQ — V5 Conformance Matrix

**P4 subject.** Chosen for meaningful contracts, real tests, manageable consequence, and for *not* being the most constitutionally dangerous engine to attempt first.

**Result: adapted, not rewritten. Zero lines of CostIQ changed.**

## The finding that decided the approach

CostIQ already had `src/charter.ts` declaring its classification, what it owns, and what it deliberately does not own **with the engine that owns each instead** — written before V5 existed. It also carries an `arrivesAs` field per exclusion, recording the plausible request that would drag that responsibility in ("somebody will ask CostIQ to pick the price because it already knows the cost"). **That is richer than anything the standard requires.**

Rewriting it into the standard's shape would have destroyed a better artifact to satisfy a newer one. The migration is a translation.

| Requirement | Status | Evidence |
|---|---|---|
| Charter, classification, ownership | **COMPLIANT** | `costiq/src/charter.ts`, pre-existing |
| Explicit non-ownership with owner named | **COMPLIANT** — exceeds standard | `COSTIQ_DOES_NOT_OWN` incl. `arrivesAs` |
| Stable identity | **COMPLIANT** | `hive.costiq` |
| Runtime metadata | **COMPLIANT** via adapter | `adaptCharterToRuntime` |
| Dependency direction | **COMPLIANT** | depends only on `contracts` + `zod` |
| No Control Center / Studio / Architecture Engine dependency | **COMPLIANT** | ARCH-DEP-* all PASS |
| Maturity declared honestly | **COMPLIANT** | `INTEGRATED` (M4) — proven through the ForgeIQ → CostIQ → Prime vertical slice; **not** CERTIFIED |
| Capability declarations | **GAP** | Empty, and correctly so — see below |
| Collaboration contract (offers/requires) | **GAP** | Not yet declared by the engine |
| SLO / resource profile | **GAP** | Perf budgets exist (`src/perf`) but are not expressed as an SLO profile |
| Certification evidence | **GAP** | `src/certification.ts` exists; not yet bound to a CertificationIQ profile |
| Knowledge Package | **PARTIAL** | Charter and certification modules exist; no Volume structure |
| Conflicts | **NONE** | — |

## Why the capability surface is empty rather than populated

A charter records **responsibility**; it does not describe a **capability surface**. Generating capability declarations from responsibility statements would fabricate an interface nobody wrote — the same failure as adding an event mapping before its emitter exists, and it would have produced a conformance report that looked more complete than the engine.

An adapted engine therefore passes the charter and identity rules and is **visibly silent on capabilities**, which is true. CostIQ declares its capabilities when CostIQ declares them.

## What was deliberately not done

No folder restructuring. No renaming. No behaviour change. No test rewritten. `git diff` on `packages/costiq` is empty, and that is the result, not a shortcut around it.
