/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/security/quarantine.ts
 * Module:   neural-fabric / security
 * Purpose:  Containing a workload without taking the shop down with it.
 */

import { z } from "zod";

import type { Lane } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// QUARANTINE IS A TOPOLOGY STATE, NOT A FIREWALL RULE SOMEBODY ADDED
//
// §34.5 is specific about this: quarantine zones are explicit topology states,
// "not ad-hoc firewall rules hidden in individual engines". The difference
// shows up during recovery. A quarantine expressed in the topology can be
// listed, diffed, simulated and lifted; one expressed as rules scattered across
// engines is found by whoever remembers where they put them.
//
// SIX STATES, BECAUSE CONTAINMENT IS NOT BINARY
//
// The instinct is to have a workload isolated or not. In practice the useful
// question during an incident is "how much less can this do than it could an
// hour ago", and a binary switch forces two bad answers: leave a suspicious
// workload fully connected, or cut it off and lose the forensics along with
// the threat.
//
// OBSERVE keeps everything and watches. RESTRICT removes the dangerous lanes.
// ISOLATE cuts general traffic and keeps the forensic path. FORENSIC is
// investigation only. RECOVERY is coming back under supervision.
// RELEASE_CANDIDATE is "we think it is clean" and is still not released.
//
// THE FORENSIC PATH IS NEVER CUT
//
// Every containment state above OBSERVE keeps a route to Sentinel, Security IQ
// and AuditIQ. Cutting a compromised workload off entirely feels like the
// strongest response and destroys the evidence needed to understand what
// happened — and to know whether anything else is affected.
//
// AND CONTAINMENT MUST NOT TAKE DOWN THE UNRELATED
//
// §34.9 asks for exactly this test: "Quarantine isolates the target without
// unintentionally severing unrelated local Instance operations." A containment
// that stops the shop is one operators will hesitate to use, and hesitation
// during an incident is the thing containment exists to remove.
// ─────────────────────────────────────────────────────────────────────────────

export const quarantineStateSchema = z.enum([
  /** Fully connected, watched closely. The state that costs nothing. */
  "OBSERVE",
  /** State-changing and bulk lanes removed. Reads and evidence continue. */
  "RESTRICT",
  /** General traffic cut. Forensic and evidence routes remain. */
  "ISOLATE",
  /** Investigation only. Nothing but the forensic path. */
  "FORENSIC",
  /** Coming back under supervision, with fresh trust required. */
  "RECOVERY",
  /** Believed clean. Still contained until somebody releases it. */
  "RELEASE_CANDIDATE",
]);
export type QuarantineState = z.infer<typeof quarantineStateSchema>;

export interface QuarantineDefinition {
  readonly state: QuarantineState;
  readonly lanesPermitted: readonly Lane[];
  /** Capabilities reachable regardless of lane — the forensic path. */
  readonly alwaysReachable: readonly string[];
  /** Whether the workload may still originate traffic of its own. */
  readonly mayOriginate: boolean;
  readonly purpose: string;
}

const FORENSIC_PATH: readonly string[] = ["sentinel", "security-iq", "auditiq", "forensics", "sandbox"];

export const QUARANTINE_STATES: Readonly<Record<QuarantineState, QuarantineDefinition>> = Object.freeze({
  OBSERVE: {
    state: "OBSERVE",
    lanesPermitted: ["QUERY", "COMMAND", "EVENT", "STREAM", "WORKFLOW", "EVIDENCE", "HEALTH", "ARTIFACT"],
    alwaysReachable: FORENSIC_PATH,
    mayOriginate: true,
    purpose:
      "Nothing is blocked and everything is watched. The state that costs nothing, so there is no reason to delay entering it while deciding.",
  },
  RESTRICT: {
    state: "RESTRICT",
    lanesPermitted: ["QUERY", "EVENT", "EVIDENCE", "HEALTH"],
    alwaysReachable: FORENSIC_PATH,
    mayOriginate: true,
    purpose:
      "State-changing and bulk lanes removed; reads continue. Enough to stop a compromised workload doing damage while it is still useful to whatever depends on it.",
  },
  ISOLATE: {
    state: "ISOLATE",
    lanesPermitted: ["EVIDENCE", "HEALTH"],
    alwaysReachable: FORENSIC_PATH,
    mayOriginate: false,
    purpose:
      "General traffic cut. The workload is out of the flow and still visible — evidence and health continue so the incident can be watched rather than merely stopped.",
  },
  FORENSIC: {
    state: "FORENSIC",
    lanesPermitted: ["EVIDENCE"],
    alwaysReachable: FORENSIC_PATH,
    mayOriginate: false,
    purpose:
      "Investigation only. Everything else is gone and the forensic path remains, because cutting a compromised workload off entirely destroys the evidence needed to know whether anything else is affected.",
  },
  RECOVERY: {
    state: "RECOVERY",
    lanesPermitted: ["QUERY", "EVIDENCE", "HEALTH"],
    alwaysReachable: FORENSIC_PATH,
    mayOriginate: false,
    purpose:
      "Coming back under supervision. Reads before writes, and it may not originate traffic yet — a workload that has just been contained does not get to start conversations.",
  },
  RELEASE_CANDIDATE: {
    state: "RELEASE_CANDIDATE",
    lanesPermitted: ["QUERY", "EVENT", "EVIDENCE", "HEALTH"],
    alwaysReachable: FORENSIC_PATH,
    mayOriginate: true,
    purpose:
      "Believed clean and still contained. The gap between believing and releasing is where a premature release gets caught.",
  },
});

/** Whether a lane is permitted to a contained workload. */
export function lanePermitted(state: QuarantineState, lane: Lane): boolean {
  return QUARANTINE_STATES[state].lanesPermitted.includes(lane);
}

/**
 * Whether a capability stays reachable whatever the containment.
 *
 * The forensic path. A function so a test can assert it holds in every state,
 * including FORENSIC — which is the state where somebody would most plausibly
 * decide to cut everything.
 */
export function forensicPathIntact(state: QuarantineState): boolean {
  const definition = QUARANTINE_STATES[state];
  return FORENSIC_PATH.every((capability) => definition.alwaysReachable.includes(capability));
}

export interface ContainmentEffect {
  readonly targetNodeId: string;
  readonly state: QuarantineState;
  /** Node ids that lose a route because of this containment. */
  readonly collateral: readonly string[];
  /** True when containment would stop work unrelated to the incident. */
  readonly seversUnrelated: boolean;
  readonly note: string;
}

/**
 * What a containment would cost besides containing the target.
 *
 * §34.9's test, as a function. A containment that stops the shop is one
 * operators hesitate to use, and hesitation during an incident is precisely
 * what containment exists to remove — so the cost is computed BEFORE the
 * decision rather than discovered after it.
 */
export function assessContainment(
  targetNodeId: string,
  state: QuarantineState,
  /** Who depends on the target, and whether each has another provider. */
  dependants: readonly { readonly nodeId: string; readonly hasAlternative: boolean }[],
): ContainmentEffect {
  if (state === "OBSERVE") {
    return {
      targetNodeId,
      state,
      collateral: [],
      seversUnrelated: false,
      note: "OBSERVE blocks nothing, so it has no collateral. There is no reason to delay entering it while deciding what to do.",
    };
  }

  const stranded = dependants.filter((d) => !d.hasAlternative).map((d) => d.nodeId).sort();

  return {
    targetNodeId,
    state,
    collateral: stranded,
    seversUnrelated: stranded.length > 0,
    note:
      stranded.length === 0
        ? `Containing ${targetNodeId} at ${state} affects nothing else — every dependant has another provider. This is the containment to reach for.`
        : `Containing ${targetNodeId} at ${state} would strand ${stranded.length} dependant${stranded.length === 1 ? "" : "s"} with no alternative: ${stranded.join(", ")}. That is a real cost and it is not automatically the wrong trade — but it is the operator's trade to make, and it is stated before the decision rather than discovered after it.`,
  };
}

export type ReleaseVerdict =
  | { readonly released: true; readonly reason: string }
  | { readonly released: false; readonly reason: string; readonly missing: readonly string[] };

/**
 * Whether a contained workload may be released.
 *
 * §34.5 requires fresh trust evidence and, for high-risk incidents, governed
 * approval. Both are checked, and a release straight from FORENSIC is refused
 * — a workload under investigation has not been through recovery, and skipping
 * it means releasing something nobody has watched behave.
 */
export function mayRelease(input: {
  readonly from: QuarantineState;
  readonly freshTrustEvidenceRef: string | null;
  readonly highRisk: boolean;
  readonly governanceDecisionRef: string | null;
}): ReleaseVerdict {
  const missing: string[] = [];

  if (input.from === "FORENSIC" || input.from === "ISOLATE") {
    return {
      released: false,
      missing: ["a period in RECOVERY"],
      reason: `Release from ${input.from} is refused. A workload that has been isolated or investigated has not been watched behaving normally since, and RECOVERY exists to provide that — releasing straight from containment means releasing something nobody has seen work.`,
    };
  }

  if (input.freshTrustEvidenceRef === null) {
    missing.push("fresh trust evidence");
  }
  if (input.highRisk && input.governanceDecisionRef === null) {
    missing.push("a governance decision for a high-risk release");
  }

  if (missing.length > 0) {
    return {
      released: false,
      missing,
      reason: `Release needs ${missing.join(" and ")}. Trust from before the incident is not evidence about after it.`,
    };
  }

  return {
    released: true,
    reason: `Released from ${input.from} on fresh trust evidence${input.highRisk ? " and a governance decision" : ""}.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IMMUNE SIGNALS
// ─────────────────────────────────────────────────────────────────────────────

export const immuneSignalSchema = z
  .object({
    signalId: z.string().min(1),
    /** What Sentinel believes is happening. */
    threatRef: z.string().min(1),
    /** What it is asking the Fabric to do. */
    requestedAction: z.enum(["OBSERVE", "RESTRICT", "ISOLATE", "QUARANTINE_ZONE", "REROUTE", "RAISE_POSTURE"]),
    affectedNodeIds: z.array(z.string().min(1)).min(1).max(500),
    /** How sure Sentinel is, 0–100. Carried so the Fabric can weigh urgency. */
    confidence: z.number().min(0).max(100),
    evidenceRefs: z.array(z.string().min(1)).max(50).default([]),
    /**
     * The authority for the requested action.
     *
     * Nullable, because a PRE-APPROVED emergency action does not need a fresh
     * decision — §34.5 permits that explicitly. Null means "relying on standing
     * policy", which is checked rather than assumed.
     */
    authorizationRef: z.string().min(1).nullable(),
    urgency: z.enum(["ROUTINE", "PROMPT", "IMMEDIATE"]),
    expiresAt: z.string().min(1),
    /** So an emergency action can be undone. */
    rollbackCriteria: z.string().min(1),
    correlationId: z.string().min(1),
    causationId: z.string().min(1).nullable(),
  })
  .strict();
export type ImmuneSignal = z.infer<typeof immuneSignalSchema>;

export type ImmuneOutcome =
  | { readonly act: true; readonly action: ImmuneSignal["requestedAction"]; readonly reason: string }
  | { readonly act: false; readonly reason: string };

/**
 * Whether the Fabric acts on a security signal.
 *
 * Sentinel detects and requests; the Fabric executes only what policy already
 * permits. §34.2 is explicit that "Sentinel cannot manufacture authorization
 * merely because a threat exists" — so a request for an action that is not
 * pre-approved and carries no authorization is refused, however urgent.
 *
 * The exception is deliberately narrow: actions that only ever REDUCE what a
 * workload can do may run on standing policy, because the cost of a false
 * positive is availability and the cost of hesitating is a live compromise.
 */
export function evaluateImmuneSignal(
  signal: ImmuneSignal,
  policy: {
    readonly preApprovedActions: readonly ImmuneSignal["requestedAction"][];
    readonly minimumConfidence: number;
  },
  now: string,
): ImmuneOutcome {
  if (now >= signal.expiresAt) {
    return {
      act: false,
      reason: `The signal expired at ${signal.expiresAt}. Acting on a stale threat assessment means containing something for a reason that may already have been resolved.`,
    };
  }

  if (signal.authorizationRef !== null) {
    return {
      act: true,
      action: signal.requestedAction,
      reason: `Authorized by ${signal.authorizationRef}. The Fabric applies the containment; Sentinel decided it and Governance permitted it.`,
    };
  }

  if (!policy.preApprovedActions.includes(signal.requestedAction)) {
    return {
      act: false,
      reason: `"${signal.requestedAction}" is not pre-approved and this signal carries no authorization. A threat existing does not create authority to act on it — Sentinel requests, and something with authority decides.`,
    };
  }

  if (signal.confidence < policy.minimumConfidence) {
    return {
      act: false,
      reason: `Confidence is ${signal.confidence}, below the ${policy.minimumConfidence} required for an unauthorized pre-approved action. A low-confidence signal acting on standing policy alone is how a noisy detector becomes a denial of service.`,
    };
  }

  return {
    act: true,
    action: signal.requestedAction,
    reason: `Acting on standing policy: "${signal.requestedAction}" is pre-approved and confidence is ${signal.confidence}. This action only reduces what the target can do, so a false positive costs availability while hesitating costs a live compromise.`,
  };
}

/**
 * Whether an immune signal can widen access.
 *
 * Always false. Every action in the vocabulary restricts or reroutes; none
 * grants. A security signal that could open a path would make "declare an
 * incident" the shortest route to more access.
 */
export function immuneSignalMayWiden(): false {
  return false;
}
