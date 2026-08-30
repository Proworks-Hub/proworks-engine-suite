/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/charter.ts
 * Module:   neural-fabric
 * Purpose:  What this is, what it refuses to be, and the ratification it has not had.
 */

// ─────────────────────────────────────────────────────────────────────────────
// THIS IS NOT A CORE, AND THE CODE SAYS SO
//
// The architecture plan is emphatic on the point (§3): the name "Neural Fabric
// Core" describes foundational importance, not constitutional standing. The
// Hive has an approved nine-Core architecture. This is a PROPOSED peer
// infrastructure system, and formal placement is a human constitutional
// decision that has not been taken.
//
// So the classification here is `PROPOSED_COORDINATION_PLANE`, which is
// deliberately NOT a member of `HiveClassification` in the contracts package.
// It cannot be, because adding it there would be the ratification this
// document declines to perform. A guard below asserts it, so the day somebody
// wires this into the Core registry, a test fails and says why.
//
// A CONFLICT THAT ENGINEERING CANNOT RESOLVE
//
// `packages/contracts/src/hiveClassification.ts` records an existing decision:
//
//     "The Information Fabric has no classification. It is the governed
//      communication substrate formed from Communication Core, EventIQ, engine
//      contracts, IntegrationIQ, Governance, IdentityIQ, AuditIQ and Prime.
//      There is no single component to classify, and building one would
//      centralize exactly what the Fabric exists to keep distributed."
//
// That was written about the INFORMATION Fabric — communication semantics,
// participants, intent, consent, evidence. This package is the NEURAL Fabric:
// topology, routing, delivery, congestion, failure domains, transport
// coordination. §2 of the plan distinguishes them at length, and they are
// genuinely different layers.
//
// But the warning in that note applies here too, and it would be dishonest to
// pretend otherwise: a component that every signal traverses is a component
// that can quietly become an authority. §3 says the same thing in its own
// words — "Neural Fabric must never become a hidden authority layer merely
// because many signals traverse it."
//
// Engineering cannot settle whether these two decisions conflict. What it can
// do is refuse to settle it by accident, which is what this file is for. The
// tension is recorded as data (`UNRESOLVED_CONSTITUTIONAL_QUESTIONS`) so a
// reviewer meets it rather than discovering it.
//
// NOT ATTACHED TO PRIME
//
// Prime coordinates authorized work. This carries signals. The plan's answer
// to "why not Prime" (§2) is that Prime is a conductor and the Fabric is the
// nervous system — and a nervous system that reported to the conductor would
// have made the conductor into the brain.
//
// Structurally: this package depends on NOTHING in the suite. Not contracts,
// not platform-runtime, not Prime. Its only dependency is zod. That is not
// minimalism for its own sake — it is the only way to guarantee that a
// dependency edge to Prime cannot appear by accident, and it makes the
// portability claim checkable rather than asserted. Everything it needs from
// the Hive arrives through a port.
// ─────────────────────────────────────────────────────────────────────────────

export const NEURAL_FABRIC_CHARTER_VERSION = "neural-fabric.charter.v3-draft" as const;

/**
 * Where this sits, pending a decision nobody has made yet.
 *
 * A string literal rather than a `HiveClassification`, because it is not one
 * and must not be assignable to one. The type system carries the constitutional
 * fact.
 */
export const NEURAL_FABRIC_CLASSIFICATION = "PROPOSED_COORDINATION_PLANE" as const;
export type NeuralFabricClassification = typeof NEURAL_FABRIC_CLASSIFICATION;

/** The classifications that exist in the ratified vocabulary. Copied, not imported. */
export const RATIFIED_CLASSIFICATIONS: readonly string[] = Object.freeze([
  "CONSTITUTIONAL_GOVERNANCE",
  "CONSTITUTIONAL_SENTINEL",
  "CONSTITUTIONAL_EVOLUTION",
  "CONSTITUTIONAL_INTELLIGENCE",
  "CONSTITUTIONAL_ORCHESTRATION",
  "CORE",
  "SHARED_PLATFORM",
  "SPECIALIZED",
  "INDUSTRY",
]);

/**
 * Whether Neural Fabric currently holds a ratified constitutional placement.
 *
 * Always false, and a function rather than a comment so CI asserts it. The
 * moment this needs to return true, a human has made a constitutional decision
 * and this file changes as part of it — deliberately, and in a diff somebody
 * reviews.
 */
export function isRatifiedClassification(): false {
  return false;
}

/** True if the proposed classification has leaked into the ratified vocabulary. */
export function classificationLeakedIntoRegistry(vocabulary: readonly string[]): boolean {
  return vocabulary.includes(NEURAL_FABRIC_CLASSIFICATION);
}

export interface OwnedResponsibility {
  readonly id: string;
  readonly summary: string;
  /** The chamber that holds it. Nexus owns structure; Pulse owns flow. */
  readonly chamber: "NEXUS" | "PULSE" | "BOTH";
}

export interface ExcludedResponsibility {
  readonly id: string;
  readonly summary: string;
  readonly ownedBy: string;
  /**
   * The plausible request that would drag Neural Fabric in.
   *
   * The same device the CostIQ charter uses, for the same reason: boundaries
   * are crossed by reasonable ideas that belong somewhere else, and writing
   * the reasonable version down is what lets a reviewer recognise it.
   */
  readonly arrivesAs: string;
}

export const NEURAL_FABRIC_OWNS: readonly OwnedResponsibility[] = Object.freeze([
  {
    id: "topology.graph",
    summary: "The living topology: nodes, capabilities, zones, locality, adjacency, versions, blast radius.",
    chamber: "NEXUS",
  },
  {
    id: "topology.versioning",
    summary: "Topology snapshots, diff, simulation, activation, rollback and retirement.",
    chamber: "NEXUS",
  },
  {
    id: "route.candidates",
    summary: "Generating the set of routes a signal is PERMITTED to take. Selection within that set is RoutingIQ's.",
    chamber: "NEXUS",
  },
  {
    id: "contract.compatibility",
    summary: "Whether a sender and a receiver can speak to each other on a lane, by schema and version.",
    chamber: "NEXUS",
  },
  {
    id: "flow.health",
    summary: "Heartbeats, latency, saturation, retries, loss, duplicates, dead-letter state and circuit state.",
    chamber: "PULSE",
  },
  {
    id: "flow.control",
    summary: "Backpressure, load shedding, admission control and failover within already-permitted routes.",
    chamber: "PULSE",
  },
  {
    id: "degraded.modes",
    summary: "Partition detection and the defined behaviour when the Collective or a region is unreachable.",
    chamber: "PULSE",
  },
  {
    id: "causal.context",
    summary: "Preserving correlation, causation and trace context across transport hops.",
    chamber: "BOTH",
  },
  {
    id: "explainability",
    summary: "Why a signal took a path, was delayed, was rejected, or arrived twice.",
    chamber: "BOTH",
  },
]);

export const NEURAL_FABRIC_DOES_NOT_OWN: readonly ExcludedResponsibility[] = Object.freeze([
  {
    id: "authority",
    summary: "Deciding whether an action is permitted.",
    ownedBy: "Governance and PolicyIQ",
    arrivesAs:
      "The Fabric already checks authorization evidence on every consequential signal, so it may as well decide when the evidence is obviously sufficient.",
  },
  {
    id: "identity",
    summary: "Cryptographic workload identity, keys, certificates, revocation and trust posture.",
    ownedBy: "Security IQ and IdentityIQ",
    arrivesAs:
      "Every participant has to be identified before it can be routed to, so the Fabric could just issue the identities itself.",
  },
  {
    id: "business.workflow",
    summary: "What work happens next and in what order.",
    ownedBy: "Prime, WorkflowIQ and Operations IQ",
    arrivesAs:
      "The workflow lane already carries durable execution traffic, so the Fabric may as well model the workflow.",
  },
  {
    id: "communication.semantics",
    summary: "Human and business communication: participants, intent, consent, preferences, evidence.",
    ownedBy: "Communication IQ",
    arrivesAs: "Both are about messages, so one of them is redundant.",
  },
  {
    id: "durable.events",
    summary: "The durable event-delivery infrastructure itself.",
    ownedBy: "EventIQ",
    arrivesAs: "The Fabric has an event lane, so it could own the event bus outright.",
  },
  {
    id: "payload.meaning",
    summary: "What the contents of a signal mean.",
    ownedBy: "Whichever engine owns the domain",
    arrivesAs:
      "Reading the payload would let the Fabric route more intelligently — batch related work, drop obviously stale requests.",
  },
  {
    id: "security.response",
    summary: "Detecting threats and deciding the defensive response.",
    ownedBy: "Sentinel, with Security IQ operating the mechanisms",
    arrivesAs:
      "The Fabric sees every signal, so it is the natural place to notice an attack and cut the connection.",
  },
  {
    id: "audit.evidence",
    summary: "The audit record of consequential decisions.",
    ownedBy: "AuditIQ",
    arrivesAs: "The Fabric already emits telemetry for every hop, so audit could just read that.",
  },
  {
    id: "external.adapters",
    summary: "Connectors to third-party business systems.",
    ownedBy: "IntegrationIQ",
    arrivesAs: "The gateway lane already terminates external traffic, so the adapters could live there.",
  },
  {
    id: "artifact.storage",
    summary: "Storing and transferring large files, models and documents.",
    ownedBy: "FileIQ and object storage",
    arrivesAs: "There is an artifact lane, so the Fabric could just carry the bytes.",
  },
  {
    id: "cross.instance.trust",
    summary: "Whether two Hive Instances may collaborate, and on what terms.",
    ownedBy: "Interconnect, with Governance and Security IQ",
    arrivesAs:
      "The Fabric computes cross-instance routes, so it knows which instances are connected and could grant the link.",
  },
  {
    id: "self.evolution",
    summary: "Deploying a change to its own topology or charter.",
    ownedBy: "Foundry Evolution and Governance",
    arrivesAs:
      "Adaptation already produces improvement candidates and simulates them, so applying a well-tested one is the obvious next step.",
  },
]);

/**
 * The hard gates from §33.6, as data.
 *
 * Every one is a statement that can be falsified, and the certification module
 * checks each against the implementation rather than against a promise.
 */
export const HARD_GATES: readonly { readonly id: string; readonly rule: string }[] = Object.freeze([
  { id: "no-lane-bypass", rule: "No signal lane becomes an authorization bypass." },
  {
    id: "fail-closed-on-missing-security",
    rule: "A missing Sentinel or Security dependency never falls through to allow for a protected operation.",
  },
  {
    id: "interconnect-terminated",
    rule: "Cross-instance routes always terminate through explicit governed Interconnect boundaries.",
  },
  {
    id: "no-required-provider",
    rule: "No single transport provider is constitutionally required; provider failure has a defined degraded behaviour.",
  },
  {
    id: "no-self-deploying-topology",
    rule: "No topology adaptation self-deploys outside the Foundry and Governance process.",
  },
  {
    id: "local-continuity",
    rule: "The Fabric remains operational locally during a Collective outage.",
  },
  {
    id: "traceable-without-exposure",
    rule:
      "Every consequential signal remains causally traceable across hops without exposing protected payloads in telemetry.",
  },
]);

/**
 * Questions this build deliberately does not answer.
 *
 * Recorded because the alternative — shipping working code and letting its
 * existence settle the question — is how architecture decisions get made by
 * accident.
 */
export const UNRESOLVED_CONSTITUTIONAL_QUESTIONS: readonly {
  readonly question: string;
  readonly whyEngineeringCannotAnswerIt: string;
}[] = Object.freeze([
  {
    question: "Should Neural Fabric become a tenth constitutional Core?",
    whyEngineeringCannotAnswerIt:
      "§3 reserves this for a human constitutional process after a no-duplication review and charter design. Working code is evidence for that decision, not a substitute for it.",
  },
  {
    question:
      "Does this conflict with the existing decision that the Information Fabric has no single classifiable component?",
    whyEngineeringCannotAnswerIt:
      "That note warns against centralising the substrate. This package is a different layer, and the warning still applies to it. Whether the two decisions are compatible is a governance question about intent, not a question about code.",
  },
  {
    question: "Which of the eight specialist engines deserve to be chartered as engines at all?",
    whyEngineeringCannotAnswerIt:
      "§8 says they are candidates that must each pass the Engine Development Blueprint and a no-duplication test. They are implemented here as modules so the capability exists and the chartering decision stays open.",
  },
]);

export const NEURAL_FABRIC_CHARTER = Object.freeze({
  version: NEURAL_FABRIC_CHARTER_VERSION,
  classification: NEURAL_FABRIC_CLASSIFICATION,
  ratified: false,
  chambers: ["NEXUS", "PULSE"] as const,
  owns: NEURAL_FABRIC_OWNS,
  doesNotOwn: NEURAL_FABRIC_DOES_NOT_OWN,
  hardGates: HARD_GATES,
  unresolved: UNRESOLVED_CONSTITUTIONAL_QUESTIONS,
});
