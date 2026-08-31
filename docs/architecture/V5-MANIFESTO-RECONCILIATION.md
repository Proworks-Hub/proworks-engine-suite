<!-- Copyright © 2026 Steven Kreutzer. All Rights Reserved. -->
# V5 Manifesto Reconciliation

**Date:** 2026-08-31 · **Repository at:** `bb4c608` → `8903190`
**Sources:** Hive Foundational Architecture Manifesto V5; Manifesto Implementation Build Package V1

Every mismatch between the manifesto and the repository, classified. The rule throughout: **the repository is implementation evidence, the Constitution defines authority, and the manifesto defines the engineering standard.** Where they disagree about *authority*, the repository's ratified decisions win and the difference is recorded rather than resolved.

---

## A finding about the source material itself

**Most of V5's `02_Standards/` documents are one-paragraph stubs**, 300–800 bytes each. `ARCHITECTURE_FITNESS_TEST_STANDARD_V3.md` is a single sentence listing rule topics. `CANONICAL_ENGINE_ANATOMY_V3.md`, `COLLABORATION_CONTRACT_STANDARD.md`, `DEPENDENCY_CONSTITUTION_V3.md` and nine others are the same shape.

This is **not** a defect in the package — it is a specification *index*, and the substance lives in the 49KB manifesto and the 38-rule traceability matrix. It is recorded because it changes what "implement the standards" can honestly mean: the standards were implemented **from the manifesto body and the traceability matrix**, not from the stub files, and anywhere the stub is the only source, the implementation is a reasonable reading rather than a transcription.

`DOCUMENTATION_GAP` — the stubs, not the code.

---

## Classification

### MATCH — already true before this work

| Manifesto requirement | Repository evidence |
|---|---|
| §6 Separation of powers; Governance authorizes, Fabric connects, Prime coordinates | `hiveClassification.ts` models the constitutional and capability planes as separate, with `tierFor()` returning `null` for constitutional components rather than a plausible tier |
| §5 Connectivity is not authority | Neural Fabric's `grantsCompose(): false`; route ≠ permission asserted throughout |
| TR-004 Governance before protected capability resolution | DEC-024 already implemented: `governance` is a required option in `core-kit/coordinator.ts`, and `createDenyAllGovernance()` is the only way to express "no governance" |
| §10 Evidence as first-class | AuditIQ and EventIQ hold authoritative evidence and event responsibilities |
| §32 UI never authority | The Control Center observes and never runs the Hive; a portability guard prevents engines importing it |
| Delivery semantics honesty | `EFFECTIVELY_ONCE` already replaced `EXACTLY_ONCE` across the platform |

**The Hive already satisfied more of V5 than V5 assumes.** Several requirements the manifesto presents as new were ratified here months earlier under their own decision records.

### PARTIAL

| Requirement | State |
|---|---|
| §4 Every canonical participant conforms to the Common Runtime | Standard now exists (`@proworks-hub/hive-runtime`); **1 of 64 packages has adopted it.** The other 63 are in a recorded backlog, not silently passing |
| §40 Maturity model | `M0`–`M7` implemented as `maturityLevelSchema`; not yet declared per existing engine |
| §14/§26 World-class scorecard, benchmarks | BenchmarkIQ not built. **No world-class claim is made anywhere in this work**, which §27 requires |

### IMPLEMENTATION_GAP — built under this directive

Common Runtime contracts and reference kit · Architecture Engine · Golden Reference chamber and engine · Conformance chamber · rule catalog with traceability citations · fitness gates running in the existing suite.

### IMPLEMENTATION_GAP — not yet built

`ContractCompatibilityIQ` · `DependencyAssuranceIQ` (partially covered by three dependency rules) · `CertificationIQ` · `BenchmarkIQ` · `KnowledgePackageIQ` · `ArchitectureDriftIQ` · `MigrationIQ` · `ArchitectureProvenanceIQ` · P4 real-engine migration · P6 Control Center architecture surface · P7 family adoption.

### ARCHITECTURE_CONFLICT

**None found.** This is the finding I expected to have to write and did not.

The one place a conflict looked likely was §31 "Architecture Layers Without Dependency Chains" against this repository's `ALLOWED_DEPENDENCIES` matrix, which *is* a dependency chain. They do not conflict: §31 forbids a layer model from *implying* runtime dependency, and `ALLOWED_DEPENDENCIES` constrains *compile-time imports* — which is stricter than the conceptual hierarchy and deliberately so, as its own source comment explains. Different questions.

Per the directive's non-negotiable rule, **no engine was moved between layers**, and the numbered manifesto views were not read as a mandatory dependency tree.

### HISTORICAL_DIFFERENCE

The manifesto uses "Overwatch" as a layer name. This repository deliberately refuses to make Overwatch a component or an enum member: it is the relationship formed by Governance + Sentinel + Evolution, and `OVERWATCH_MEMBERS` has exactly three entries — ARIA is not among them. `hiveClassification.ts` states the reasoning: *naming it invites building it, and the thing built would not be the concept.*

**Not a conflict.** The manifesto uses the word descriptively; the repository declines to make it a thing. Both positions are preserved, and CC-ADR-001's layer band is named `constitutional` rather than `overwatch` for exactly this reason.

### NOT_APPLICABLE

Multi-language runtime kits (§4's Python example) — the Hive is TypeScript today. The standard is deliberately data-only so a second language needs no shared base class, which is the property that makes this NOT_APPLICABLE rather than a gap.

---

## Traceability coverage, stated honestly

**38 manifesto rules ingested** (`TR-001`–`TR-038`, verbatim ids). **11 architecture rules** in the catalog cite **9 distinct** TR sources.

**29 of 38 manifesto rules have no implementing architecture rule yet.** That number is computed by `uncoveredTraceabilityRules()` and asserted by a test to be greater than zero — a traceability matrix that listed only what it already covered would show 100% forever, which is the shape of every traceability document nobody trusts.

---

## Conformance, first run

| Status | Count |
|---|---:|
| PASS | 199 |
| FAIL | **0** |
| UNKNOWN | **0** |
| NOT_APPLICABLE | 315 |

315 is the adoption backlog: 63 packages × 5 declaration rules, each reported with the reason it is out of scope. It should shrink through P7 and must only ever reach zero by adoption, never by widening the exemption.
