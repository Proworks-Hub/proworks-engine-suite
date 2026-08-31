<!-- Copyright © 2026 Steven Kreutzer. All Rights Reserved. -->
# Engine Promotion Evaluation

**Date:** 2026-08-31 · **Subjects:** the twelve Architecture Engine specialist modules
**Recommendation: promote none of them. All twelve stay modules.**

Per §V of the build directive, nothing is promoted during this run. This records the evaluation so the next person does not have to redo it.

---

## The test

A component earns engine status only if it owns a durable independently meaningful responsibility, owns significant state, needs independent lifecycle, has independent consumers, needs independent failure handling, exposes stable capabilities beyond the parent's internals, would gain resilience from independent deployment, and — the one that decides most cases — **would reduce ambiguity rather than create engine sprawl.**

## Result

| Module | Owns state? | Independent consumers? | Verdict |
|---|---|---|---|
| ReferenceIQ | No | No | **Module** |
| ConformanceIQ | No | No | **Module** |
| ArchitectureFitnessIQ | No | CI only | **Module** |
| StableIdentityIQ | The retired-id register (not yet built) | No | **Module — watch** |
| ContractCompatibilityIQ | No | No | **Module** |
| DependencyAssuranceIQ | No | No | **Module** |
| CertificationIQ | Certification profiles + history | Potentially Governance | **Module — watch** |
| BenchmarkIQ | Benchmark run history | Potentially Foundry | **Module — watch** |
| KnowledgePackageIQ | No | No | **Module** |
| ArchitectureDriftIQ | No | No | **Module** |
| MigrationIQ | No | No | **Module** |
| ArchitectureProvenanceIQ | No | No | **Module** |

**Every module is currently a pure function over supplied facts.** Not one owns persistent state, holds a lifecycle, or has a consumer that is not the Architecture Engine itself. Promoting any of them today would create twelve deployables to answer questions one library already answers — the engine sprawl the test exists to prevent.

## The three worth watching, and what would change the answer

**StableIdentityIQ** — becomes an engine the day the retired-id register is durable. A register that must never lose an entry, and that outlives every component it records, is real state with a real integrity requirement. It has none today; ids are checked against a list passed in.

**CertificationIQ** — becomes an engine when certification results must be *retained* rather than recomputed. The moment somebody asks "was this certified when we shipped it?", the answer has to have been stored at the time, and that is a state boundary. Note it would still never authorize: an engine that could gate a release holds a power nobody granted it.

**BenchmarkIQ** — becomes an engine when benchmark history is kept for regression comparison. A single run is a function; a time series is state, and comparing against last quarter is the whole point.

## What would be wrong about promoting early

Each of these would ship a deployable, a lifecycle, a failure mode and an operational surface, in exchange for a capability the library already provides synchronously and correctly. The Hive would be measurably more complex and no more capable — and the manifesto's own promotion test names that outcome as the thing to avoid.

**Recommendation: revisit when any of the three acquires durable state, and not before.**
