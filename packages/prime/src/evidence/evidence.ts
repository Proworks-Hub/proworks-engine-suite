// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { auditRecordSchema, type AuditOutcome, type AuditRecord } from "@proworks-hub/contracts";

import type { PrimeExecutionContext } from "../context.js";
import type { NexusDecision } from "../nexus/nexus.js";
import type { RecoveryVerdict } from "../pulse/pulse.js";

// ─────────────────────────────────────────────────────────────────────────────
// What Prime leaves behind.
//
// Nexus returns an `evidence[]` array and Pulse returns a reason. Until now
// nothing consumed either, so a decision that blocked a shop's work explained
// itself to a variable that went out of scope.
//
// PORTS, NOT IMPORTS — AGAIN
//
// The tier law would permit Prime to import AuditIQ and EventIQ; both are
// platform. It still should not. `AuditRecord` and the message envelope live
// in contracts, which Prime already depends on, so Prime can produce a
// correctly shaped record without knowing who stores it. The host binds the
// sink, exactly as it binds engines.
//
// The alternative — Prime importing AuditIQ — would mean a shop that wants
// orchestration must also take an audit engine, and a test of Nexus must
// construct one.
//
// EVIDENCE IS BEST-EFFORT, AND FAILING TO WRITE IT IS NOT
//
// A sink that throws must not turn a clean refusal into a crash. Prime's job
// in that moment is to refuse the work, and an audit backend being down does
// not change the answer. But a swallowed failure is how a system quietly stops
// being auditable, so failures are caught AND surfaced through `onSinkFailure`.
//
// TWO OUTCOME TRAPS, BOTH LEARNED THE HARD WAY
//
// `denied` means GOVERNANCE refused it, and the schema enforces that with a
// required `governanceDecisionId` — a denial nobody can trace "cannot be
// reviewed, appealed, or distinguished from a fault". When Nexus blocks a step
// for a missing authorization, Governance never spoke. There is no decision id
// because there was no decision, so `denied` is the wrong word and the schema
// would reject it. Prime records those as `failed` or `partial`.
//
// `identifierSchema` allows letters, digits, dot, colon, underscore and hyphen
// — NOT `/`. Component names are dotted (`hive.prime.prime`), and an id built
// by joining a path would be rejected at the boundary.
// ─────────────────────────────────────────────────────────────────────────────

/** Where evidence goes. Bound by the host; absent means none is written. */
export interface AuditSink {
  record(record: AuditRecord): Promise<void> | void;
}

export interface EvidenceOptions {
  readonly audit?: AuditSink;
  readonly now?: () => Date;
  /**
   * Called when a sink refuses or throws.
   *
   * Surfaced rather than swallowed. An audit write that fails silently is how
   * a system stops being auditable without anybody noticing.
   */
  readonly onSinkFailure?: (info: { action: string; error: Error }) => void;
}

export interface PrimeEvidence {
  /** Records what Nexus decided. Never throws. */
  nexusDecided(decision: NexusDecision): Promise<void>;
  /** Records a continuity transition. Never throws. */
  pulseTransitioned(
    context: PrimeExecutionContext,
    workflowId: string,
    verdict: RecoveryVerdict,
  ): Promise<void>;
  /** Whether anything is actually being written. Hosts check their own wiring. */
  readonly enabled: boolean;
}

/**
 * Maps a Nexus outcome onto the audit vocabulary.
 *
 * Deliberately never `denied`. See the header: that word belongs to Governance
 * and the schema will reject it without a decision id Prime does not have.
 */
function outcomeFor(nexusOutcome: NexusDecision["outcome"]): AuditOutcome {
  switch (nexusOutcome) {
    case "proceed":
    case "completed":
      return "succeeded";
    case "refused":
      // Prime refused it, not Governance. "Attempted and failed" is the honest
      // reading: the workflow tried to advance and did not.
      return "failed";
    case "blocked":
    case "waiting":
      // Began and did not finish, which is exactly what `partial` describes:
      // "the state is one nobody chose".
      return "partial";
  }
}

/**
 * Prime's actor kinds mapped onto the audit vocabulary.
 *
 * A table rather than a conditional, so adding a kind on either side is a
 * compile error here instead of a silent fallback to whatever the `else`
 * branch happened to say.
 */
const AUDIT_ACTOR_KIND: Readonly<Record<PrimeExecutionContext["actor"]["kind"], "human" | "service" | "engine" | "agent">> =
  Object.freeze({
    human: "human",
    // Prime acting on its own schedule is a service, not a person and not one
    // of the domain engines it coordinates.
    system: "service",
    engine: "engine",
    agent: "agent",
  });

export function createPrimeEvidence(options: EvidenceOptions = {}): PrimeEvidence {
  const now = options.now ?? (() => new Date());
  const sink = options.audit;
  let sequence = 0;

  /**
   * Builds and writes, catching everything. A failure is reported, never
   * propagated.
   *
   * The BUILDER runs inside the try, not before it. An earlier version took a
   * finished record, which meant constructing one from a malformed execution
   * context threw out of here and killed the workflow — evidence taking down
   * the work it was only supposed to describe. A test with a stub context
   * found it, and it would have been a genuinely nasty production failure:
   * the audit path crashing precisely when the state is already strange.
   */
  const write = async (build: () => unknown, action: string): Promise<void> => {
    if (!sink) return;
    try {
      // Parsed before it is handed over. A malformed record rejected by the
      // sink's own schema would be reported as a sink failure, which points a
      // reader at the wrong system — this fails here, where the mistake is.
      const parsed = auditRecordSchema.parse(build());
      await sink.record(parsed);
    } catch (cause) {
      options.onSinkFailure?.({
        action,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
  };

  const base = (context: PrimeExecutionContext, action: string) => ({
    // Dots and hyphens only. `identifierSchema` rejects `/`.
    auditEventId: `prime.evt.${now().getTime()}.${(sequence += 1)}`,
    occurredAt: now().toISOString(),
    // Mapped, not copied. Prime's actor vocabulary and AuditIQ's are different
    // closed sets: Prime says "system", the audit schema offers
    // human/service/engine/agent/host/external and rejects anything else. I
    // wrote `{ kind: "system", id }` from memory and the schema refused it on
    // three counts at once — wrong enum member, wrong field name (`actorId`),
    // and an unrecognised key, because the actor is `.strict()`.
    //
    // Worth noting the failure surfaced exactly as designed: through
    // `onSinkFailure`, with the workflow unaffected.
    actor: { kind: AUDIT_ACTOR_KIND[context.actor.kind], actorId: context.actor.id },
    tenant: context.tenant ?? { organizationId: "system", roles: [] },
    component: "hive.prime.prime",
    action,
    executionId: context.executionId,
    trace: context.trace,
    ...(context.authorizationRef ? { governanceDecisionId: context.authorizationRef } : {}),
  });

  return {
    enabled: Boolean(sink),

    async nexusDecided(decision) {
      await write(
        () => ({
          ...base(decision.context, "prime.nexus.decided"),
          outcome: outcomeFor(decision.outcome),
          reason: decision.reason,
          ...(decision.stepId
            ? { target: { type: "workflow-step", id: decision.stepId } }
            : {}),
          // The evidence Nexus already produced, now going somewhere. Joined
          // rather than nested: the field is for small, non-sensitive facts.
          ...(decision.evidence.length > 0
            ? { detail: { evidence: decision.evidence.join("; ") } }
            : {}),
        }),
        "prime.nexus.decided",
      );
    },

    async pulseTransitioned(context, workflowId, verdict) {
      await write(
        () => ({
          ...base(context, "prime.pulse.recovery"),
          outcome: verdict.outcome === "resumed" ? "succeeded" : "partial",
          reason: verdict.reason,
          target: { type: "workflow", id: workflowId },
          detail: {
            // Recorded on every recovery, because a resumed execution whose
            // state was never durable is a different event from one whose was,
            // and only one of them survives a restart.
            durable: String(verdict.durable),
            recoveryOutcome: verdict.outcome,
          },
        }),
        "prime.pulse.recovery",
      );
    },
  };
}

/**
 * Whether writing evidence grants Prime any authority.
 *
 * Always false. A record says what happened; it does not permit it, and a
 * system that could authorize by writing its own audit line would be one where
 * the log is the decision.
 */
export function evidenceGrantsAuthority(): false {
  return false;
}
