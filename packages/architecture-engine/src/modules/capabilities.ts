// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { capabilityDeclarationSchema, type CapabilityDeclaration } from "@proworks-hub/hive-runtime";

import { ARCHITECTURE_RULES } from "../rules.js";
import { MANIFESTO_TRACEABILITY } from "../traceability/index.js";
import { REQUIRED_BOOKS } from "./knowledge.js";

// ─────────────────────────────────────────────────────────────────────────────
// The architecture capabilities a builder may invoke.
//
// Claude, ARIA, Foundry and authorized developers all read the same standard
// through the same surface. The point is not convenience — it is that a
// builder generating a new engine should be working from the CURRENT rules
// rather than from whatever was true when its instructions were written.
//
// EVERY CAPABILITY HERE IS READ_ONLY, and that is a boundary rather than a
// starting position. §VI of the build directive: "Do not expose unrestricted
// repo mutation through these capabilities." A capability that could edit the
// repository would let anything holding it rewrite the code to satisfy the
// rules instead of satisfying the rules — and the conformance report would
// improve either way, which is precisely what makes it dangerous.
//
// Conformance evaluates. Foundry proposes. Governance and a human promote.
// This surface does none of those three.
// ─────────────────────────────────────────────────────────────────────────────

const declare = (
  id: string,
  purpose: string,
): CapabilityDeclaration =>
  capabilityDeclarationSchema.parse({
    capabilityId: id,
    version: "1.0.0",
    purpose,
    // False, and it is worth being explicit about why: these read the
    // architecture standard, which is not sensitive and is meant to be
    // universally available. Protecting them would mean a builder had to be
    // authorized in order to learn the rules it is required to follow.
    requiresAuthorization: false,
    dataClasses: ["INTERNAL"],
    determinism: "DETERMINISTIC",
    sideEffect: "READ_ONLY",
    idempotent: true,
  });

export const ARCHITECTURE_CAPABILITIES: readonly CapabilityDeclaration[] = [
  declare("architecture.rules.list", "Return the current architecture rule catalog."),
  declare("architecture.rules.explain", "Return one rule with its manifesto source and remediation."),
  declare("architecture.conformance.evaluate", "Evaluate supplied package facts and return findings."),
  declare("architecture.identity.validate", "Check stable ids for uniqueness and retired-id reuse."),
  declare("architecture.dependencies.check", "Report dependency direction, cycles and undeclared edges."),
  declare("architecture.contracts.compare", "Classify the compatibility of two contract versions."),
  declare("architecture.knowledge.assess", "Report Knowledge Package completeness and the limiting book."),
  declare("architecture.migration.plan", "Produce a conformance migration plan for a package."),
  declare("architecture.benchmark.assess", "Say whether a comparative performance claim is supported."),
  declare("architecture.context.current", "Return the current build context for generating new code."),
];

/**
 * What a builder needs before generating a new engine.
 *
 * Generated from the live catalog rather than written down, so it cannot go
 * stale. A build context maintained by hand is a document that describes the
 * rules as they were on the day somebody last remembered to edit it, and a
 * builder following it confidently produces code that was conformant last
 * quarter.
 */
export interface BuilderBuildContext {
  readonly standardVersion: string;
  readonly goldenReferenceId: string;
  /** Rule ids that will block a build if violated. */
  readonly blockingRuleIds: readonly string[];
  /** Rule ids reported but never blocking. */
  readonly advisoryRuleIds: readonly string[];
  /** Rules Governance gates, which CI must not enforce on its own. */
  readonly governedRuleIds: readonly string[];
  readonly manifestoRuleCount: number;
  readonly requiredKnowledgeBooks: readonly string[];
  readonly capabilities: readonly string[];
  /**
   * What this context does NOT establish.
   *
   * Carried with the context so a builder reading it cannot conclude that
   * following these rules is sufficient. Passing every architecture rule means
   * the shape is right; it says nothing about whether the engine is correct,
   * safe, or wanted.
   */
  readonly limitations: readonly string[];
}

export function currentBuildContext(): BuilderBuildContext {
  const bySeverity = (severity: string) =>
    ARCHITECTURE_RULES.filter((r) => r.severity === severity).map((r) => r.id).sort();

  return {
    standardVersion: "common-hive-runtime-v1",
    goldenReferenceId: "hive.architecture.golden-reference",
    blockingRuleIds: bySeverity("ENGINEERING_GATE"),
    advisoryRuleIds: bySeverity("ADVISORY"),
    governedRuleIds: bySeverity("GOVERNED_GATE"),
    manifestoRuleCount: MANIFESTO_TRACEABILITY.length,
    requiredKnowledgeBooks: REQUIRED_BOOKS,
    capabilities: ARCHITECTURE_CAPABILITIES.map((c) => c.capabilityId).sort(),
    limitations: [
      "Conformance is about shape, not correctness. A fully conformant engine can still compute the wrong answer.",
      `${MANIFESTO_TRACEABILITY.length - new Set(ARCHITECTURE_RULES.map((r) => r.source)).size} manifesto rules have no automated check yet.`,
      "Passing every rule is not certification, and certification is not permission to deploy.",
    ],
  };
}
