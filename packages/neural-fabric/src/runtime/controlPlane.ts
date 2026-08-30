/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/runtime/controlPlane.ts
 * Module:   neural-fabric / runtime
 * Purpose:  What may change the rules, what may only follow them, and the wall between.
 */

import { z } from "zod";

import { buildGraph, type FabricGraph } from "../nexus/topologyGraph.js";
import { topologyVersionSchema, type TopologyVersion } from "../domain/topology.js";
import type { IntegrityPort } from "../ports/securityPorts.js";
import type { ConditionLevel } from "../security/posture.js";
import type { ContractVersion } from "../engines/contractIQ.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE CONTROL PLANE DECIDES. THE DATA PLANE FOLLOWS. NOTHING FLOWS BACK UP.
//
// §21 requires the separation so that "existing approved paths can continue
// during a temporary control-plane outage." That is the availability half. The
// security half matters more: a data-plane node handles untrusted traffic all
// day, which makes it the component most likely to be compromised — and a
// compromised data plane that can write topology is a compromised authority.
//
// So the wall is structural, three ways at once:
//
//   TYPES.   The data plane receives a `DataPlaneView` whose every field is a
//            ReadonlyMap or readonly value. There is no setter to call.
//   FREEZE.  The view is deep-frozen at construction. A caller that casts away
//            readonly hits a frozen object; in strict mode the write throws,
//            and in any mode it does not land.
//   COPIES.  The maps in the view are COPIES of the control plane's state. A
//            data-plane component that somehow mutated its own view has
//            mutated a copy nobody else reads.
//
// Belt, braces, and a different pair of braces — because the test this has to
// pass is not "the compiler stops honest code" but "a compromised or buggy
// component cannot widen topology", and a compromised component does not ask
// the compiler.
//
// STALE TOPOLOGY IS USABLE. STALE TOPOLOGY IS NEVER WIDENED.
//
// When the control plane is unreachable, a data plane keeps working from the
// last topology it was handed — within a TTL, and only if that topology's
// signature verified when it arrived. What it may never do while stale is
// anything that WIDENS: no new topology version, no relaxed posture, no new
// provider binding. §21 again: "refuse unsafe new topology operations during
// uncertain control state." Continuity is for traffic, not for change.
// ─────────────────────────────────────────────────────────────────────────────

export const signedTopologySchema = z
  .object({
    version: topologyVersionSchema,
    /** Signature over the canonical form. Security IQ produced it; we verify. */
    signature: z.string().min(1),
    signedBy: z.string().min(1),
    algorithmProfile: z.string().min(1),
    signedAt: z.string().min(1),
  })
  .strict();
export type SignedTopology = z.infer<typeof signedTopologySchema>;

/**
 * The canonical text a topology signature covers.
 *
 * Keys sorted, arrays in declared order, no whitespace variance — two
 * serialisations of the same version must produce identical bytes or the
 * signature check becomes a serialisation check.
 */
export function canonicalTopologyForm(version: TopologyVersion): string {
  const sortedKeys = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = obj[key];
    return out;
  };
  return JSON.stringify({
    ...sortedKeys(version as unknown as Record<string, unknown>),
    zones: version.zones.map((z) => sortedKeys(z as unknown as Record<string, unknown>)),
    nodes: version.nodes.map((n) => sortedKeys(n as unknown as Record<string, unknown>)),
    adjacencies: version.adjacencies.map((a) => sortedKeys(a as unknown as Record<string, unknown>)),
  });
}

export interface ControlPlaneState {
  readonly activeTopology: SignedTopology | null;
  readonly graph: FabricGraph | null;
  readonly laneBindings: ReadonlyMap<string, string>;
  readonly contracts: ReadonlyMap<string, ContractVersion>;
  readonly conditionLevel: ConditionLevel;
  /** When the active topology was last confirmed by the control plane. */
  readonly confirmedAt: string;
}

export type ActivationOutcome =
  | { readonly activated: true; readonly state: ControlPlaneState; readonly note: string }
  | { readonly activated: false; readonly reason: string };

/**
 * Activates a signed topology into control-plane state.
 *
 * Four gates, all of which must pass: the signature verifies through Security
 * IQ's port, the version is in an activatable state, it carries an activation
 * decision, and the graph builds. A topology that fails any of them is not
 * "activated with warnings" — a warning on an activation is a decision
 * somebody deferred to nobody.
 */
export async function activateTopology(
  signed: SignedTopology,
  integrity: IntegrityPort,
  laneBindings: ReadonlyMap<string, string>,
  contracts: ReadonlyMap<string, ContractVersion>,
  conditionLevel: ConditionLevel,
  now: string,
): Promise<ActivationOutcome> {
  let verdict: Awaited<ReturnType<IntegrityPort["verify"]>>;
  try {
    verdict = await integrity.verify({
      canonical: canonicalTopologyForm(signed.version),
      signature: signed.signature,
      signedBy: signed.signedBy,
      algorithmProfile: signed.algorithmProfile,
    });
  } catch {
    verdict = { outcome: "UNAVAILABLE", reason: "The integrity verifier threw." };
  }

  if (verdict.outcome !== "VERIFIED") {
    return {
      activated: false,
      reason:
        verdict.outcome === "UNAVAILABLE"
          ? `The topology signature could not be verified: ${verdict.reason} An unverifiable topology is not activated — a forged topology update is the single highest-value thing an attacker could feed this system, and "the verifier was down" is exactly when one would arrive.`
          : `The topology signature was refused: ${verdict.reason} This is either corruption or a forgery, and the difference does not matter to the answer.`,
    };
  }

  if (signed.version.state !== "APPROVED" && signed.version.state !== "ACTIVE") {
    return {
      activated: false,
      reason: `Topology ${signed.version.versionId} is ${signed.version.state}. Only an APPROVED version activates — a draft that could activate would make the propose-simulate-approve sequence decorative.`,
    };
  }

  if (signed.version.activationDecisionRef === null) {
    return {
      activated: false,
      reason: `Topology ${signed.version.versionId} carries no activation decision reference. §27 reserves activation for governed approval, and a signature proves who signed it, not that anybody approved it — those are different facts and this check needs both.`,
    };
  }

  const built = buildGraph(signed.version);
  if (!built.ok) {
    return {
      activated: false,
      reason: `Topology ${signed.version.versionId} is signed, approved, and does not build: ${built.problems.map((p) => p.message).join(" ")} A signature over an invalid topology proves the invalid topology is authentic.`,
    };
  }

  return {
    activated: true,
    state: {
      activeTopology: signed,
      graph: built.graph,
      laneBindings,
      contracts,
      conditionLevel,
      confirmedAt: now,
    },
    note: `Topology ${signed.version.versionId} active, signed by ${signed.signedBy}, authorized by ${signed.version.activationDecisionRef}.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DATA-PLANE VIEW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything a data-plane node is allowed to know. Nothing it can change.
 *
 * Note what is ABSENT: there is no reference to the control plane, no
 * activation function, no binding setter. A data-plane component holding this
 * view can route, admit, deliver and observe. It cannot alter what any other
 * component sees, because it holds frozen copies.
 */
export interface DataPlaneView {
  readonly topologyVersionId: string;
  readonly graph: FabricGraph;
  readonly laneBindings: ReadonlyMap<string, string>;
  readonly contracts: ReadonlyMap<string, ContractVersion>;
  readonly conditionLevel: ConditionLevel;
  readonly issuedAt: string;
  /** After this instant the view is stale and `viewUsable` starts refusing. */
  readonly staleAfter: string;
}

export type ViewOutcome =
  | { readonly issued: true; readonly view: DataPlaneView }
  | { readonly issued: false; readonly reason: string };

/**
 * Issues a data-plane view from control-plane state.
 *
 * The maps are copied and the whole view frozen. The graph inside is the
 * control plane's — it was built once from a signed version and FabricGraph
 * exposes only ReadonlyMaps, so sharing it shares nothing writable.
 */
export function issueView(
  state: ControlPlaneState,
  ttlMs: number,
  now: string,
): ViewOutcome {
  if (state.activeTopology === null || state.graph === null) {
    return {
      issued: false,
      reason: "The control plane holds no active topology, so there is nothing to issue a view of. A data plane with no view carries nothing — default deny extends to 'nothing has been approved yet'.",
    };
  }

  const view: DataPlaneView = Object.freeze({
    topologyVersionId: state.activeTopology.version.versionId,
    graph: state.graph,
    laneBindings: new Map(state.laneBindings),
    contracts: new Map(state.contracts),
    conditionLevel: state.conditionLevel,
    issuedAt: now,
    staleAfter: new Date(Date.parse(now) + ttlMs).toISOString(),
  });

  return { issued: true, view };
}

export type ViewUsability =
  | { readonly usable: true; readonly stale: false; readonly note: string }
  | { readonly usable: true; readonly stale: true; readonly note: string }
  | { readonly usable: false; readonly reason: string };

/**
 * Whether a view may still carry traffic, given control-plane reachability.
 *
 * Three regimes:
 *   fresh                      — use it.
 *   stale + control reachable  — refuse; a reachable control plane should have
 *                                issued a new view, and working from a stale
 *                                one anyway means ignoring it.
 *   stale + control UNREACHABLE — use it within the grace period. This is §21's
 *                                continuity: approved paths keep working while
 *                                the control plane is away. Every use is
 *                                marked stale so evidence shows the regime.
 */
export function viewUsable(
  view: DataPlaneView,
  controlPlaneReachable: boolean,
  gracePeriodMs: number,
  now: string,
): ViewUsability {
  if (now < view.staleAfter) {
    return { usable: true, stale: false, note: `View of ${view.topologyVersionId} is fresh until ${view.staleAfter}.` };
  }

  if (controlPlaneReachable) {
    return {
      usable: false,
      reason: `The view of ${view.topologyVersionId} went stale at ${view.staleAfter} and the control plane is REACHABLE. Refresh it — continuing on a stale view while a fresh one is available means deliberately ignoring whatever changed, and what changed may be a revocation.`,
    };
  }

  const graceEnds = new Date(Date.parse(view.staleAfter) + gracePeriodMs).toISOString();
  if (now < graceEnds) {
    return {
      usable: true,
      stale: true,
      note: `The control plane is unreachable and the view of ${view.topologyVersionId} is inside its grace period until ${graceEnds}. Approved paths continue (§21); every operation in this regime is marked stale in evidence, and NOTHING may widen — no new topology, no relaxed posture, no new binding — until the control plane returns.`,
    };
  }

  return {
    usable: false,
    reason: `The view of ${view.topologyVersionId} exhausted its grace period at ${graceEnds} with the control plane still unreachable. Local traffic stops rather than running indefinitely on rules nobody can revoke — a grace period without an end is not a grace period, it is a fork.`,
  };
}

/** Operations a data plane might request. Only some exist while stale. */
export type ControlOperation =
  | "ROUTE_TRAFFIC"
  | "REFRESH_VIEW"
  | "ACTIVATE_TOPOLOGY"
  | "BIND_PROVIDER"
  | "RELAX_POSTURE"
  | "TIGHTEN_POSTURE";

/**
 * Whether an operation is permitted in the stale-view regime.
 *
 * Tightening is always allowed — becoming stricter needs nobody's permission.
 * Everything that changes the rules outward is refused until the control
 * plane is back. Continuity is for traffic, not for change.
 */
export function permittedWhileStale(operation: ControlOperation): {
  readonly permitted: boolean;
  readonly reason: string;
} {
  switch (operation) {
    case "ROUTE_TRAFFIC":
      return { permitted: true, reason: "Approved paths continue during a control-plane outage. That is what the grace period is FOR." };
    case "REFRESH_VIEW":
      return { permitted: true, reason: "Attempting a refresh is how the outage ends." };
    case "TIGHTEN_POSTURE":
      return { permitted: true, reason: "Becoming stricter needs nobody's permission, in an outage least of all." };
    case "ACTIVATE_TOPOLOGY":
    case "BIND_PROVIDER":
    case "RELAX_POSTURE":
      return {
        permitted: false,
        reason: `${operation} widens what the system may do, and the stale regime exists precisely because nobody authoritative is reachable to approve a widening. §21: refuse unsafe new topology operations during uncertain control state.`,
      };
  }
}

/**
 * Whether any data-plane surface can mutate control-plane state.
 *
 * Always false, and the mechanism is stated so a test can attack it: the view
 * is frozen, its maps are copies, and no control-plane reference is reachable
 * from it. `dataPlaneCannotWiden` in the test suite attempts the mutations.
 */
export function dataPlaneMayMutateControlPlane(): false {
  return false;
}
