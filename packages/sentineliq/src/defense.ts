// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { Confidence, Finding, Severity } from "./finding.js";

// ─────────────────────────────────────────────────────────────────────────────
// Defensive authority: what Sentinel may do about what it found.
//
// Charter §6 lists the actions. Charter §7 governs which one: "Sentinel shall
// prefer the least disruptive defensive response capable of adequately
// protecting the Hive. When lesser action cannot protect users or the Hive,
// Sentinel may protect the whole by stopping the whole."
//
// That is a selection rule with an ORDER, so the order is data and the
// selection is a function. Written as a ladder rather than left to judgement at
// each call site, because the pressure during an incident runs one way: reach
// for the biggest lever available and justify it afterwards.
//
// DEFENSIVE, NOT RETALIATORY (§17)
//
// Every response below acts on the HIVE — its own sessions, engines,
// integrations, deployments and automation. None reaches outward at a suspected
// attacker. There is no counter-action, no takedown, no probe-the-source. A
// test asserts the vocabulary stays that way, because "defensive" is a property
// of the list, not of the intent behind it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Charter §6's actions, ordered by how much of the Hive they stop.
 *
 * The order IS the constitutional rule, so it lives in one array rather than
 * being re-derived. `warn` costs nobody anything; `emergency_protective_state`
 * stops the whole Hive.
 */
export const DEFENSIVE_LADDER = [
  "warn",
  "require_validation",
  "suspend_session",
  "restrict_access",
  "revoke_access",
  "block_deployment",
  "stop_automation",
  "restrict_data_movement",
  "isolate_integration",
  "quarantine_engine",
  "protected_mode",
  "emergency_protective_state",
] as const;

export const defensiveResponseSchema = z.enum(DEFENSIVE_LADDER);
export type DefensiveResponse = z.infer<typeof defensiveResponseSchema>;

/** How disruptive a response is. Lower is gentler. */
export function disruptionOf(response: DefensiveResponse): number {
  return DEFENSIVE_LADDER.indexOf(response);
}

/**
 * The severity a response needs before it may be used at all.
 *
 * A ceiling, not a trigger — it says what a response may NEVER be used below,
 * never that a severity requires one. §13 puts Emergency Protective State
 * behind "catastrophic compromise" explicitly; the rest are graded from §7's
 * proportionality requirement.
 */
const MINIMUM_SEVERITY: Readonly<Record<DefensiveResponse, Severity>> = Object.freeze({
  warn: "informational",
  require_validation: "low",
  suspend_session: "low",
  restrict_access: "moderate",
  revoke_access: "moderate",
  block_deployment: "moderate",
  stop_automation: "high",
  restrict_data_movement: "high",
  isolate_integration: "high",
  quarantine_engine: "high",
  protected_mode: "high",
  emergency_protective_state: "catastrophic",
});

const SEVERITY_ORDER: readonly Severity[] = [
  "informational",
  "low",
  "moderate",
  "high",
  "catastrophic",
];

function atLeast(actual: Severity, required: Severity): boolean {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(required);
}

export type ResponseSelection =
  | {
      readonly selected: DefensiveResponse;
      readonly rejected: readonly { response: DefensiveResponse; because: string }[];
      /**
       * Set when acting on something not yet confirmed.
       *
       * Not a refusal. Waiting for certainty while data leaves the building is
       * its own failure, and §18 puts protection ahead of availability. But the
       * fact that Sentinel acted on suspicion has to travel WITH the action,
       * because it is the thing a reviewer will need and the thing that is
       * easiest to lose.
       */
      readonly actedOnSuspicion?: { confidence: Confidence; uncertainty: string };
    }
  | { readonly selected: null; readonly reason: string; readonly rejected: readonly { response: DefensiveResponse; because: string }[] };

/**
 * Picks the least disruptive response that adequately protects the Hive.
 *
 * ADEQUACY IS AN INPUT, NOT A DERIVATION. The caller — the detector that
 * understands this particular compromise — declares which responses would
 * actually contain it. Sentinel then takes the gentlest of those. Deriving
 * adequacy from severity here would mean this file claiming to know what
 * contains a data exfiltration versus a supply-chain compromise, which it does
 * not and cannot.
 *
 * What this function owns is the constitutional half: minimum disruption, and
 * the severity floor under each rung.
 */
export function selectResponse(input: {
  finding: Finding;
  /** Responses the detector believes would adequately protect the Hive. */
  adequate: readonly DefensiveResponse[];
}): ResponseSelection {
  const rejected: { response: DefensiveResponse; because: string }[] = [];

  if (input.adequate.length === 0) {
    return {
      selected: null,
      reason:
        "No response was declared adequate. Sentinel does not invent one: a defensive action nobody believes will contain the problem is disruption without protection.",
      rejected,
    };
  }

  const permitted = [...input.adequate]
    .filter((response) => {
      const floor = MINIMUM_SEVERITY[response];
      if (atLeast(input.finding.severity, floor)) return true;
      rejected.push({
        response,
        because: `${response} requires at least ${floor} severity; this finding is ${input.finding.severity}.`,
      });
      return false;
    })
    .sort((a, b) => disruptionOf(a) - disruptionOf(b));

  if (permitted.length === 0) {
    return {
      selected: null,
      reason: `Every adequate response exceeds what a ${input.finding.severity} finding justifies. Escalate the severity assessment or find a lesser containment — do not reach past the ceiling.`,
      rejected,
    };
  }

  const selected = permitted[0]!;

  // Everything gentler was already excluded as inadequate by the caller;
  // everything harsher is recorded as passed over, which is the evidence that
  // §7 was actually applied rather than merely intended.
  for (const response of permitted.slice(1)) {
    rejected.push({
      response,
      because: `More disruptive than ${selected}, which the detector declared adequate. Charter §7: prefer the least disruptive response capable of adequately protecting the Hive.`,
    });
  }

  if (input.finding.confidence !== "confirmed") {
    return {
      selected,
      rejected,
      actedOnSuspicion: {
        confidence: input.finding.confidence,
        uncertainty: input.finding.uncertainty ?? "not stated",
      },
    };
  }

  return { selected, rejected };
}

// ─────────────────────────────────────────────────────────────────────────────
// Protective state and emergency authority.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A restriction Sentinel has placed on the Hive.
 *
 * `expiresAt` is REQUIRED, not optional. Charter §8: "A Governance-approved
 * action may still be TEMPORARILY restricted when Sentinel detects active
 * compromise." A restriction with no expiry is Sentinel amending Governance
 * policy by outlasting it, which §8 forbids in the next sentence — "Sentinel
 * shall not permanently rewrite Governance policy."
 *
 * Extending a restriction means issuing a new one, with a new justification.
 * That is deliberate friction: a standing restriction that renews itself
 * silently is a permanent one.
 */
export const protectiveRestrictionSchema = z
  .object({
    restrictionId: z.string().min(1),
    response: defensiveResponseSchema,
    /** The finding that justifies it. Never absent. */
    findingId: z.string().min(1),
    subjectId: z.string().min(1),
    declaredAt: z.string().min(1),
    /** REQUIRED. See above. */
    expiresAt: z.string().min(1),
    reason: z.string().min(1),
    /** What has to become true for this to be lifted early. */
    liftedWhen: z.string().min(1).optional(),
  })
  .strict()
  .refine((r) => new Date(r.expiresAt) > new Date(r.declaredAt), {
    message:
      "A restriction must expire after it was declared. A restriction that never expires is Sentinel rewriting Governance policy by outlasting it (Charter §8).",
    path: ["expiresAt"],
  });
export type ProtectiveRestriction = z.infer<typeof protectiveRestrictionSchema>;

/** True once a restriction has lapsed and no longer restricts anything. */
export function restrictionActive(restriction: ProtectiveRestriction, now: Date): boolean {
  return now < new Date(restriction.expiresAt);
}

/**
 * Hive Emergency Protective State.
 *
 * Charter §13: Sentinel "may activate Emergency Protective State when
 * catastrophic compromise threatens users, protected data, constitutional
 * integrity, or Hive survival. Emergency authority shall DECAY when the
 * emergency ends."
 *
 * §17: "Emergency power does not become ordinary power."
 *
 * So the expiry is required and the decay is a function of time rather than of
 * somebody remembering to stand down. An emergency that has to be actively
 * ended is one that quietly becomes the new normal.
 */
export const emergencyProtectiveStateSchema = z
  .object({
    emergencyId: z.string().min(1),
    declaredAt: z.string().min(1),
    /** REQUIRED. Emergency authority decays; it is not revoked by hand. */
    decaysAt: z.string().min(1),
    /** The catastrophic finding. §13 admits no lesser trigger. */
    findingId: z.string().min(1),
    threatens: z.enum(["users", "protected_data", "constitutional_integrity", "hive_survival"]),
    reason: z.string().min(1),
    /** What must be verified before full trust returns (§16). */
    recoveryRequires: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .refine((e) => new Date(e.decaysAt) > new Date(e.declaredAt), {
    message: "Emergency authority must decay after it was declared.",
    path: ["decaysAt"],
  });
export type EmergencyProtectiveState = z.infer<typeof emergencyProtectiveStateSchema>;

/**
 * Whether emergency authority is still in force.
 *
 * After decay Sentinel holds exactly the authority it held before — never more.
 * §17 again: emergency power does not become ordinary power.
 */
export function emergencyInForce(emergency: EmergencyProtectiveState, now: Date): boolean {
  return now < new Date(emergency.decaysAt);
}

/**
 * Charter §16: "Restoration of service is not equivalent to restoration of
 * trust."
 *
 * Returns what still has to be verified. Trust returns when the list is empty,
 * not when the emergency decays — those are different events and conflating
 * them is how a compromised system is welcomed back because the clock ran out.
 */
export function outstandingRecovery(
  emergency: EmergencyProtectiveState,
  verified: readonly string[],
): readonly string[] {
  const done = new Set(verified);
  return emergency.recoveryRequires.filter((requirement) => !done.has(requirement));
}
