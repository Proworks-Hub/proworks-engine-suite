// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { Diagnosis } from "../diagnostics/diagnosis.js";
import { environmentSchema, type Environment } from "../execution/environment.js";
import {
  actionTargetSchema,
  actionVerbSchema,
  checkForbiddenShortcuts,
  repairCandidateSchema,
  type ActionTarget,
  type ActionVerb,
  type ProposedAction,
  type RepairCandidate,
  type RepairClass,
} from "./candidate.js";
import { agentLeaseSchema, leasePermits, V1_DEFAULT_ACTIONS, type AgentLease } from "./lease.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Foundry RepairBot: the thing that actually authors a candidate.
//
// This closes the gap the V1 status document named as the largest: everything
// downstream — validation, scoring, selection, recording, generalization — was
// real, and nothing produced a proposal for it to act on.
//
// AUTHORING AUTHORITY ONLY. NO DEPLOYMENT AUTHORITY OF ANY KIND.
//
// This bot may inspect, diagnose, modify a candidate workspace, run tests and
// submit a candidate. It operates under SIMULATION or VALIDATION leases and
// nothing else — `repairBotLease()` will not construct a lease for STAGING or
// PRODUCTION, and `authorCandidate` re-checks the environment on every call
// rather than trusting the lease it was handed.
//
// Foundry Charter §13: "Foundry may prepare the work without possessing
// authority to approve it." §18: "Development authority does not automatically
// authorize deployment." A bot that writes a fix has not thereby earned the
// right to ship it.
//
// STRUCTURALLY INCAPABLE, NOT MERELY CAUGHT
//
// The obvious design is to let the bot emit whatever it likes and rely on the
// Phase D veto to reject the bad ones. That is one layer, and it is the wrong
// one to rely on alone: a generator that can express "disable Governance" will
// eventually express it under some input nobody tested, and the only thing
// standing between that and a merged change is a validator somebody might have
// configured out.
//
// So there are two independent layers, and neither trusts the other:
//
//   1. SAFE_ACTIONS below is an allowlist of (verb, target) pairs. A strategy
//      cannot construct anything else — the type will not permit it and the
//      emit path re-checks at runtime.
//   2. `authorCandidate` runs `checkForbiddenShortcuts` on its own output and
//      REFUSES TO EMIT if it finds anything. The bot audits itself before
//      anybody else sees the candidate.
//
// Then Phase D checks it again, independently, owned by somebody else. Three
// layers for the same rule is not redundancy here; it is the difference between
// a rule and a hope.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Environments a RepairBot may author in.
 *
 * Deliberately its own type rather than reusing `Environment`. A function that
 * takes `Environment` can be handed PRODUCTION; one that takes this cannot.
 */
export const authoringEnvironmentSchema = z.enum(["SIMULATION", "VALIDATION"]);
export type AuthoringEnvironment = z.infer<typeof authoringEnvironmentSchema>;

/**
 * The only (verb, target) pairs a strategy may emit.
 *
 * An ALLOWLIST, not a denylist. A denylist has to anticipate every bad
 * combination; an allowlist has to anticipate the good ones, and being wrong
 * about the good ones fails safely — the bot cannot express a repair rather
 * than expressing a dangerous one.
 *
 * Note what is absent and why:
 *   - nothing may `remove` a test, an invariant, a tenant check or error handling
 *   - nothing may `disable` anything at all
 *   - nothing may `widen` an authority grant (`narrow` is permitted)
 *   - nothing touches `governance`, `governance_policy`, `sentinel`, `audit`,
 *     `source_of_truth_owner` or `idempotency_check` under any verb
 */
export const SAFE_ACTIONS: readonly { verb: ActionVerb; target: ActionTarget }[] = Object.freeze([
  { verb: "add", target: "code" },
  { verb: "modify", target: "code" },
  { verb: "add", target: "configuration" },
  { verb: "modify", target: "configuration" },
  { verb: "add", target: "contract" },
  { verb: "add", target: "schema" },
  { verb: "migrate", target: "schema" },
  { verb: "add", target: "test" },
  { verb: "modify", target: "test" },
  { verb: "add", target: "documentation" },
  { verb: "modify", target: "documentation" },
  { verb: "reconcile", target: "data" },
  { verb: "rollback", target: "data" },
  { verb: "add", target: "tenant_check" },
  { verb: "add", target: "idempotency_check" },
  { verb: "add", target: "error_handling" },
  { verb: "modify", target: "error_handling" },
  // Narrowing an authority grant is the safe direction and a legitimate repair
  // for an over-broad grant. Widening is absent, permanently.
  { verb: "narrow", target: "authority_grant" },
]);

function isSafeAction(action: { verb: ActionVerb; target: ActionTarget }): boolean {
  return SAFE_ACTIONS.some((s) => s.verb === action.verb && s.target === action.target);
}

/** An action a strategy proposes. Constrained to the allowlist by construction. */
export interface StrategyAction {
  readonly verb: ActionVerb;
  readonly target: ActionTarget;
  readonly subject: string;
  readonly rationale: string;
}

export interface StrategyOutput {
  readonly repairClass: RepairClass;
  readonly description: string;
  readonly expectedEffect: string;
  readonly actions: readonly StrategyAction[];
  readonly risk: RepairCandidate["risk"];
  readonly blastRadius: RepairCandidate["blastRadius"];
  readonly reversibility: RepairCandidate["reversibility"];
  readonly rollbackPlan?: string;
  /** Validators this repair class needs beyond the default set. */
  readonly extraValidators?: readonly string[];
}

/**
 * Turns a diagnosis into candidate actions.
 *
 * Returns null when it has nothing to say about this diagnosis — which is the
 * common case, and is why the bot can produce zero candidates. A strategy that
 * always produces something produces something wrong.
 */
export interface RepairStrategy {
  readonly name: string;
  /** Which repair classes this strategy addresses. */
  readonly addresses: readonly RepairClass[];
  propose(input: {
    diagnosis: Diagnosis;
    targetComponents: readonly string[];
  }): StrategyOutput | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The baseline strategies.
//
// Each addresses one repair class and each declines when the diagnosis does not
// actually support it. They are deliberately conservative: an idempotency
// strategy that fires on any duplicate-shaped symptom will eventually propose a
// key check for a failure that was never about duplicates.
// ─────────────────────────────────────────────────────────────────────────────

const violated = (diagnosis: Diagnosis, invariantId: string): boolean =>
  diagnosis.violatedInvariants.some((v) => v.invariantId === invariantId);

export const idempotencyStrategy: RepairStrategy = {
  name: "idempotent-consumer",
  addresses: ["IDEMPOTENCY"],
  propose({ diagnosis, targetComponents }) {
    if (!violated(diagnosis, "HIVE-INV-IDEMPOTENCY-001")) return null;

    const component = targetComponents[0] ?? "the consumer";
    return {
      repairClass: "IDEMPOTENCY",
      description: `Key the consequential state transition in ${component} on the delivery identifier, so a redelivered message is recognised as already handled.`,
      expectedEffect:
        "A duplicate delivery is detected and its effect suppressed, without changing behaviour for a first delivery.",
      actions: [
        {
          verb: "add",
          target: "idempotency_check",
          subject: `${component} intake path`,
          rationale:
            "At-least-once delivery makes redelivery expected rather than exceptional, so the consumer must be idempotent.",
        },
        {
          verb: "add",
          target: "test",
          subject: `${component} duplicate-delivery test`,
          rationale: "Prove the suppression rather than assert it.",
        },
      ],
      risk: "LOW",
      blastRadius: "WORK_ORDER",
      reversibility: "REVERSIBLE",
      rollbackPlan: "Revert the intake change. No data migration is performed, so no backfill is needed.",
    };
  },
};

export const tenantIsolationStrategy: RepairStrategy = {
  name: "tenant-scoping",
  addresses: ["TENANT_ISOLATION"],
  propose({ diagnosis, targetComponents }) {
    if (!violated(diagnosis, "HIVE-INV-TENANT-001")) return null;

    const component = targetComponents[0] ?? "the reader";
    return {
      repairClass: "TENANT_ISOLATION",
      description: `Scope every read and write in ${component} to the requesting tenant.`,
      expectedEffect: "A request can no longer observe or alter another tenant's data.",
      actions: [
        {
          verb: "add",
          target: "tenant_check",
          subject: `${component} query path`,
          rationale:
            "The execution touched more than one tenant. The repair is to add the missing boundary, never to remove the one that noticed.",
        },
        {
          verb: "add",
          target: "test",
          subject: `${component} cross-tenant refusal test`,
          rationale: "A tenant boundary with no test is a boundary until somebody refactors.",
        },
      ],
      risk: "MODERATE",
      blastRadius: "TENANT",
      reversibility: "REVERSIBLE",
      rollbackPlan:
        "Revert the scoping change. Note that reverting restores the boundary violation, so rollback needs its own decision.",
      extraValidators: ["sentinel"],
    };
  },
};

export const dependencyFailureStrategy: RepairStrategy = {
  name: "degrade-on-dependency-loss",
  addresses: ["DEPENDENCY_FAILURE"],
  propose({ diagnosis, targetComponents }) {
    const rootCause = diagnosis.selectedRootCause;
    if (!rootCause) return null;
    // Only when the root cause is a DIFFERENT component from the one that hurt.
    // A dependency repair aimed at the component that merely reported the pain
    // is a retry wrapped around a dependency that is simply gone.
    if (!rootCause.componentId || targetComponents.includes(rootCause.componentId)) return null;

    const component = targetComponents[0] ?? "the caller";
    return {
      repairClass: "DEPENDENCY_FAILURE",
      description: `Make ${component} degrade explicitly when ${rootCause.componentId} is unavailable, instead of waiting for it.`,
      expectedEffect:
        "The dependency's absence produces a stated degraded result rather than a timeout, and the failure stops propagating as a fault of the caller.",
      actions: [
        {
          verb: "add",
          target: "error_handling",
          subject: `${component} call to ${rootCause.componentId}`,
          rationale:
            "A timeout tells the caller nothing about why. An explicit degraded path names the missing dependency.",
        },
        {
          verb: "add",
          target: "code",
          subject: `${component} degraded-result path`,
          rationale: "Failure should be isolated and stated, not silently absorbed.",
        },
      ],
      risk: "MODERATE",
      blastRadius: "MULTI_ENGINE",
      reversibility: "REVERSIBLE",
      rollbackPlan: "Revert the degraded path; the original timeout behaviour returns.",
    };
  },
};

export const contractCompatibilityStrategy: RepairStrategy = {
  name: "compatibility-adapter",
  addresses: ["CONTRACT_COMPATIBILITY", "SCHEMA_MIGRATION"],
  propose({ diagnosis, targetComponents }) {
    if (!violated(diagnosis, "HIVE-INV-VERSION-LINEAGE-001")) return null;

    const component = targetComponents[0] ?? "the consumer";
    return {
      repairClass: "CONTRACT_COMPATIBILITY",
      description: `Add a compatibility adapter so ${component} accepts both contract versions during the transition.`,
      expectedEffect: "Existing consumers keep working while the newer producers are adopted.",
      actions: [
        {
          verb: "add",
          target: "contract",
          subject: `${component} version adapter`,
          rationale:
            "Adding a translation keeps every consumer working. Removing the field both sides disagree about breaks the ones that still need it.",
        },
        {
          verb: "add",
          target: "test",
          subject: `${component} cross-version compatibility test`,
          rationale: "Prove both versions round-trip.",
        },
      ],
      risk: "MODERATE",
      blastRadius: "CROSS_ENGINE_TRACE",
      reversibility: "REVERSIBLE",
      rollbackPlan: "Remove the adapter. Consumers on the old version break again, which is the state before this repair.",
      extraValidators: ["contract-compatibility"],
    };
  },
};

export const observabilityStrategy: RepairStrategy = {
  name: "correlation-propagation",
  addresses: ["OBSERVABILITY"],
  propose({ diagnosis, targetComponents }) {
    if (!violated(diagnosis, "HIVE-INV-CORRELATION-001")) return null;

    const component = targetComponents[0] ?? "the component";
    return {
      repairClass: "OBSERVABILITY",
      description: `Propagate the inbound correlation identifier through ${component} rather than minting a new one.`,
      expectedEffect: "One workflow can be reconstructed from one correlation id across every hop.",
      actions: [
        {
          verb: "modify",
          target: "code",
          subject: `${component} outbound context construction`,
          rationale:
            "The trace split because a new correlation id was minted mid-workflow. Carrying the inbound one is the repair.",
        },
      ],
      risk: "LOW",
      blastRadius: "CROSS_ENGINE_TRACE",
      reversibility: "REVERSIBLE",
      rollbackPlan: "Revert the context construction change.",
    };
  },
};

/**
 * Authorization failures.
 *
 * The dangerous class, and the strategy is deliberately almost empty: the only
 * safe automated repair for "this was refused" is to NARROW an over-broad grant.
 * Establishing authority that does not exist is a decision about what should be
 * permitted, which is Governance's, not a bot's.
 *
 * So it proposes only when the diagnosis says the grant was too WIDE, and
 * otherwise returns null with the reasoning in the comment rather than
 * inventing a permission.
 */
export const authorityNarrowingStrategy: RepairStrategy = {
  name: "narrow-over-broad-grant",
  addresses: ["AUTHORIZATION"],
  propose({ diagnosis, targetComponents }) {
    if (!violated(diagnosis, "HIVE-INV-AUTHORITY-001")) return null;

    // Only when the root cause is an EXCESS of authority. A shortfall is not a
    // repairable defect — it is Governance correctly refusing, and the answer
    // is a decision, not a code change.
    const statement = diagnosis.selectedRootCause?.statement.toLowerCase() ?? "";
    const isExcess = /over-broad|too wide|excess|unnecessarily broad|wider than/.test(statement);
    if (!isExcess) return null;

    const component = targetComponents[0] ?? "the grant";
    return {
      repairClass: "AUTHORIZATION",
      description: `Narrow the over-broad authority grant on ${component} to the actions actually required.`,
      expectedEffect: "The component retains the authority it needs and loses the authority it does not.",
      actions: [
        {
          verb: "narrow",
          target: "authority_grant",
          subject: `${component} grant`,
          rationale:
            "Minimum Necessary Power. Narrowing is the only direction a repair may move an authority grant.",
        },
      ],
      risk: "HIGH",
      blastRadius: "AUTHORITY_SCOPE",
      reversibility: "REVERSIBLE",
      rollbackPlan: "Restore the previous grant. Note that doing so restores the over-broad authority.",
      extraValidators: ["sentinel", "forbidden-shortcut"],
    };
  },
};

export const BASELINE_STRATEGIES: readonly RepairStrategy[] = Object.freeze([
  idempotencyStrategy,
  tenantIsolationStrategy,
  dependencyFailureStrategy,
  contractCompatibilityStrategy,
  observabilityStrategy,
  authorityNarrowingStrategy,
]);

// ─────────────────────────────────────────────────────────────────────────────
// The bot.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthoredCandidates {
  readonly candidates: readonly RepairCandidate[];
  /** Strategies that declined, and why nothing was produced. */
  readonly declined: readonly { strategy: string; because: string }[];
  /**
   * Candidates the bot refused to emit after auditing its own output.
   *
   * Should always be empty — the allowlist makes it structurally unreachable.
   * It is reported rather than assumed, because "this cannot happen" is a
   * claim worth measuring.
   */
  readonly selfRejected: readonly { strategy: string; because: string }[];
}

export type AuthorResult =
  | { readonly authored: true; readonly result: AuthoredCandidates }
  | { readonly authored: false; readonly reason: string };

export interface RepairBot {
  readonly botId: string;
  readonly lease: AgentLease;
  /**
   * Authors zero or more candidates from a diagnosis.
   *
   * Zero is a legitimate and common outcome. A bot that always produces a
   * candidate produces bad ones.
   */
  authorCandidates(input: {
    diagnosis: Diagnosis;
    environment: Environment;
    now: Date;
  }): AuthorResult;
}

let sequence = 0;

export function createRepairBot(input: {
  botId: string;
  lease: AgentLease;
  strategies?: readonly RepairStrategy[];
  /** §38 audit seam. Every authored candidate is announced. */
  onAuthored?: (candidate: RepairCandidate, botId: string) => void;
  /** Announced too — a refusal to author is as interesting as an authoring. */
  onDeclined?: (reason: string, botId: string) => void;
  generateId?: () => string;
}): RepairBot {
  const strategies = input.strategies ?? BASELINE_STRATEGIES;
  const newId = input.generateId ?? (() => `rc_${(sequence += 1)}`);

  return {
    botId: input.botId,
    lease: input.lease,

    authorCandidates({ diagnosis, environment, now }) {
      // ── Environment, re-checked rather than trusted ──────────────────────
      //
      // The lease was already constrained at construction. This checks again
      // against the environment of THIS call, because a lease is a document and
      // a call is an action, and the gap between them is where a
      // simulation-scoped bot ends up running somewhere else.
      const authoring = authoringEnvironmentSchema.safeParse(environment);
      if (!authoring.success) {
        return {
          authored: false,
          reason:
            `A RepairBot may author only in SIMULATION or VALIDATION, and this call targets ${environment}. ` +
            "Authoring authority is not deployment authority (Foundry Charter §18).",
        };
      }

      const permitted = leasePermits(input.lease, {
        action: "submit_repair_candidate",
        environment,
        now,
      });
      if (!permitted.permitted) {
        return { authored: false, reason: permitted.reason };
      }

      // ── Diagnosis quality ────────────────────────────────────────────────
      //
      // A diagnosis that needs human review has not established a root cause,
      // and authoring a repair for an unestablished cause produces a confident
      // fix to the wrong thing.
      if (diagnosis.requiresHumanReview) {
        return {
          authored: false,
          reason: `The diagnosis requires human review and has selected no root cause: ${diagnosis.reviewReason}. A repair for an unestablished cause is a confident fix to the wrong thing.`,
        };
      }

      if (diagnosis.violatedInvariants.length === 0) {
        return {
          authored: false,
          reason:
            "The diagnosis records no invariant violation, so there is nothing this bot knows how to repair. " +
            "A strategy firing on a symptom alone would be guessing.",
        };
      }

      // ── Author ───────────────────────────────────────────────────────────
      const targetComponents = input.lease.targetComponents.filter((c) =>
        diagnosis.affectedComponents.length === 0 ? true : diagnosis.affectedComponents.includes(c),
      );

      if (targetComponents.length === 0) {
        return {
          authored: false,
          reason: `The diagnosis names components (${diagnosis.affectedComponents.join(", ")}) that this lease does not cover (${input.lease.targetComponents.join(", ")}). A repair outside the lease needs a new lease, not a wider diff.`,
        };
      }

      const candidates: RepairCandidate[] = [];
      const declined: { strategy: string; because: string }[] = [];
      const selfRejected: { strategy: string; because: string }[] = [];

      for (const strategy of strategies) {
        const output = strategy.propose({ diagnosis, targetComponents });

        if (output === null) {
          declined.push({
            strategy: strategy.name,
            because: "The diagnosis does not support this strategy.",
          });
          continue;
        }

        // ── Layer 1: the allowlist, re-checked at runtime ─────────────────
        const unsafe = output.actions.filter((a) => !isSafeAction(a));
        if (unsafe.length > 0) {
          selfRejected.push({
            strategy: strategy.name,
            because: `Proposed ${unsafe.map((a) => `${a.verb} ${a.target}`).join(", ")}, which is not in the safe-action allowlist.`,
          });
          continue;
        }

        const proposedActions: ProposedAction[] = output.actions.map((a) => ({
          verb: actionVerbSchema.parse(a.verb),
          target: actionTargetSchema.parse(a.target),
          subject: a.subject,
          rationale: a.rationale,
        }));

        const requiredValidators = [
          ...new Set(["forbidden-shortcut", "sentinel", ...(output.extraValidators ?? [])]),
        ];

        const parsed = repairCandidateSchema.safeParse({
          repairCandidateId: newId(),
          diagnosisId: diagnosis.diagnosisId,
          repairClass: output.repairClass,
          description: output.description,
          targetComponents,
          affectedResources: output.actions.map((a) => a.subject),
          proposedActions,
          expectedEffect: output.expectedEffect,
          risk: output.risk,
          blastRadius: output.blastRadius,
          reversibility: output.reversibility,
          requiredAuthority: [`foundry.repair.${authoring.data.toLowerCase()}`],
          requiredValidators,
          ...(output.rollbackPlan === undefined ? {} : { rollbackPlan: output.rollbackPlan }),
          // The bot's own claim. Phase D ignores it, correctly — a
          // self-declaration from the author is the one piece of evidence that
          // cannot be trusted. It is recorded because a candidate claiming a
          // check it did not run is itself a finding.
          forbiddenShortcutsChecked: true,
          authoredBy: input.botId,
          authoredAt: now.toISOString(),
        });

        if (!parsed.success) {
          selfRejected.push({
            strategy: strategy.name,
            because: `Produced a malformed candidate: ${JSON.stringify(parsed.error.flatten())}`,
          });
          continue;
        }

        // ── Layer 2: audit our own output before anybody sees it ──────────
        //
        // The bot runs the same structural check Phase D will run. Passing here
        // is not a reason for Phase D to skip it — that check is owned by
        // somebody else and that is the point of it.
        const check = checkForbiddenShortcuts(parsed.data);
        if (!check.clean) {
          selfRejected.push({
            strategy: strategy.name,
            because: `Self-audit found a forbidden action: ${check.violations.map((v) => v.reason).join(" ")}`,
          });
          continue;
        }

        candidates.push(parsed.data);
        input.onAuthored?.(parsed.data, input.botId);
      }

      if (candidates.length === 0) {
        input.onDeclined?.(
          `No strategy produced a candidate for diagnosis ${diagnosis.diagnosisId}.`,
          input.botId,
        );
      }

      return { authored: true, result: { candidates, declined, selfRejected } };
    },
  };
}

/**
 * A lease for a RepairBot: authoring only, never deployment.
 *
 * Refuses to construct a lease for STAGING or PRODUCTION at all, and hard-codes
 * `deploymentAuthority: false`. There is no parameter to turn that on, which is
 * the point — an option to grant deployment authority is an option somebody
 * eventually passes.
 */
export function repairBotLease(input: {
  agentId: string;
  mission: string;
  targetComponents: readonly string[];
  targetRepository: string;
  environment: AuthoringEnvironment;
  startedAt: string;
  expiresAt: string;
  governanceReference: string;
  sentinelSession: string;
  dataScope?: readonly string[];
  maxFiles?: number;
  maxComponents?: number;
}): AgentLease {
  // Parsed rather than trusted. A caller reaching this from JavaScript with
  // "PRODUCTION" gets a throw, not a lease.
  const environment = authoringEnvironmentSchema.parse(input.environment);

  return agentLeaseSchema.parse({
    agentId: input.agentId,
    agentType: "REPAIR_BOT",
    mission: input.mission,
    targetComponents: input.targetComponents,
    targetRepository: input.targetRepository,
    targetEnvironment: environmentSchema.parse(environment),
    allowedActions: V1_DEFAULT_ACTIONS,
    // Named explicitly. A reader should see what was refused, not infer it.
    prohibitedActions: [
      "deploy_to_production",
      "deploy_to_staging",
      "modify_trusted_baseline",
      "apply_in_validation",
    ],
    toolScope: ["editor", "test-runner"],
    dataScope: input.dataScope ?? [],
    startedAt: input.startedAt,
    expiresAt: input.expiresAt,
    maxChangeScope: { maxFiles: input.maxFiles ?? 10, maxComponents: input.maxComponents ?? 2 },
    deploymentAuthority: false,
    governanceReference: input.governanceReference,
    sentinelSession: input.sentinelSession,
    requiredValidators: ["forbidden-shortcut", "sentinel"],
    terminationConditions: [
      "lease expiry",
      "Sentinel finding against this agent",
      "change scope exceeded",
      "validator rejection",
      "any attempt to act outside SIMULATION or VALIDATION",
    ],
  });
}

/**
 * Foundry Charter §18, restated for the thing that writes the fix.
 *
 * Always false. Authoring a repair is preparing work, and §13 separates
 * preparing from approving in one sentence: "Foundry may prepare the work
 * without possessing authority to approve it."
 */
export function authoringGrantsDeploymentAuthority(_candidate: RepairCandidate): false {
  return false;
}
