// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  BASELINE_VALIDATORS,
  scoreRepair,
  selectRepair,
  validate,
  type AgentLease,
  type ChangeSet,
  type RepairCandidate,
  type ScoredRepair,
  type ValidationContext,
  type ValidationVerdict,
  type Validator,
} from "@proworks-hub/repair-learning";

// ─────────────────────────────────────────────────────────────────────────────
// The Validation Orchestrator.
//
// The validators already existed and were good. What was missing is the thing
// that RUNS them as a stage of a mission: gathers the evidence each one needs,
// invokes them in an order that fails cheaply first, and reports a verdict the
// mission lifecycle can act on.
//
// FAIL CHEAPLY FIRST
//
// The forbidden-shortcut check needs nothing but the candidate. The regression
// sweep needs a full test run. Running them in that order means a candidate
// that disables Governance is rejected in microseconds rather than after twenty
// minutes of CI — and, more importantly, the expensive run never happens for a
// change that was never going to be admissible.
//
// This is not only an efficiency argument. A pipeline that runs the cheap
// constitutional checks LAST produces a log where the tests passed and then
// something rejected it, which reads as bureaucracy. Running them first
// produces a log where the change was rejected on its merits before anybody
// spent an hour on it.
//
// THE ORCHESTRATOR DOES NOT VALIDATE
//
// It has no opinion of its own and adds no verdict. Everything it reports comes
// from a validator owned by somebody else — Sentinel's is owned by
// `hive.sentinel-iq`, the contract bot's by `foundry.contractbot`. An
// orchestrator that could tip the outcome would be the authoring side marking
// its own homework one level up.
// ─────────────────────────────────────────────────────────────────────────────

/** What a host must run to produce the evidence the validators consume. */
export interface TestBot {
  /** Re-runs the original scenario and its family (§17). */
  replay(input: {
    scenarioId: string;
    workspaceId: string;
  }): Promise<{
    originalScenarioNowPasses: boolean;
    relatedScenariosRun: number;
    relatedScenariosFailed: number;
  }>;

  /** The wider sweep. */
  regression(input: {
    workspaceId: string;
    affectedComponents: readonly string[];
  }): Promise<{ testsRun: number; testsFailed: number; newFailures: readonly string[] }>;
}

/** Interface drift analysis (§18). */
export interface ContractBot {
  analyze(input: {
    workspaceId: string;
    contractsTouched: readonly string[];
  }): Promise<{
    breakingChanges: readonly string[];
    deprecatedFieldsUsed: readonly string[];
    consumersChecked: number;
  }>;
}

export interface OrchestrationResult {
  readonly verdict: ValidationVerdict;
  readonly score: ScoredRepair;
  /** Stages that ran, cheapest first. */
  readonly stagesRun: readonly string[];
  /** Stages skipped because an earlier one had already decided. */
  readonly stagesSkipped: readonly string[];
  /** True when the expensive stages were never reached. */
  readonly shortCircuited: boolean;
}

export interface ValidationOrchestrator {
  /**
   * Runs the pipeline for one candidate.
   *
   * Cheap constitutional checks first; test runs only if those pass.
   */
  orchestrate(input: {
    candidate: RepairCandidate;
    changeSet: ChangeSet;
    lease: AgentLease;
    scenarioId?: string;
    workspaceId: string;
    scenarioForbiddenActions?: readonly string[];
    diagnosticConfidence?: "suspected" | "probable" | "confirmed";
  }): Promise<OrchestrationResult>;

  /** Picks among several validated candidates. */
  select(
    scored: readonly { score: ScoredRepair; candidate: RepairCandidate }[],
  ): ReturnType<typeof selectRepair>;
}

export interface ValidationOrchestratorOptions {
  validators?: readonly Validator[];
  testBot?: TestBot;
  contractBot?: ContractBot;
  /** Announced for each stage, so a long run is observable while it runs. */
  onStage?: (stage: string, outcome: "passed" | "failed" | "skipped") => void;
}

/** Validators that need nothing but the candidate and its change set. */
const CHEAP_VALIDATORS = new Set(["forbidden-shortcut", "sentinel", "portability"]);

export function createValidationOrchestrator(
  options: ValidationOrchestratorOptions = {},
): ValidationOrchestrator {
  const allValidators = options.validators ?? BASELINE_VALIDATORS;

  return {
    async orchestrate(input) {
      const stagesRun: string[] = [];
      const stagesSkipped: string[] = [];

      // ── Stage 1: the cheap constitutional checks ──────────────────────────
      const cheapContext: ValidationContext = {
        candidate: input.candidate,
        changeSet: input.changeSet,
        lease: input.lease,
        scenarioForbiddenActions: input.scenarioForbiddenActions ?? [],
      };

      const cheap = allValidators.filter((v) => CHEAP_VALIDATORS.has(v.name));
      const cheapVerdict = validate(cheapContext, cheap);
      stagesRun.push(...cheap.map((v) => v.name));
      for (const v of cheap) options.onStage?.(v.name, cheapVerdict.valid ? "passed" : "failed");

      // A veto here ends it. The expensive run never happens for a change that
      // was never going to be admissible.
      const vetoed = !cheapVerdict.valid && "vetoedBy" in cheapVerdict && cheapVerdict.vetoedBy;
      if (vetoed) {
        const skipped = allValidators.filter((v) => !CHEAP_VALIDATORS.has(v.name)).map((v) => v.name);
        stagesSkipped.push(...skipped);
        for (const s of skipped) options.onStage?.(s, "skipped");

        return {
          verdict: cheapVerdict,
          score: scoreRepair({
            candidate: input.candidate,
            changeSet: input.changeSet,
            verdict: cheapVerdict,
            ...(input.diagnosticConfidence ? { diagnosticConfidence: input.diagnosticConfidence } : {}),
          }),
          stagesRun,
          stagesSkipped,
          shortCircuited: true,
        };
      }

      // ── Stage 2: the expensive evidence ───────────────────────────────────
      let replay: ValidationContext["replay"];
      if (options.testBot && input.scenarioId) {
        replay = await options.testBot.replay({
          scenarioId: input.scenarioId,
          workspaceId: input.workspaceId,
        });
        stagesRun.push("scenario-replay");
        options.onStage?.("scenario-replay", replay.originalScenarioNowPasses ? "passed" : "failed");
      } else {
        stagesSkipped.push("scenario-replay");
        options.onStage?.("scenario-replay", "skipped");
      }

      let regression: ValidationContext["regression"];
      if (options.testBot) {
        regression = await options.testBot.regression({
          workspaceId: input.workspaceId,
          affectedComponents: input.candidate.targetComponents,
        });
        stagesRun.push("regression");
        options.onStage?.("regression", regression.newFailures.length === 0 ? "passed" : "failed");
      } else {
        stagesSkipped.push("regression");
        options.onStage?.("regression", "skipped");
      }

      let contracts: ValidationContext["contracts"];
      if (options.contractBot) {
        contracts = await options.contractBot.analyze({
          workspaceId: input.workspaceId,
          contractsTouched: input.changeSet.contractsTouched,
        });
        stagesRun.push("contract-compatibility");
        options.onStage?.(
          "contract-compatibility",
          contracts.breakingChanges.length === 0 ? "passed" : "failed",
        );
      } else {
        stagesSkipped.push("contract-compatibility");
        options.onStage?.("contract-compatibility", "skipped");
      }

      // ── Stage 3: the full verdict ─────────────────────────────────────────
      //
      // Every validator runs again over the complete context. Not a
      // re-litigation — the cheap ones are deterministic and will agree — but
      // the verdict a mission acts on must come from one evaluation over one
      // context, not from two half-verdicts stitched together.
      const fullContext: ValidationContext = {
        ...cheapContext,
        ...(replay ? { replay } : {}),
        ...(regression ? { regression } : {}),
        ...(contracts ? { contracts } : {}),
      };

      const verdict = validate(fullContext, allValidators);

      return {
        verdict,
        score: scoreRepair({
          candidate: input.candidate,
          changeSet: input.changeSet,
          verdict,
          ...(input.diagnosticConfidence ? { diagnosticConfidence: input.diagnosticConfidence } : {}),
        }),
        stagesRun,
        stagesSkipped,
        shortCircuited: false,
      };
    },

    select: (scored) => selectRepair(scored),
  };
}
