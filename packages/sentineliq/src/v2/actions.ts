// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { EvidenceReference, Severity } from "../finding.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel V2 §13/§21.3/§21.6 — the defensive action ladder, containment
// action records, incidents, and the Hive immune response protocol.
//
// The ladder's default goal, quoted because it is the design: "contain,
// revoke, recover and verify — not uncontrolled destruction." Destructive
// cleanup happens only through an authorized host/security mechanism with
// evidence, rollback/recovery planning where applicable, and policy
// authorization. Sentinel REQUESTS; Security IQ / Fabric / host adapters
// execute. This ladder is the V2 OPERATIONAL containment vocabulary; the V1
// constitutional ladder (warn → emergency_protective_state, defense.ts) stays
// authoritative for protective state, and neither replaces the other
// (DEC-027 point 3).
// ─────────────────────────────────────────────────────────────────────────────

export const ACTION_LADDER = [
  "observe", // collect/validate evidence; no state-changing defense
  "challenge", // stronger identity/session/workload verification; reduce trust TTL
  "throttle", // policy-preapproved rate limiting / capability reduction
  "segment", // fabric/Security microsegmentation and route restriction
  "quarantine", // isolate into a governed forensic zone
  "revoke", // pre-chartered credential/session/capability revocation via Security IQ
  "recover", // coordinate rebuild/rotation/re-attestation and staged return
  "escalate", // Governance + authorized human decision for destructive/constitutional/exceptional acts
] as const;
export const actionRungSchema = z.enum(ACTION_LADDER);
export type ActionRung = z.infer<typeof actionRungSchema>;

export function destructiveness(rung: ActionRung): number {
  return ACTION_LADDER.indexOf(rung);
}

/**
 * §21.3 selection: the LEAST-destructive rung capable of stopping the spread.
 * The order is data, the selection is a function — because incident pressure
 * runs one way: reach for the biggest lever and justify it afterwards.
 */
export function selectLeastDestructive(candidateRungsThatWouldContain: readonly ActionRung[]): ActionRung | null {
  if (candidateRungsThatWouldContain.length === 0) return null;
  return [...candidateRungsThatWouldContain].sort((a, b) => destructiveness(a) - destructiveness(b))[0]!;
}

// ── §13 · the containment action record ─────────────────────────────────────

/** Every automatic containment action has reason, evidence, scope, TTL or a
 * rollback plan, and a post-incident review requirement — all REQUIRED at
 * construction, none defaulted. */
export const containmentActionSchema = z
  .object({
    actionId: z.string().min(1),
    rung: actionRungSchema,
    reason: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).min(1),
    /** What exactly is contained — never "everything". */
    scopeRef: z.string().min(1),
    /** Bounded: a TTL, or an explicit rollback plan where TTLs make no sense. */
    ttlSeconds: z.number().int().positive().optional(),
    rollbackPlanRef: z.string().min(1).optional(),
    postIncidentReviewRequired: z.literal(true),
    /** Sentinel requests; the mechanism owner executes. */
    executedBy: z.enum(["security-iq", "fabric", "host-adapter"]),
    charteredAuthorityRef: z.string().min(1),
  })
  .strict()
  .refine((a) => a.ttlSeconds !== undefined || a.rollbackPlanRef !== undefined, {
    message: "A containment action is bounded: it carries a TTL or an explicit rollback plan.",
  });
export type ContainmentAction = z.infer<typeof containmentActionSchema>;

export type ContainmentRequestOutcome =
  | { readonly ok: true; readonly action: ContainmentAction }
  | { readonly ok: false; readonly reason: string };

export function requestContainment(input: {
  actionId: string;
  rung: ActionRung;
  reason: string;
  evidenceRefs: readonly string[];
  scopeRef: string;
  ttlSeconds?: number;
  rollbackPlanRef?: string;
  executedBy: "security-iq" | "fabric" | "host-adapter";
  charteredAuthorityRef: string | undefined;
  governanceAuthorized: boolean;
}): ContainmentRequestOutcome {
  if (input.rung === "escalate") {
    // Escalate is not a containment action — it is the handoff to Governance
    // and an authorized human. It cannot be "executed".
    return { ok: false, reason: "escalate is a decision handoff, not a containment mechanism; route to Governance." };
  }
  if (input.charteredAuthorityRef === undefined) {
    return { ok: false, reason: "Only explicitly chartered containment may be requested; no charter reference, no request." };
  }
  if ((input.rung === "quarantine" || input.rung === "revoke") && !input.governanceAuthorized && input.ttlSeconds === undefined) {
    // Pre-authorized emergency containment must be narrowly scoped, auditable
    // and REVERSIBLE (§7): without Governance in the loop, the high rungs
    // must self-expire.
    return { ok: false, reason: `${input.rung} without Governance authorization requires a TTL: emergency containment is reversible by construction.` };
  }
  const parsed = containmentActionSchema.safeParse({
    actionId: input.actionId,
    rung: input.rung,
    reason: input.reason,
    evidenceRefs: input.evidenceRefs,
    scopeRef: input.scopeRef,
    ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    ...(input.rollbackPlanRef !== undefined ? { rollbackPlanRef: input.rollbackPlanRef } : {}),
    postIncidentReviewRequired: true,
    executedBy: input.executedBy,
    charteredAuthorityRef: input.charteredAuthorityRef,
  });
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid containment action" };
  }
  return { ok: true, action: parsed.data };
}

/**
 * §13: "Containment must succeed even if best-effort event publication
 * fails; event publishing cannot be a prerequisite for an emergency safety
 * action." The dependency direction is a fact of the return type: the
 * containment outcome is decided BEFORE publication is attempted, and a
 * publication failure downgrades nothing.
 */
export function containThenPublish(
  action: ContainmentAction,
  execute: (action: ContainmentAction) => boolean,
  publish: (action: ContainmentAction) => boolean,
): { contained: boolean; published: boolean; publicationFailureRecorded: boolean } {
  const contained = execute(action);
  let published = false;
  try {
    published = publish(action);
  } catch {
    published = false;
  }
  return { contained, published, publicationFailureRecorded: contained && !published };
}

/** §13: a false-positive containment is a SERIOUS reliability failure — it
 * becomes a permanent benchmark scenario, not a quietly-released mistake. */
export interface FalsePositiveRecord {
  readonly actionId: string;
  readonly declaredFalsePositiveBy: string; // human principal
  readonly permanentBenchmarkScenarioRef: string;
  readonly severity: Severity;
}

export function recordFalsePositiveContainment(
  actionId: string,
  declaredBy: string,
  benchmarkScenarioRef: string,
): FalsePositiveRecord {
  return {
    actionId,
    declaredFalsePositiveBy: declaredBy,
    permanentBenchmarkScenarioRef: benchmarkScenarioRef,
    severity: "high",
  };
}

// ── §21.6 · the Hive immune response protocol ───────────────────────────────

export const IMMUNE_STEPS = [
  "detect", // Shield/Threat specialists identify a signal; raw evidence PRESERVED
  "verify", // Guard/Integrity/Trust independently validate identity, scope, evidence quality
  "classify", // severity, blast radius, security condition level
  "contain", // least-destructive pre-authorized action to stop spread
  "analyze", // ARIA/Collective ADVISORY intelligence; private evidence stays local
  "sandbox", // Foundry constructs an isolated reproduction / defensive candidate
  "authorize", // Governance/human chain approves actions above pre-chartered authority
  "recover", // restore trusted state, rotate credentials, re-attest, reconcile
  "learn", // generalized lessons -> governed CandidateKnowledge + permanent tests
  "review", // verify no defensive action silently expanded Sentinel authority
] as const;
export type ImmuneStep = (typeof IMMUNE_STEPS)[number];

export interface IncidentState {
  readonly incidentId: string;
  readonly severity: Severity;
  readonly blastRadiusRef: string;
  readonly stepsCompleted: readonly ImmuneStep[];
  readonly evidenceRefs: readonly EvidenceReference[];
  /** §13: preserve forensic evidence BEFORE destructive cleanup. */
  readonly forensicEvidencePreserved: boolean;
}

export type StepAdvanceOutcome =
  | { readonly ok: true; readonly state: IncidentState }
  | { readonly ok: false; readonly reason: string };

/**
 * Steps advance in order; verification is independent of detection (a Shield
 * signal is not verified by Shield agreeing with itself); the review step —
 * "no defensive action silently expanded Sentinel authority" — is part of
 * the protocol, not an optional epilogue.
 */
export function advanceImmuneStep(
  state: IncidentState,
  step: ImmuneStep,
  options?: { verifiedByChamber?: "shield" | "guard"; destructiveCleanupPlanned?: boolean },
): StepAdvanceOutcome {
  const expectedIndex = state.stepsCompleted.length;
  const expected = IMMUNE_STEPS[expectedIndex];
  if (expected === undefined) return { ok: false, reason: "Protocol already complete." };
  if (step !== expected) {
    return { ok: false, reason: `Immune protocol advances in order: expected "${expected}", got "${step}".` };
  }
  if (step === "verify" && options?.verifiedByChamber !== "guard") {
    return { ok: false, reason: "Verification is INDEPENDENT: Guard-side specialists validate a Shield detection, not Shield itself." };
  }
  if (step === "recover" && options?.destructiveCleanupPlanned === true && !state.forensicEvidencePreserved) {
    return { ok: false, reason: "Forensic evidence is preserved before destructive cleanup where operationally safe; nothing is preserved here." };
  }
  return { ok: true, state: { ...state, stepsCompleted: [...state.stepsCompleted, step] } };
}
