/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/topologyIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  Letting something join the Fabric, one gate at a time.
 */

import { z } from "zod";

import { laneSchema, type Lane } from "../domain/lanes.js";
import { zoneKindSchema, type ZoneKind } from "../domain/topology.js";

// ─────────────────────────────────────────────────────────────────────────────
// ADMISSION IS A SEQUENCE, AND THE ORDER IS LOAD-BEARING
//
// §23 lists nine steps and they are not interchangeable. Identity is
// established before contracts are checked, contracts before topology is
// proposed, topology before Governance is consulted, and Governance before
// anything is activated.
//
// Reordering any of them produces a specific failure. Check contracts before
// identity and you have told an unauthenticated caller which capabilities
// exist. Propose topology before Governance and the proposal itself becomes
// the decision, because by the time anybody reviews it the connection is the
// obvious next step. Activate before Pulse observes and the first evidence
// about a new path arrives after it is already carrying traffic.
//
// So admission is modelled as a state machine that can only move forward, and
// `nextStep` says what is outstanding rather than returning a boolean. A
// participant that cannot join should learn WHICH gate it is at, because that
// is the difference between a five-minute fix and a support ticket.
//
// AND ADMISSION GRANTS NOTHING BY ITSELF
//
// The end state is ADMITTED, which means the node exists in the topology. It
// does not mean the node can reach anything: every adjacency is still a
// separate governed decision. This is the point most likely to be lost, because
// "we admitted it" sounds like "it works now" and every other system in the
// industry behaves that way.
// ─────────────────────────────────────────────────────────────────────────────

export const admissionStageSchema = z.enum([
  /** A participant has asked to join. Nothing has been checked. */
  "REQUESTED",
  /** Security IQ has confirmed who it is. */
  "IDENTIFIED",
  /** Its declared contracts are compatible with what it wants to speak to. */
  "CONTRACTS_VERIFIED",
  /** A topology attachment has been proposed within permitted structure. */
  "TOPOLOGY_PROPOSED",
  /** Governance has decided, where the attachment needed a decision. */
  "GOVERNED",
  /** The topology version carrying it is active. */
  "ADMITTED",
  /** Refused, with a reason. A terminal state, and a normal outcome. */
  "REFUSED",
]);
export type AdmissionStage = z.infer<typeof admissionStageSchema>;

const ORDER: readonly AdmissionStage[] = [
  "REQUESTED",
  "IDENTIFIED",
  "CONTRACTS_VERIFIED",
  "TOPOLOGY_PROPOSED",
  "GOVERNED",
  "ADMITTED",
];

export const admissionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    nodeId: z.string().min(1),
    instanceId: z.string().min(1),
    zoneKind: zoneKindSchema,
    capabilities: z.array(z.string().min(1)).min(1).max(200),
    /** The lanes it wants to use. Declared up front so they can be checked. */
    lanesRequested: z.array(laneSchema).min(1),
    /**
     * Established by Security IQ, referenced here.
     *
     * Null at REQUESTED and required to leave it. The Fabric never verifies
     * identity itself — §20 gives that to Security IQ, and an engine that
     * verified identity would be an engine with its own trust root.
     */
    workloadIdentityRef: z.string().min(1).nullable(),
    isTest: z.boolean(),
  })
  .strict();
export type AdmissionRequest = z.infer<typeof admissionRequestSchema>;

export interface AdmissionState {
  readonly requestId: string;
  readonly stage: AdmissionStage;
  readonly refusalReason: string | null;
  /** Every stage passed, with when and why. Admission is auditable or it is not real. */
  readonly history: readonly { readonly stage: AdmissionStage; readonly at: string; readonly note: string }[];
}

export interface StageEvidence {
  readonly identityVerified: boolean;
  readonly contractsCompatible: boolean;
  readonly topologyProposalRef: string | null;
  /** Null when no governed decision was required. */
  readonly governanceDecisionRef: string | null;
  readonly requiresGovernance: boolean;
  readonly topologyVersionActive: boolean;
}

export type NextStep =
  | { readonly done: true; readonly note: string }
  | { readonly blocked: true; readonly stage: AdmissionStage; readonly needs: string; readonly note: string }
  | { readonly advanceTo: AdmissionStage; readonly note: string };

/**
 * What is outstanding, rather than whether it is finished.
 *
 * A participant that cannot join learns WHICH gate it is at. "Admission
 * failed" produces a support ticket; "your identity is not established with
 * Security IQ" produces a fix.
 */
export function nextStep(state: AdmissionState, evidence: StageEvidence): NextStep {
  if (state.stage === "REFUSED") {
    return {
      blocked: true,
      stage: "REFUSED",
      needs: "a new request",
      note: `This request was refused: ${state.refusalReason ?? "(no reason recorded, which is itself a problem)"}. A refusal is terminal — reapplying means a new request, so the refusal stays in the record.`,
    };
  }

  if (state.stage === "ADMITTED") {
    return {
      done: true,
      note: "Admitted. The node exists in the topology, which is NOT the same as being able to reach anything — every adjacency is a separate governed decision, and nothing has granted one yet.",
    };
  }

  switch (state.stage) {
    case "REQUESTED":
      if (!evidence.identityVerified) {
        return {
          blocked: true,
          stage: "REQUESTED",
          needs: "a verified workload identity from Security IQ",
          note: "Identity comes first. Checking contracts before identity would tell an unauthenticated caller which capabilities exist.",
        };
      }
      return { advanceTo: "IDENTIFIED", note: "Identity established by Security IQ." };

    case "IDENTIFIED":
      if (!evidence.contractsCompatible) {
        return {
          blocked: true,
          stage: "IDENTIFIED",
          needs: "compatible contracts on every lane it asked for",
          note: "Contracts are checked before a topology attachment is proposed, so an incompatible participant never becomes a proposal somebody has to review and refuse.",
        };
      }
      return { advanceTo: "CONTRACTS_VERIFIED", note: "Contracts are compatible." };

    case "CONTRACTS_VERIFIED":
      if (evidence.topologyProposalRef === null) {
        return {
          blocked: true,
          stage: "CONTRACTS_VERIFIED",
          needs: "a proposed topology attachment",
          note: "The attachment is proposed within permitted structure. Nothing is active yet.",
        };
      }
      return { advanceTo: "TOPOLOGY_PROPOSED", note: `Attachment proposed as ${evidence.topologyProposalRef}.` };

    case "TOPOLOGY_PROPOSED":
      if (evidence.requiresGovernance && evidence.governanceDecisionRef === null) {
        return {
          blocked: true,
          stage: "TOPOLOGY_PROPOSED",
          needs: "a Governance decision",
          note: "The attachment creates a relation that needs authority. Proposing before consulting Governance would let the proposal become the decision — by the time anybody reviews it, the connection is the obvious next step.",
        };
      }
      return {
        advanceTo: "GOVERNED",
        note: evidence.requiresGovernance
          ? `Authorized by ${evidence.governanceDecisionRef}.`
          : "No governed decision was required: the attachment fits within already-approved structure.",
      };

    case "GOVERNED":
      if (!evidence.topologyVersionActive) {
        return {
          blocked: true,
          stage: "GOVERNED",
          needs: "the topology version to be activated",
          note: "Approved and not yet in force. Activation is a separate act, which is what makes rollback possible.",
        };
      }
      return { advanceTo: "ADMITTED", note: "Topology version active; Pulse begins observing." };
  }
}

export type AdvanceOutcome =
  | { readonly ok: true; readonly state: AdmissionState }
  | { readonly ok: false; readonly reason: string };

/**
 * Moves admission forward by exactly one stage.
 *
 * Refuses to skip. Skipping a stage is not a shortcut — it is the absence of a
 * check, and the record would show a participant that reached ADMITTED without
 * ever being identified.
 */
export function advance(
  state: AdmissionState,
  to: AdmissionStage,
  at: string,
  note: string,
): AdvanceOutcome {
  if (state.stage === "REFUSED") {
    return { ok: false, reason: "A refused request is terminal. Reapplying means a new request." };
  }
  if (to === "REFUSED") {
    return {
      ok: true,
      state: {
        ...state,
        stage: "REFUSED",
        refusalReason: note,
        history: [...state.history, { stage: "REFUSED", at, note }],
      },
    };
  }

  const from = ORDER.indexOf(state.stage);
  const target = ORDER.indexOf(to);

  if (target === from + 1) {
    return {
      ok: true,
      state: { ...state, stage: to, history: [...state.history, { stage: to, at, note }] },
    };
  }
  if (target <= from) {
    return {
      ok: false,
      reason: `Admission does not move backwards, and ${state.stage} is at or past ${to}. Re-running a gate would let a participant that failed a later check quietly re-enter at an earlier one.`,
    };
  }
  return {
    ok: false,
    reason: `Cannot jump from ${state.stage} to ${to}, skipping ${ORDER.slice(from + 1, target).join(", ")}. Skipping a stage is not a shortcut — it is the absence of a check, and the record would show a participant reaching ADMITTED without ever being identified.`,
  };
}

/**
 * Whether reaching ADMITTED grants the ability to reach anything.
 *
 * Always false. The point most likely to be lost, because "we admitted it"
 * sounds like "it works now" and most systems behave that way.
 */
export function admissionGrantsReachability(): false {
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CAPABILITY REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityRecord {
  readonly capability: string;
  readonly providerNodeIds: readonly string[];
  readonly lanes: readonly Lane[];
  readonly zoneKinds: readonly ZoneKind[];
}

export interface RegistryFinding {
  readonly capability: string;
  readonly kind: "SINGLE_PROVIDER" | "NO_PROVIDER" | "SPLIT_ACROSS_INSTANCES" | "SANDBOX_ONLY";
  readonly note: string;
}

/**
 * What the registry says about resilience, before anything fails.
 *
 * The value of a capability registry is not lookup — the graph does that. It is
 * being able to answer "what have we got exactly one of" while there is still
 * time to do something about it.
 */
export function registryFindings(records: readonly CapabilityRecord[]): readonly RegistryFinding[] {
  const findings: RegistryFinding[] = [];

  for (const record of [...records].sort((a, b) => a.capability.localeCompare(b.capability))) {
    if (record.providerNodeIds.length === 0) {
      findings.push({
        capability: record.capability,
        kind: "NO_PROVIDER",
        note: `Nothing provides "${record.capability}". Anything addressing it gets a routing refusal that reads like a permission problem and is not one.`,
      });
      continue;
    }

    if (record.zoneKinds.every((z) => z === "SANDBOX")) {
      findings.push({
        capability: record.capability,
        kind: "SANDBOX_ONLY",
        note: `"${record.capability}" exists only in sandbox zones. Production cannot reach it by design, so anything depending on it in production will fail — and will fail as an isolation refusal rather than as a missing capability.`,
      });
      continue;
    }

    if (record.providerNodeIds.length === 1) {
      findings.push({
        capability: record.capability,
        kind: "SINGLE_PROVIDER",
        note: `"${record.capability}" has one provider (${record.providerNodeIds[0]}). Not a fault, and it is a single point of failure — worth knowing now rather than at the moment it stops.`,
      });
    }

    if (record.zoneKinds.includes("GATEWAY") && record.zoneKinds.includes("LOCAL")) {
      findings.push({
        capability: record.capability,
        kind: "SPLIT_ACROSS_INSTANCES",
        note: `"${record.capability}" is provided both locally and across a gateway. Routing will prefer local, which means the remote provider carries traffic only when the local one is unwell — so its health is least tested exactly when it matters most.`,
      });
    }
  }

  return findings;
}
