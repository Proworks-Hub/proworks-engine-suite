// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// GENERATED from manifesto_traceability_v5.json (Manifesto V5, 05_Machine_Specs).
// Verbatim, ids included. Do not renumber: a matrix whose ids were changed on
// import cannot be traced back to the document it came from, which is the one
// thing it exists to do. Regenerate rather than edit.

export const MANIFESTO_TRACEABILITY_V5 = [
  {
    "id": "TR-001",
    "rule": "Constitution outranks engineering standards",
    "why": "Prevents implementation from silently changing constitutional authority.",
    "owner": "Governance + all builders",
    "implementation": "Architecture hierarchy; ADR gates",
    "verification": "Review hierarchy; conflict test",
    "evidence": "Governance/ADR evidence"
  },
  {
    "id": "TR-002",
    "rule": "Manifesto does not reorganize canonical Hive topology",
    "why": "Prevents generic architecture language from moving existing engines.",
    "owner": "Architecture Engine",
    "implementation": "Canonical Hive Map reconciliation",
    "verification": "Architecture drift check",
    "evidence": "Conformance finding + Hive Map evidence"
  },
  {
    "id": "TR-003",
    "rule": "Connected, not entangled",
    "why": "Preserves broad communication without permanent coupling.",
    "owner": "Common Runtime + Neural Fabric",
    "implementation": "Collaboration Contract; ports/capabilities",
    "verification": "Dependency/fitness tests",
    "evidence": "Dependency graph + contract evidence"
  },
  {
    "id": "TR-004",
    "rule": "Governance before protected capability resolution",
    "why": "Prevents capability-existence leakage and authority inversion.",
    "owner": "Governance + capability resolver",
    "implementation": "Governance-first invocation contract",
    "verification": "Negative/refusal integration test",
    "evidence": "AuditIQ/Governance evidence"
  },
  {
    "id": "TR-005",
    "rule": "Neural Fabric provides communication, not authority",
    "why": "Separates transport/routing from permission.",
    "owner": "Neural Fabric + Governance",
    "implementation": "Fabric ports + authorization refs",
    "verification": "Fabric route test with denied request",
    "evidence": "Trace + Governance evidence"
  },
  {
    "id": "TR-006",
    "rule": "Prime coordinates but is not universal transport",
    "why": "Avoids central coupling and sovereignty creep.",
    "owner": "Prime + Neural Fabric",
    "implementation": "Prime orchestration contracts",
    "verification": "Dependency and routing tests",
    "evidence": "Architecture conformance evidence"
  },
  {
    "id": "TR-007",
    "rule": "Every canonical participant conforms to Common Runtime",
    "why": "Makes heterogeneous engines understandable/interoperable.",
    "owner": "Architecture Engine / runtime kits",
    "implementation": "Runtime conformance schema",
    "verification": "Conformance suite",
    "evidence": "Conformance report"
  },
  {
    "id": "TR-008",
    "rule": "Every engine has canonical state ownership",
    "why": "Prevents split brain and hidden shared databases.",
    "owner": "Engine owner + Architecture Engine",
    "implementation": "State ownership declaration",
    "verification": "State-owner uniqueness check",
    "evidence": "State map evidence"
  },
  {
    "id": "TR-009",
    "rule": "Every engine has a Collaboration Contract",
    "why": "Makes cooperation explicit and degradable.",
    "owner": "Engine owner",
    "implementation": "Collaboration Contract schema",
    "verification": "Completeness + dependency tests",
    "evidence": "Knowledge Package"
  },
  {
    "id": "TR-010",
    "rule": "Capabilities are separated from implementations",
    "why": "Allows providers/languages to change without Hive-wide rewrites.",
    "owner": "Capability Library + engine owners",
    "implementation": "Capability contracts + adapters",
    "verification": "Compatibility tests",
    "evidence": "Capability/version evidence"
  },
  {
    "id": "TR-011",
    "rule": "Stable IDs are unique and never recycled",
    "why": "Preserves long-term traceability.",
    "owner": "StableIdentityIQ",
    "implementation": "ID registry/schema",
    "verification": "CI uniqueness/resolution test",
    "evidence": "ID registry report"
  },
  {
    "id": "TR-012",
    "rule": "Compatibility is classified and tested",
    "why": "Prevents accidental breaking changes.",
    "owner": "ContractCompatibilityIQ",
    "implementation": "Compatibility matrix",
    "verification": "Consumer/provider/schema tests",
    "evidence": "Compatibility evidence"
  },
  {
    "id": "TR-013",
    "rule": "Time/TTL/deadline semantics are explicit",
    "why": "Prevents distributed-time ambiguity and stale authority.",
    "owner": "Runtime + engines",
    "implementation": "Time semantics contract",
    "verification": "Clock/replay/expiry tests",
    "evidence": "Test evidence"
  },
  {
    "id": "TR-014",
    "rule": "Consequential effects are idempotent/retry-safe",
    "why": "Prevents duplicated financial/security/external actions.",
    "owner": "Engine owners",
    "implementation": "Delivery + idempotency contract",
    "verification": "Replay/retry tests",
    "evidence": "Execution evidence"
  },
  {
    "id": "TR-015",
    "rule": "Data classification follows contracts/routes",
    "why": "Supports privacy/security and host compliance.",
    "owner": "Security/Privacy owners + Fabric",
    "implementation": "Classification schema",
    "verification": "Route/logging policy tests",
    "evidence": "Classification evidence"
  },
  {
    "id": "TR-016",
    "rule": "Trust boundaries are explicit",
    "why": "Prevents 'inside Hive' from implying trust.",
    "owner": "All engines + Sentinel",
    "implementation": "Trust boundary model",
    "verification": "Threat/adversarial tests",
    "evidence": "Threat model evidence"
  },
  {
    "id": "TR-017",
    "rule": "AI/model output never creates authority",
    "why": "Keeps AI governed.",
    "owner": "ARIA/AI + Governance + Sentinel",
    "implementation": "AI capability boundary",
    "verification": "Prompt injection / escalation tests",
    "evidence": "Audit/Sentinel evidence"
  },
  {
    "id": "TR-018",
    "rule": "Resource use is bounded and observable",
    "why": "Prevents runaway cost/compute and collapse under load.",
    "owner": "Runtime + engine owners",
    "implementation": "Resource/SLO profiles",
    "verification": "Load/backpressure/quota tests",
    "evidence": "Metrics/benchmark evidence"
  },
  {
    "id": "TR-019",
    "rule": "UNKNOWN/STALE remain explicit",
    "why": "Prevents false health/certainty.",
    "owner": "Observability + Control Center",
    "implementation": "Freshness semantics",
    "verification": "Telemetry-loss tests",
    "evidence": "Health evidence"
  },
  {
    "id": "TR-020",
    "rule": "Failure/degraded operation is defined",
    "why": "Ensures safe behavior under dependency loss.",
    "owner": "Every engine",
    "implementation": "Failure contract",
    "verification": "Chaos/dependency-outage tests",
    "evidence": "Failure test evidence"
  },
  {
    "id": "TR-021",
    "rule": "Recovery requires reconciliation/integrity evidence",
    "why": "Prevents trusting restored state blindly.",
    "owner": "Engine owner + Sentinel",
    "implementation": "Recovery contract",
    "verification": "Restore/re-attestation tests",
    "evidence": "Recovery evidence"
  },
  {
    "id": "TR-022",
    "rule": "Human intervention points are explicit",
    "why": "Preserves human rights and escalation paths.",
    "owner": "Governance + engine owner",
    "implementation": "Human Intervention Contract",
    "verification": "Approval/timeout/break-glass tests",
    "evidence": "Governance/Audit evidence"
  },
  {
    "id": "TR-023",
    "rule": "Foundry proposes/tests but does not self-ratify",
    "why": "Prevents evolution engine from becoming sovereign.",
    "owner": "Foundry + Governance",
    "implementation": "Improvement Packet lifecycle",
    "verification": "Promotion-boundary tests",
    "evidence": "Foundry/Governance evidence"
  },
  {
    "id": "TR-024",
    "rule": "Sentinel assures but does not become Governance",
    "why": "Preserves separation of powers.",
    "owner": "Sentinel + Governance",
    "implementation": "Sentinel charter/actions",
    "verification": "Authority-creep tests",
    "evidence": "Sentinel certification evidence"
  },
  {
    "id": "TR-025",
    "rule": "Architecture Engine is not a runtime dependency",
    "why": "Prevents the standards system from becoming a central point of failure.",
    "owner": "Architecture Engine",
    "implementation": "Optional observation/conformance interfaces",
    "verification": "Architecture-engine outage test",
    "evidence": "Resilience evidence"
  },
  {
    "id": "TR-026",
    "rule": "Golden Reference demonstrates; Conformance evaluates",
    "why": "Separates example code from enforcement.",
    "owner": "Architecture Engine",
    "implementation": "Two-chamber architecture",
    "verification": "Self-certification prohibition test",
    "evidence": "Architecture Engine evidence"
  },
  {
    "id": "TR-027",
    "rule": "Architecture tools cannot self-authorize",
    "why": "Avoids self-policing sovereignty.",
    "owner": "Architecture Engine + Governance + Sentinel",
    "implementation": "Governed certification/ratification",
    "verification": "Tamper/self-certification tests",
    "evidence": "Governance + Sentinel evidence"
  },
  {
    "id": "TR-028",
    "rule": "Architecture fitness tests enforce objective invariants",
    "why": "Makes the manifesto living software.",
    "owner": "ArchitectureFitnessIQ + CI",
    "implementation": "Fitness-test suite",
    "verification": "CI execution",
    "evidence": "CI evidence bundle"
  },
  {
    "id": "TR-029",
    "rule": "World-class claims require domain benchmarks",
    "why": "Turns aspiration into measurable engineering.",
    "owner": "BenchmarkIQ + family owners",
    "implementation": "Benchmark Profile",
    "verification": "Reproducible benchmark runs",
    "evidence": "Benchmark evidence"
  },
  {
    "id": "TR-030",
    "rule": "Knowledge Packages remain current and versioned",
    "why": "Keeps code, architecture and operations explainable.",
    "owner": "KnowledgePackageIQ + owners",
    "implementation": "Volume/Book standard",
    "verification": "Drift/completeness checks",
    "evidence": "Knowledge Package evidence"
  },
  {
    "id": "TR-031",
    "rule": "Existing engines migrate by conformance, not mass rewrite",
    "why": "Protects working architecture and lowers migration risk.",
    "owner": "MigrationIQ + engine owners",
    "implementation": "Conformance matrix/adapters",
    "verification": "Representative migration proof",
    "evidence": "Migration evidence"
  },
  {
    "id": "TR-032",
    "rule": "Retirement is a governed lifecycle",
    "why": "Prevents hidden dependency and ID reuse.",
    "owner": "Engine owner + Architecture Engine",
    "implementation": "Sunset protocol",
    "verification": "Consumer/no-hidden-dependency checks",
    "evidence": "Retirement evidence"
  },
  {
    "id": "TR-033",
    "rule": "Hive Instances retain local autonomy",
    "why": "Prevents unnecessary Collective sovereignty.",
    "owner": "Instance/runtime + Interconnect",
    "implementation": "Instance continuity contracts",
    "verification": "Collective/Fabric partition tests",
    "evidence": "Instance resilience evidence"
  },
  {
    "id": "TR-034",
    "rule": "Private data is not promoted to Collective by default",
    "why": "Protects tenants and regulated data.",
    "owner": "Instance + Privacy/Sentinel",
    "implementation": "Promotion/minimization rules",
    "verification": "Exfiltration/promotion tests",
    "evidence": "Audit/Sentinel evidence"
  },
  {
    "id": "TR-035",
    "rule": "Control Center/Studio are projections, not authority",
    "why": "Prevents UI state from becoming canonical control logic.",
    "owner": "Control Plane + Governance",
    "implementation": "BFF/read-model boundaries",
    "verification": "Direct-store/authorization tests",
    "evidence": "Control Center evidence"
  },
  {
    "id": "TR-036",
    "rule": "Specification is language-neutral",
    "why": "Keeps the Hive evolvable beyond TypeScript.",
    "owner": "Architecture Engine",
    "implementation": "Semantic contracts + language kits",
    "verification": "Cross-language conformance test",
    "evidence": "Conformance evidence"
  },
  {
    "id": "TR-037",
    "rule": "Technical debt is classified and visible",
    "why": "Prevents architectural/security debt from disappearing.",
    "owner": "Architecture Engine + Foundry",
    "implementation": "Debt records",
    "verification": "Certification/debt-policy checks",
    "evidence": "Debt registry evidence"
  },
  {
    "id": "TR-038",
    "rule": "Another qualified engineer can understand the component",
    "why": "Eliminates tribal knowledge.",
    "owner": "KnowledgePackageIQ + owner",
    "implementation": "Explainability/transferability standard",
    "verification": "Independent handoff review",
    "evidence": "Review evidence"
  }
] as const;
