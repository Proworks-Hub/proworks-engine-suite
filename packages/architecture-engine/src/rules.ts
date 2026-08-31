// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { architectureRuleSchema, type ArchitectureRule } from "@proworks-hub/hive-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// The architecture rule catalog.
//
// Each rule carries a permanent `ARCH-*` id and cites the manifesto
// traceability id (`TR-*`) it comes from. The citation is what makes a finding
// arguable: an engineer told their package fails ARCH-DEP-NO-CONTROL-CENTER
// can go read TR-021 and disagree with the rule rather than only with the
// tool.
//
// SEVERITY IS NOT A MEASURE OF IMPORTANCE. It is a measure of how
// deterministic the check is. TR-004 (Governance before capability resolution)
// is the most constitutionally serious rule here and is an ENGINEERING_GATE
// only because it is checked against a DECLARATION, which is mechanical. The
// rules kept ADVISORY are the ones whose evaluation currently involves
// judgement — blocking a build on a judgement teaches people to bypass the
// build.
// ─────────────────────────────────────────────────────────────────────────────

const RULES: readonly unknown[] = [
  {
    id: "ARCH-ID-UNIQUE",
    source: "TR-013",
    rule: "Every canonical participant declares a stable id, and no two share one.",
    severity: "ENGINEERING_GATE",
    owner: ["Architecture Engine", "StableIdentityIQ"],
    verification: ["Collect declared ids across the workspace; assert uniqueness."],
    evidence: ["Conformance report", "Package inventory"],
    remediation: "Rename the newer participant. Never reuse the id of a retired one.",
  },
  {
    id: "ARCH-ID-NO-REUSE",
    source: "TR-013",
    rule: "A retired stable id is never reissued to a different participant.",
    severity: "ENGINEERING_GATE",
    owner: ["StableIdentityIQ"],
    verification: ["Compare declared ids against the retired-id register."],
    evidence: ["Retirement register", "Conformance report"],
    remediation:
      "Choose a new id. History resolves through retired ids, so reuse silently rewrites the past.",
  },
  {
    id: "ARCH-DEP-NO-CONTROL-CENTER",
    source: "TR-021",
    rule: "No engine depends on the Control Center.",
    severity: "ENGINEERING_GATE",
    owner: ["Architecture Engine", "DependencyAssuranceIQ"],
    verification: ["Read package dependencies; assert no engine requires the control plane."],
    evidence: ["Dependency graph"],
    remediation:
      "The Control Center observes engines; an engine that imports it cannot be deployed without its own console, and is no longer portable.",
  },
  {
    id: "ARCH-DEP-NO-STUDIO",
    source: "TR-021",
    rule: "No engine depends on Platform Studio or any host UI.",
    severity: "ENGINEERING_GATE",
    owner: ["DependencyAssuranceIQ"],
    verification: ["Read package dependencies; assert no engine requires a UI surface."],
    evidence: ["Dependency graph"],
    remediation: "A projection is never a dependency. Invert it: the surface reads the engine.",
  },
  {
    id: "ARCH-DEP-ENGINE-ISOLATION",
    source: "TR-002",
    rule: "No engine takes the Architecture Engine as a runtime dependency.",
    severity: "ENGINEERING_GATE",
    owner: ["Architecture Engine"],
    verification: ["Read package dependencies; assert no participant requires this engine."],
    evidence: ["Dependency graph", "Self-test report"],
    remediation:
      "Conformance is evaluated from outside. An engine that needs the evaluator in order to run has made an assurance system into a runtime parent, and its outage becomes everyone's.",
  },
  {
    id: "ARCH-GOV-FIRST",
    source: "TR-004",
    rule:
      "A capability with a consequential side effect declares that it requires authorization, so Governance decides before the capability resolves.",
    severity: "ENGINEERING_GATE",
    owner: ["Governance", "ConformanceIQ"],
    verification: ["Inspect capability declarations; assert consequential effects are protected."],
    evidence: ["Participant declaration", "Governance/AuditIQ evidence"],
    remediation:
      "Set requiresAuthorization. Resolving first and checking second leaks which capabilities exist to a caller who was refused.",
  },
  {
    id: "ARCH-RUNTIME-METADATA",
    source: "TR-007",
    rule: "Every canonical participant declares Common Hive Runtime metadata.",
    severity: "ENGINEERING_GATE",
    owner: ["Architecture Engine"],
    verification: ["Parse the declaration against participantRuntimeSchema."],
    evidence: ["Participant declaration"],
    remediation: "Declare identity, charter, maturity, runtime state and collaboration contract.",
  },
  {
    id: "ARCH-COLLAB-CONTRACT",
    source: "TR-009",
    rule:
      "Every runtime dependency states what the participant does when it is unavailable.",
    severity: "ENGINEERING_GATE",
    owner: ["Engine owner", "ConformanceIQ"],
    verification: ["Assert whenUnavailable is present for every non-development dependency."],
    evidence: ["Collaboration contract"],
    remediation:
      "Name the reduced function. 'Degrades gracefully' is not a behaviour anyone can plan around.",
  },
  {
    id: "ARCH-CHARTER-BOUNDARY",
    source: "TR-008",
    rule: "Every charter states what the participant does NOT own.",
    severity: "ENGINEERING_GATE",
    owner: ["Engine owner"],
    verification: ["Assert charter.doesNotOwn is non-empty."],
    evidence: ["Charter", "Knowledge Package"],
    remediation:
      "A charter with no edges acquires responsibilities by drift, each step reasonable, with no moment anyone can point at.",
  },
  {
    id: "ARCH-EVIDENCE-REQUIRED",
    source: "TR-030",
    rule: "A conformance finding that fails states the facts observed.",
    severity: "ENGINEERING_GATE",
    owner: ["ConformanceIQ"],
    verification: ["Assert FAIL and WARN findings carry facts."],
    evidence: ["Conformance report"],
    remediation: "State what was observed, so the finding can be argued with rather than obeyed.",
  },
  {
    id: "ARCH-MATURITY-HONEST",
    source: "TR-034",
    rule:
      "A participant claiming INTEGRATED or above declares at least one evidence reference.",
    severity: "ADVISORY",
    owner: ["CertificationIQ"],
    verification: ["Assert evidenceRefs is non-empty at maturity >= INTEGRATED."],
    evidence: ["Knowledge Package", "Test results"],
    remediation:
      "Advisory because absent evidence may mean the reference is recorded elsewhere; it is a prompt to look, not a verdict.",
  },
];

/** The catalog, validated at module load so a malformed rule fails loudly. */
export const ARCHITECTURE_RULES: readonly ArchitectureRule[] = RULES.map((r) =>
  architectureRuleSchema.parse(r),
);

export function ruleById(id: string): ArchitectureRule | undefined {
  return ARCHITECTURE_RULES.find((r) => r.id === id);
}
