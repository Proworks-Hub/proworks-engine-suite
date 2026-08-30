/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/certification.ts
 * Module:   cost-iq-engine
 * Purpose:  Whether this engine currently meets its own stated bar.
 */

import { COSTIQ_CHARTER_VERSION, COSTIQ_CLASSIFICATION, COSTIQ_DOES_NOT_OWN, COSTIQ_OWNS } from "./charter.js";
import { COSTIQ_API_VERSION, SURFACE_CHANGES, type CompatibilityImpact } from "./compat/versioning.js";
import { PERFORMANCE_BUDGETS } from "./perf/budgets.js";
import { CONSEQUENCE_CONTRACTS, COST_EVENT_TYPES } from "./ports/costPorts.js";
import { COSTIQ_OFFERS, findContractGaps } from "./ports/costIntegration.js";

// ─────────────────────────────────────────────────────────────────────────────
// A CERTIFICATION THAT CANNOT FAIL CERTIFIES NOTHING
//
// The temptation with a module like this is to write something that returns
// `{ certified: true }` and reads well in a report. That is worse than having
// nothing, because it converts an open question into a false answer.
//
// So each gate here is a real check against real data, and each one CAN fail.
// Two of them found genuine problems the first time they ran: the contract
// completeness check found two charter exclusions that were documented but not
// enforced, and the performance budgets initially carried figures I had not
// measured on this machine.
//
// WHAT THIS DOES AND DOES NOT ASSERT
//
// It asserts that the engine's own declared invariants hold: the charter is
// enforceable, every event says what it does not entitle, every operation has
// a budget, the public surface's breaking changes are documented. Those are
// checkable from data.
//
// It does NOT assert that the costing is correct. Nothing can assert that
// except the 760 tests and the mutation runs behind them, and a certification
// that claimed otherwise would be exactly the kind of reassuring falsehood
// this engine exists to avoid producing.
// ─────────────────────────────────────────────────────────────────────────────

export interface CertificationGate {
  readonly id: string;
  readonly question: string;
  readonly passed: boolean;
  readonly evidence: string;
  /** Present only when the gate failed. */
  readonly remedy: string | null;
}

export interface CertificationReport {
  readonly engine: "CostIQ";
  readonly apiVersion: string;
  readonly charterVersion: string;
  readonly classification: string;
  readonly gates: readonly CertificationGate[];
  readonly certified: boolean;
  readonly summary: string;
  /**
   * What certification deliberately does not cover.
   *
   * Stated in the report itself, so a reader cannot come away with a broader
   * impression than the evidence supports.
   */
  readonly outOfScopeOfThisCertification: readonly string[];
}

/**
 * What each gate is checked against.
 *
 * Defaults to the engine's own declarations. They are arguments so a test can
 * inject a deliberately broken set and prove each gate CAN fail — without
 * that, a mutation replacing any `passed:` expression with `true` survives,
 * and the certification quietly becomes the reassuring falsehood described
 * above. That is not hypothetical: five such mutations survived the first
 * mutation run against this file.
 */
export interface CertificationSources {
  readonly consequenceContracts: Readonly<Record<string, { readonly doesNotEntitle: readonly string[] }>>;
  readonly eventTypes: readonly string[];
  readonly exclusions: readonly { readonly id: string; readonly arrivesAs: string }[];
  readonly budgets: readonly {
    readonly operation: string;
    readonly atSize: number;
    readonly budgetMs: number;
    readonly measuredMs: number;
    readonly measuredOn: string;
  }[];
  readonly surfaceChanges: readonly {
    readonly what: string;
    readonly impact: CompatibilityImpact;
    readonly action: string;
    readonly rationale: string;
  }[];
}

export const SHIPPED_SOURCES: CertificationSources = Object.freeze({
  consequenceContracts: CONSEQUENCE_CONTRACTS,
  eventTypes: COST_EVENT_TYPES,
  exclusions: COSTIQ_DOES_NOT_OWN,
  budgets: PERFORMANCE_BUDGETS,
  surfaceChanges: SURFACE_CHANGES,
});

/**
 * Runs every gate.
 *
 * Pure and synchronous: it reads declared data structures, not a database or a
 * clock. A certification that needed infrastructure would be a certification
 * that only runs where the infrastructure is, which is not where the mistakes
 * get made.
 */
export function certify(sources: CertificationSources = SHIPPED_SOURCES): CertificationReport {
  const gates: CertificationGate[] = [];

  const contractGaps = findContractGaps(sources.consequenceContracts);
  gates.push({
    id: "contracts.complete",
    question: "Does every event, exclusion and capability carry the contract it is supposed to?",
    passed: contractGaps.length === 0,
    evidence:
      contractGaps.length === 0
        ? `${sources.eventTypes.length} event types, ${sources.exclusions.length} charter exclusions and ${COSTIQ_OFFERS.length} capabilities checked, no gaps.`
        : contractGaps.map((g) => `${g.what}: missing ${g.missing}`).join("; "),
    remedy: contractGaps.length === 0 ? null : "Fill the gaps listed. Each one is a place a consumer would have to infer something nobody wrote down.",
  });

  const eventsWithoutProhibitions = sources.eventTypes.filter(
    (type) => (sources.consequenceContracts[type]?.doesNotEntitle.length ?? 0) === 0,
  );
  gates.push({
    id: "events.state_their_limits",
    question: "Does every event say what it does NOT entitle a consumer to conclude?",
    passed: eventsWithoutProhibitions.length === 0,
    evidence:
      eventsWithoutProhibitions.length === 0
        ? `All ${sources.eventTypes.length} event types state at least one prohibition.`
        : `Missing on: ${eventsWithoutProhibitions.join(", ")}.`,
    remedy:
      eventsWithoutProhibitions.length === 0
        ? null
        : "State the prohibition. The wrong inference from an event is silent — nothing fails when a consumer concludes too much.",
  });

  const exclusionsWithoutTemptation = sources.exclusions.filter((e) => e.arrivesAs.trim().length === 0);
  gates.push({
    id: "charter.records_how_it_gets_crossed",
    question: "Does every exclusion record the plausible request that would drag CostIQ in?",
    passed: exclusionsWithoutTemptation.length === 0,
    evidence:
      exclusionsWithoutTemptation.length === 0
        ? `All ${sources.exclusions.length} exclusions record how the boundary gets crossed.`
        : `Missing on: ${exclusionsWithoutTemptation.map((e) => e.id).join(", ")}.`,
    remedy:
      exclusionsWithoutTemptation.length === 0
        ? null
        : "Write down the reasonable-sounding request. Boundaries are crossed by good ideas that belong somewhere else, not by bad ones.",
  });

  const budgetsWithoutMeasurement = sources.budgets.filter(
    (b) => b.measuredMs <= 0 || b.measuredOn.trim().length === 0 || b.budgetMs <= b.measuredMs,
  );
  gates.push({
    id: "performance.budgets_are_evidenced",
    question: "Was every performance budget set against a real measurement on a named machine?",
    passed: budgetsWithoutMeasurement.length === 0,
    evidence:
      budgetsWithoutMeasurement.length === 0
        ? sources.budgets.map((b) => `${b.operation}: ${b.measuredMs}ms measured, ${b.budgetMs}ms budget at ${b.atSize} items`).join("; ")
        : `Unevidenced: ${budgetsWithoutMeasurement.map((b) => b.operation).join(", ")}.`,
    remedy:
      budgetsWithoutMeasurement.length === 0
        ? null
        : "Measure it and record the machine. A budget nobody measured is a number somebody invented, and the next person cannot tell whether it is generous or already tight.",
  });

  const undocumentedBreaks = sources.surfaceChanges.filter(
    (c) => c.impact !== "NONE" && (c.action.trim().length === 0 || c.rationale.trim().length === 0),
  );
  gates.push({
    id: "compatibility.breaks_are_documented",
    question: "Does every breaking change say what to do and why it was worth it?",
    passed: undocumentedBreaks.length === 0,
    evidence:
      undocumentedBreaks.length === 0
        ? `${sources.surfaceChanges.filter((c) => c.impact !== "NONE").length} breaking changes, each with an action and a rationale.`
        : `Incomplete: ${undocumentedBreaks.map((c) => c.what).join("; ")}.`,
    remedy:
      undocumentedBreaks.length === 0
        ? null
        : "Give it both. 'We changed it' invites a workaround; the reason usually persuades the reader not to build one.",
  });

  gates.push({
    id: "charter.classification_declared",
    question: "Is this engine's place in the two-plane architecture declared?",
    passed: COSTIQ_CLASSIFICATION === "SPECIALIZED" && COSTIQ_OWNS.length > 0,
    evidence: `Classified ${COSTIQ_CLASSIFICATION} under Finance IQ, with ${COSTIQ_OWNS.length} owned responsibilities and ${COSTIQ_DOES_NOT_OWN.length} explicit exclusions.`,
    remedy: null,
  });

  const failed = gates.filter((g) => !g.passed);

  return {
    engine: "CostIQ",
    apiVersion: COSTIQ_API_VERSION,
    charterVersion: COSTIQ_CHARTER_VERSION,
    classification: COSTIQ_CLASSIFICATION,
    gates,
    certified: failed.length === 0,
    summary:
      failed.length === 0
        ? `All ${gates.length} gates pass. This says the engine's declared invariants hold; it does not say the costing is correct, which only the test suite can speak to.`
        : `${failed.length} of ${gates.length} gates failed: ${failed.map((g) => g.id).join(", ")}.`,
    outOfScopeOfThisCertification: [
      "Whether the arithmetic is correct. That rests on the test suite and the mutation runs behind it, not on any assertion made here.",
      "Whether the cost models a host builds are any good. The engine can report that a model's evidence is thin; it cannot know whether the numbers are right.",
      "Whether a host binds its ports correctly. A clock port wired to a fixed date would pass every gate here and produce nonsense.",
      "Security of the host. This engine refuses cross-tenant reads it is asked to make; it cannot stop a host that never asks.",
    ],
  };
}

/** The report as text, for a build log or a release note. */
export function formatCertification(report: CertificationReport): string {
  const lines = [
    `CostIQ certification — API ${report.apiVersion}, charter ${report.charterVersion}, ${report.classification}`,
    "",
    ...report.gates.map((g) => `  [${g.passed ? "PASS" : "FAIL"}] ${g.id} — ${g.question}\n         ${g.evidence}${g.remedy === null ? "" : `\n         REMEDY: ${g.remedy}`}`),
    "",
    report.summary,
    "",
    "Not covered by this certification:",
    ...report.outOfScopeOfThisCertification.map((item) => `  - ${item}`),
  ];
  return lines.join("\n");
}
