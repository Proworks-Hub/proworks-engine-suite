/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/ports/governance.ts
 * Module:   cost-iq-engine / ports
 * Purpose:  Asking permission, for the four things CostIQ must not decide alone.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE SAYS "MAY I", AND CANNOT ANSWER ITSELF
//
// Several modules here already state that something is a governed act —
// promoting an AI suggestion, approving a rate, overriding a price. Until now
// that was a sentence in a doc comment, which is a rule an engine promises to
// follow rather than one it can be held to.
//
// This is the port through which it asks. Four actions, closed:
//
//   SAVE_APPROVED_RATE     a rate becomes what estimates are built on.
//   MANUAL_PRICE_OVERRIDE  a person replaces a computed figure with a chosen one.
//   PROMOTE_KNOWLEDGE      a suggestion becomes evidence.
//   CHANGE_COST_POLICY     the rules that decide which evidence wins change.
//
// The list is closed because an open one is not a boundary. If a fifth
// governed action appears, adding it here is a deliberate act somebody reviews
// — which is the entire point.
//
// FAIL CLOSED, AND SAY SO
//
// No port bound means no permission. Not "allowed by default because nothing
// is configured" — that is the failure mode where a system is safe in
// production and wide open in every environment where somebody forgot to wire
// it up. `NO_GOVERNANCE` refuses everything and names itself in the reason, so
// a developer who hits it learns what is missing rather than what is broken.
//
// WHAT THIS PORT IS NOT
//
// It is not authentication and it is not a permission cache. CostIQ does not
// know who anybody is; it passes through the principal the host established
// and takes the answer it is given. An engine that could decide its own
// authority would be an engine that approves its own inputs.
// ─────────────────────────────────────────────────────────────────────────────

export const GOVERNED_ACTIONS = [
  "SAVE_APPROVED_RATE",
  "MANUAL_PRICE_OVERRIDE",
  "PROMOTE_KNOWLEDGE",
  "CHANGE_COST_POLICY",
] as const;
export type GovernedAction = (typeof GOVERNED_ACTIONS)[number];

/** Why each action is governed. Data, so a host can show it at the prompt. */
export const WHY_GOVERNED: Readonly<Record<GovernedAction, string>> = Object.freeze({
  SAVE_APPROVED_RATE:
    "An approved rate becomes what every estimate built afterwards rests on. Getting it wrong is not one wrong number; it is every quote until somebody notices.",
  MANUAL_PRICE_OVERRIDE:
    "Replacing a computed figure with a chosen one breaks the chain between the evidence and the answer. Sometimes correct, never routine, and it has to be attributable to a person.",
  PROMOTE_KNOWLEDGE:
    "A suggestion becoming evidence is the moment something unverified starts being treated as fact. CostIQ deliberately has no code path that does this on its own.",
  CHANGE_COST_POLICY:
    "The policy decides which evidence wins and how long it stays fresh. Changing it silently re-decides every estimate that has not been frozen.",
});

export const governanceRequestSchema = z
  .object({
    /** Which deployment is asking. */
    instanceId: z.string().min(1),
    tenantId: z.string().min(1),
    /**
     * Who is asking, as the HOST established it.
     *
     * Passed through, never derived. CostIQ has no way to authenticate anybody
     * and must not appear to.
     */
    principalId: z.string().min(1),
    action: z.enum(GOVERNED_ACTIONS),
    /** What the action is about. */
    resourceId: z.string().min(1),
    /** The requester's own words, for the audit record and for the prompt. */
    justification: z.string().max(1000).optional(),
    /** Required with no default, the same rule the rest of the engine uses. */
    isTest: z.boolean(),
  })
  .strict();
export type GovernanceRequest = z.infer<typeof governanceRequestSchema>;

export interface GovernanceDecision {
  readonly allowed: boolean;
  /**
   * The decision's own id, so the action can point at what authorized it.
   *
   * Required even on a refusal: "we asked and were told no" is a fact worth
   * being able to find later, and a refusal with no record is indistinguishable
   * from never having asked.
   */
  readonly decisionId: string;
  readonly reason: string;
  readonly decidedAt: string;
}

export interface CostGovernancePort {
  authorize(request: GovernanceRequest): Promise<GovernanceDecision>;
}

/**
 * The port when a host has bound nothing.
 *
 * Refuses everything. Exported rather than left implicit so a host can bind it
 * deliberately in a context where governed actions genuinely should not be
 * possible — a read-only reporting deployment, say — and so the fail-closed
 * behaviour is a thing with a name rather than the absence of one.
 */
export const NO_GOVERNANCE: CostGovernancePort = Object.freeze({
  authorize: async (request: GovernanceRequest): Promise<GovernanceDecision> => ({
    allowed: false,
    decisionId: `no-governance:${request.action}:${request.resourceId}`,
    reason: `No governance port is bound, so "${request.action}" is refused. This is not a failure — it is the fail-closed default. ${WHY_GOVERNED[request.action]} Bind a governance port to make this action possible.`,
    decidedAt: "1970-01-01T00:00:00.000Z",
  }),
});

export type AuthorizationOutcome =
  | { readonly authorized: true; readonly decision: GovernanceDecision }
  | { readonly authorized: false; readonly reason: string; readonly decision: GovernanceDecision | null };

/**
 * Asks, and treats anything other than a clear yes as a no.
 *
 * A port that throws, hangs, or returns something malformed must not produce
 * an allow. Governance failing open is worse than governance failing loudly,
 * because the failure is invisible exactly when it matters.
 */
export async function requestAuthorization(
  port: CostGovernancePort,
  raw: unknown,
): Promise<AuthorizationOutcome> {
  const parsed = governanceRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      authorized: false,
      decision: null,
      reason: `The authorization request is malformed, so nothing was asked: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  let decision: GovernanceDecision;
  try {
    decision = await port.authorize(parsed.data);
  } catch (error) {
    // The message is not interpolated. A thrown value from a bound port is
    // untrusted input, and a reason that quoted it could carry anything into
    // an audit log.
    return {
      authorized: false,
      decision: null,
      reason: `The governance port threw while deciding "${parsed.data.action}". Treated as a refusal: an engine that allowed an action because the authorizer errored would fail open exactly when something is already wrong.`,
    };
  }

  if (typeof decision?.allowed !== "boolean" || typeof decision?.decisionId !== "string" || decision.decisionId.length === 0) {
    return {
      authorized: false,
      decision: null,
      reason: `The governance port returned something that is not a decision. Treated as a refusal — an unreadable answer is not a yes.`,
    };
  }

  if (!decision.allowed) {
    return { authorized: false, decision, reason: decision.reason };
  }
  return { authorized: true, decision };
}

/**
 * Whether CostIQ can authorize any of this on its own.
 *
 * Always false, and a function rather than a comment so a test asserts it.
 */
export function engineMayAuthorizeItself(): false {
  return false;
}
