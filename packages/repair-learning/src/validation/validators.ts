// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { checkForbiddenShortcuts, type RepairCandidate } from "../repair/candidate.js";
import type { ChangeSet } from "../repair/workspace.js";
import type { AgentLease } from "../repair/lease.js";

// ─────────────────────────────────────────────────────────────────────────────
// The validation pipeline (directive §§16-19).
//
// §16: "Every Repair Candidate must go through independent validation... The
// repair-authoring agent cannot be the only validator."
//
// That last sentence is the load-bearing one, and it is enforced rather than
// documented: `validate()` refuses when the only validators that ran belong to
// the agent that authored the candidate. Foundry Charter, Common Overwatch
// Protections — "A constitutional system shall not be the sole author,
// approver, tester, and validator of a material expansion of its own
// capability."
//
// THREE OUTCOMES, AND THE THIRD IS THE USEFUL ONE
//
//   PASSED         this validator is satisfied
//   FAILED         this validator objects
//   NOT_RUN        this validator could not run here
//
// NOT_RUN exists for the same reason NOT_ASSESSED does in Phase B. A pipeline
// where an unrunnable validator silently counts as passing will approve
// anything on a machine where the tooling is missing, and that machine is
// usually CI at 3am.
//
// A CONSTITUTIONAL FAILURE IS A VETO
//
// §20: "A repair that fixes the bug but fails constitutional integrity must be
// rejected regardless of aggregate score." So certain validators are marked
// `veto: true`, and a veto failure ends the matter — it is not a weight in an
// average, because any weight small enough to be outvoted is a weight that
// permits the thing it was meant to forbid.
// ─────────────────────────────────────────────────────────────────────────────

export const validatorOutcomeSchema = z.enum(["PASSED", "FAILED", "NOT_RUN"]);
export type ValidatorOutcome = z.infer<typeof validatorOutcomeSchema>;

export interface ValidatorResult {
  readonly validatorName: string;
  readonly outcome: ValidatorOutcome;
  readonly detail: string;
  /** Evidence or artefact references. Never contents. */
  readonly evidenceIds: readonly string[];
  /** True when a failure here cannot be outweighed. */
  readonly veto: boolean;
  /** Who ran it, so independence can be checked. */
  readonly ranBy: string;
}

export interface ValidationContext {
  readonly candidate: RepairCandidate;
  readonly changeSet: ChangeSet;
  readonly lease: AgentLease;
  /** Forbidden actions the originating scenario declared. */
  readonly scenarioForbiddenActions: readonly string[];
  /** Results of re-running the original scenario, when a replay was performed. */
  readonly replay?: {
    readonly originalScenarioNowPasses: boolean;
    readonly relatedScenariosRun: number;
    readonly relatedScenariosFailed: number;
  };
  /** Results of the wider regression sweep, when one was performed. */
  readonly regression?: {
    readonly testsRun: number;
    readonly testsFailed: number;
    readonly newFailures: readonly string[];
  };
  /** Contract compatibility findings, when a contract bot ran. */
  readonly contracts?: {
    readonly breakingChanges: readonly string[];
    readonly deprecatedFieldsUsed: readonly string[];
    readonly consumersChecked: number;
  };
}

export interface Validator {
  readonly name: string;
  /** A failure here cannot be outweighed by other dimensions. */
  readonly veto: boolean;
  /** Who owns this validator. Must differ from the candidate's author. */
  readonly ownedBy: string;
  validate(context: ValidationContext): ValidatorResult;
}

export type ValidationVerdict =
  | {
      readonly valid: true;
      readonly results: readonly ValidatorResult[];
      readonly notRun: readonly string[];
    }
  | {
      readonly valid: false;
      readonly reason: string;
      readonly results: readonly ValidatorResult[];
      readonly notRun: readonly string[];
      /** Set when a veto validator failed. */
      readonly vetoedBy?: string;
    };

/**
 * Runs the validators and decides.
 *
 * Independence is checked BEFORE the results are weighed. A pipeline that
 * evaluates first and checks independence afterwards is one where somebody
 * eventually reads the passing results and stops.
 */
export function validate(
  context: ValidationContext,
  validators: readonly Validator[],
): ValidationVerdict {
  const results = validators.map((v) => v.validate(context));
  const notRun = results.filter((r) => r.outcome === "NOT_RUN").map((r) => r.validatorName);

  // ── Independence ──────────────────────────────────────────────────────────
  const independent = results.filter(
    (r) => r.outcome !== "NOT_RUN" && r.ranBy !== context.candidate.authoredBy,
  );

  if (independent.length === 0) {
    return {
      valid: false,
      reason:
        `No independent validator ran. Every result came from ${context.candidate.authoredBy}, which authored the candidate. ` +
        "The repair-authoring agent cannot be the only validator (directive §16).",
      results,
      notRun,
    };
  }

  // ── Veto ──────────────────────────────────────────────────────────────────
  const vetoed = results.find((r) => r.veto && r.outcome === "FAILED");
  if (vetoed) {
    return {
      valid: false,
      reason:
        `${vetoed.validatorName} vetoed this candidate: ${vetoed.detail} ` +
        "A repair that fixes the bug but fails constitutional integrity is rejected regardless of any other score (directive §20).",
      results,
      notRun,
      vetoedBy: vetoed.validatorName,
    };
  }

  // ── Required validators ───────────────────────────────────────────────────
  //
  // The candidate named the validators it needs. One that did not run is not
  // one that passed.
  const ran = new Set(results.filter((r) => r.outcome !== "NOT_RUN").map((r) => r.validatorName));
  const missing = context.candidate.requiredValidators.filter((v) => !ran.has(v));
  if (missing.length > 0) {
    return {
      valid: false,
      reason: `Required validator(s) did not run: ${missing.join(", ")}. A validator that could not run is not one that passed.`,
      results,
      notRun,
    };
  }

  const failed = results.filter((r) => r.outcome === "FAILED");
  if (failed.length > 0) {
    return {
      valid: false,
      reason: `${failed.length} validator(s) objected: ${failed.map((f) => f.validatorName).join(", ")}.`,
      results,
      notRun,
    };
  }

  return { valid: true, results, notRun };
}

// ─────────────────────────────────────────────────────────────────────────────
// The baseline validators.
//
// Each returns NOT_RUN when it lacks what it needs, rather than passing.
// ─────────────────────────────────────────────────────────────────────────────

const result = (
  validatorName: string,
  outcome: ValidatorOutcome,
  detail: string,
  extra: { veto: boolean; ranBy: string; evidenceIds?: readonly string[] },
): ValidatorResult => ({
  validatorName,
  outcome,
  detail,
  evidenceIds: extra.evidenceIds ?? [],
  veto: extra.veto,
  ranBy: extra.ranBy,
});

/**
 * The §13 gate, as a validator. VETO.
 *
 * This one can always run: it needs only the candidate, which is the point.
 * The most important check must not be the one that silently skips.
 */
export const forbiddenShortcutValidator: Validator = {
  name: "forbidden-shortcut",
  veto: true,
  ownedBy: "foundry.validation",
  validate(context) {
    const check = checkForbiddenShortcuts(context.candidate);
    if (!check.clean) {
      return result(
        "forbidden-shortcut",
        "FAILED",
        `${check.violations.length} forbidden action(s): ${check.violations
          .map((v) => `${v.action.verb} ${v.action.target} — ${v.reason}`)
          .join(" | ")}`,
        { veto: true, ranBy: "foundry.validation" },
      );
    }

    const advisory =
      check.textualConcerns.length > 0
        ? ` Advisory (not a failure): the description ${check.textualConcerns.join("; ")}.`
        : "";

    return result(
      "forbidden-shortcut",
      "PASSED",
      `No forbidden action declared.${advisory}`,
      { veto: true, ranBy: "foundry.validation" },
    );
  },
};

/**
 * Sentinel's independent look (directive §19). VETO.
 *
 * Foundry Charter §12: "Sentinel independently observes Foundry behavior and
 * validates relevant changes. Foundry shall not suppress Sentinel findings."
 * Owned by `hive.sentinel-iq`, never by Foundry, so the independence check
 * treats it as a genuinely separate party.
 */
export const sentinelValidator: Validator = {
  name: "sentinel",
  veto: true,
  ownedBy: "hive.sentinel-iq",
  validate(context) {
    const concerns: string[] = [];

    if (context.changeSet.testsRemoved.length > 0) {
      concerns.push(
        `removes ${context.changeSet.testsRemoved.length} test file(s): ${context.changeSet.testsRemoved.join(", ")}`,
      );
    }

    for (const action of context.candidate.proposedActions) {
      if (action.target === "authority_grant" && action.verb !== "narrow") {
        concerns.push(`touches an authority grant (${action.verb} ${action.subject})`);
      }
      if (action.target === "tenant_check" && action.verb !== "add") {
        concerns.push(`weakens a tenant check (${action.verb} ${action.subject})`);
      }
      if (action.target === "audit") {
        concerns.push(`touches audit (${action.verb} ${action.subject})`);
      }
      if (action.target === "source_of_truth_owner") {
        concerns.push(`moves source-of-truth ownership (${action.subject})`);
      }
    }

    // A new dependency is a supply-chain surface, which §19 names explicitly.
    if (context.changeSet.dependenciesTouched.length > 0) {
      concerns.push(
        `changes dependencies (${context.changeSet.dependenciesTouched.join(", ")}), which is a supply-chain surface`,
      );
    }

    if (concerns.length > 0) {
      return result("sentinel", "FAILED", `Sentinel objects: this candidate ${concerns.join("; ")}.`, {
        veto: true,
        ranBy: "hive.sentinel-iq",
      });
    }

    return result("sentinel", "PASSED", "No authority expansion, tenant weakening, audit change, ownership move or dependency change.", {
      veto: true,
      ranBy: "hive.sentinel-iq",
    });
  },
};

/** Re-runs the original scenario (directive §17). Not a veto: a bug may be real and the fix wrong. */
export const scenarioReplayValidator: Validator = {
  name: "scenario-replay",
  veto: false,
  ownedBy: "foundry.testbot",
  validate(context) {
    if (!context.replay) {
      return result("scenario-replay", "NOT_RUN", "No replay was performed.", {
        veto: false,
        ranBy: "foundry.testbot",
      });
    }

    if (!context.replay.originalScenarioNowPasses) {
      return result(
        "scenario-replay",
        "FAILED",
        "The original scenario still fails. Whatever this candidate changed, it did not fix the reported failure.",
        { veto: false, ranBy: "foundry.testbot" },
      );
    }

    if (context.replay.relatedScenariosFailed > 0) {
      return result(
        "scenario-replay",
        "FAILED",
        `The original scenario passes but ${context.replay.relatedScenariosFailed} of ${context.replay.relatedScenariosRun} related scenarios now fail. A fix that breaks its neighbours has moved the problem.`,
        { veto: false, ranBy: "foundry.testbot" },
      );
    }

    return result(
      "scenario-replay",
      "PASSED",
      `Original scenario passes; ${context.replay.relatedScenariosRun} related scenarios still pass.`,
      { veto: false, ranBy: "foundry.testbot" },
    );
  },
};

/** The wider sweep (directive §17). */
export const regressionValidator: Validator = {
  name: "regression",
  veto: false,
  ownedBy: "foundry.testbot",
  validate(context) {
    if (!context.regression) {
      return result("regression", "NOT_RUN", "No regression sweep was performed.", {
        veto: false,
        ranBy: "foundry.testbot",
      });
    }
    if (context.regression.newFailures.length > 0) {
      return result(
        "regression",
        "FAILED",
        `${context.regression.newFailures.length} new failure(s): ${context.regression.newFailures.join(", ")}.`,
        { veto: false, ranBy: "foundry.testbot" },
      );
    }
    return result(
      "regression",
      "PASSED",
      `${context.regression.testsRun} tests run, no new failures.`,
      { veto: false, ranBy: "foundry.testbot" },
    );
  },
};

/**
 * Interface drift (directive §18). VETO on a breaking change.
 *
 * Veto because a breaking contract change is not a repair that scored badly —
 * it is a different kind of change wearing a repair's clothes, and §31 says
 * repair knowledge must record compatibility rather than assume it.
 */
export const contractCompatibilityValidator: Validator = {
  name: "contract-compatibility",
  veto: true,
  ownedBy: "foundry.contractbot",
  validate(context) {
    if (!context.contracts) {
      // NOT_RUN rather than PASSED, even when no contract file was touched —
      // a consumer can break on behaviour that no schema file records.
      return result(
        "contract-compatibility",
        "NOT_RUN",
        "No contract analysis was performed. Not treated as compatible: a consumer can break on behaviour no schema file records.",
        { veto: true, ranBy: "foundry.contractbot" },
      );
    }

    if (context.contracts.breakingChanges.length > 0) {
      return result(
        "contract-compatibility",
        "FAILED",
        `${context.contracts.breakingChanges.length} breaking change(s) across ${context.contracts.consumersChecked} consumer(s): ${context.contracts.breakingChanges.join(", ")}.`,
        { veto: true, ranBy: "foundry.contractbot" },
      );
    }

    return result(
      "contract-compatibility",
      "PASSED",
      `${context.contracts.consumersChecked} consumer(s) checked, no breaking changes.`,
      { veto: true, ranBy: "foundry.contractbot" },
    );
  },
};

/**
 * Portability (directive §41). VETO.
 *
 * Foundry Charter §18: "Foundry shall preserve engine portability and
 * constitutional boundaries during evolution." A repair that fixes a bug by
 * hard-coupling to one vendor has traded a defect for a dependency.
 */
const VENDOR_PATTERNS: readonly RegExp[] = [
  /\bgithub\b/i,
  /\bkafka\b/i,
  /\brabbitmq\b/i,
  /\bdynamodb\b/i,
  /\bopenai\b/i,
  /\banthropic\b/i,
  /\bgrok\b/i,
  /\bpinecone\b/i,
  /\bs3\b/i,
];

export const portabilityValidator: Validator = {
  name: "portability",
  veto: true,
  ownedBy: "foundry.validation",
  validate(context) {
    const text = [
      context.candidate.description,
      context.candidate.expectedEffect,
      ...context.candidate.proposedActions.map((a) => `${a.subject} ${a.rationale}`),
    ].join("\n");

    const named = VENDOR_PATTERNS.filter((p) => p.test(text)).map((p) => p.source.replace(/\\b/g, ""));

    if (named.length > 0 && context.changeSet.dependenciesTouched.length > 0) {
      return result(
        "portability",
        "FAILED",
        `This candidate names specific providers (${named.join(", ")}) and changes dependencies. A repair that fixes a bug by hard-coupling to one vendor has traded a defect for a dependency (directive §41).`,
        { veto: true, ranBy: "foundry.validation" },
      );
    }

    return result("portability", "PASSED", "No new provider coupling introduced.", {
      veto: true,
      ranBy: "foundry.validation",
    });
  },
};

/** The validators available without host-specific tooling. */
export const BASELINE_VALIDATORS: readonly Validator[] = Object.freeze([
  forbiddenShortcutValidator,
  sentinelValidator,
  scenarioReplayValidator,
  regressionValidator,
  contractCompatibilityValidator,
  portabilityValidator,
]);
