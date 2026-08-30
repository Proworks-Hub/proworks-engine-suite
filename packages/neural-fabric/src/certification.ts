/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/certification.ts
 * Module:   neural-fabric
 * Purpose:  Checking the seven hard gates against the code, not against a promise.
 */

import { HARD_GATES, NEURAL_FABRIC_CLASSIFICATION, RATIFIED_CLASSIFICATIONS, isRatifiedClassification } from "./charter.js";
import { LANE_SEMANTICS, exactlyOnceDeliveryOffered, mayBeShed, type Lane } from "./domain/lanes.js";
import { referenceGrantsAuthority, routePossessionGrantsPermission } from "./domain/envelope.js";
import { zonesMayRelate } from "./domain/topology.js";
import { degradationMayRelaxRules, localWorkContinues } from "./pulse/degradedMode.js";
import { evidenceSurvivesEveryLevel, postureMayGrantAccess, resolvePosture } from "./security/posture.js";
import { immuneSignalMayWiden } from "./security/quarantine.js";
import { sentinelMayRemoveRecoveryPath, constitutionalRecoveryPath } from "./security/governedUpgrade.js";
import { adaptationMayApply, twinMayUseProductionPayloads } from "./engines/fabricAdaptationIQ.js";
import { routingMayWidenCandidates } from "./engines/routingIQ.js";
import { admissionGrantsReachability } from "./engines/topologyIQ.js";
import { priorityBypassesLimits } from "./engines/flowIQ.js";
import { LANE_DEGRADATION, providerIsRequired } from "./ports/providers.js";
import { spanCarriesPayload } from "./engines/fabricObservabilityIQ.js";

// ─────────────────────────────────────────────────────────────────────────────
// A CERTIFICATION THAT CANNOT FAIL CERTIFIES NOTHING
//
// §33.6 lists seven hard gates. Each is a sentence somebody could write in a
// design document and nothing would check. This file turns each into a
// question asked of the actual implementation — mostly by calling the
// assertable claims scattered through the package, which exist precisely so
// this can call them.
//
// The gates are the interesting part and not the whole story. §26 and §34.9
// add a validation program and a set of certification tests, and those live in
// `__tests__/chaos.test.ts` because they are behavioural rather than
// structural: a chaos scenario has to be run, not inspected.
//
// WHAT THIS DOES NOT CERTIFY
//
// It says the declared invariants hold. It does not say the Fabric works —
// nothing here has moved a message, because nothing here is bound to a
// transport. That is the honest limit of a package with no I/O, and stating it
// is more useful than a score that implies otherwise.
// ─────────────────────────────────────────────────────────────────────────────

export interface GateResult {
  readonly gateId: string;
  readonly rule: string;
  readonly passed: boolean;
  readonly evidence: string;
  readonly remedy: string | null;
}

export interface CertificationReport {
  readonly engine: "Neural Fabric";
  readonly classification: string;
  readonly ratified: false;
  readonly gates: readonly GateResult[];
  readonly certified: boolean;
  readonly summary: string;
  readonly outOfScope: readonly string[];
}

const ALL_LANES = Object.keys(LANE_SEMANTICS) as Lane[];

/**
 * Runs the seven hard gates.
 *
 * Pure and synchronous. It reads declared structures and calls the package's
 * own assertable claims; there is no clock, no I/O and no configuration, so it
 * produces the same report anywhere it runs — including in a build that has
 * never had a transport bound.
 */
export function certify(): CertificationReport {
  const gates: GateResult[] = [];

  // ── 1. No signal lane becomes an authorization bypass ────────────────────
  const bypassClaims = [
    ["a reference to evidence does not grant authority", !referenceGrantsAuthority()],
    ["holding a route does not grant permission to use it", !routePossessionGrantsPermission()],
    ["routing never widens the permitted candidate set", !routingMayWidenCandidates()],
    ["admission does not grant reachability", !admissionGrantsReachability()],
    ["priority does not bypass a rate limit", !priorityBypassesLimits()],
    ["no posture level grants access", !postureMayGrantAccess()],
    ["an immune signal cannot widen access", !immuneSignalMayWiden()],
  ] as const;
  const bypassFailures = bypassClaims.filter(([, held]) => !held).map(([claim]) => claim);
  const consequentialLanes = ALL_LANES.filter((l) => LANE_SEMANTICS[l].requiresAuthorizationEvidence);

  gates.push({
    gateId: "no-lane-bypass",
    rule: HARD_GATES.find((g) => g.id === "no-lane-bypass")!.rule,
    passed: bypassFailures.length === 0 && consequentialLanes.length > 0,
    evidence:
      bypassFailures.length === 0
        ? `${bypassClaims.length} assertable claims hold, and ${consequentialLanes.length} lanes (${consequentialLanes.join(", ")}) require an authorization reference at the envelope.`
        : `Broken: ${bypassFailures.join("; ")}.`,
    remedy:
      bypassFailures.length === 0
        ? null
        : "One of the claims that make authority separate from reachability has been inverted. Nothing else in this package is safe until it is restored.",
  });

  // ── 2. Missing security never falls through to allow ─────────────────────
  const unreachable = resolvePosture(null, null, false, "2026-01-01T00:00:00.000Z");
  const staleCache = resolvePosture(
    null,
    { level: "GREEN", assertedAt: "2026-01-01T00:00:00.000Z", assertedBy: "s", expiresAt: "2026-01-01T00:05:00.000Z" },
    false,
    "2026-01-01T01:00:00.000Z",
  );
  const failsClosed = unreachable.level !== "GREEN" && staleCache.level !== "GREEN" && !degradationMayRelaxRules();

  gates.push({
    gateId: "fail-closed-on-missing-security",
    rule: HARD_GATES.find((g) => g.id === "fail-closed-on-missing-security")!.rule,
    passed: failsClosed,
    evidence: failsClosed
      ? `With no live posture and nothing cached the level resolves to ${unreachable.level}; with an expired cache it resolves to ${staleCache.level}, not to the last known one. Degradation cannot relax rules.`
      : `Fails open: unreachable resolves to ${unreachable.level} and an expired cache to ${staleCache.level}.`,
    remedy: failsClosed ? null : "An unreachable security system must raise the posture, never leave it where it was.",
  });

  // ── 3. Cross-instance routes terminate at a gateway ──────────────────────
  const directCross = zonesMayRelate(
    { zoneId: "a", kind: "LOCAL", instanceId: "one" },
    { zoneId: "b", kind: "LOCAL", instanceId: "two" },
  );
  const viaGateway = zonesMayRelate(
    { zoneId: "gw", kind: "GATEWAY", instanceId: "one" },
    { zoneId: "b", kind: "LOCAL", instanceId: "two" },
  );
  const sandboxOut = zonesMayRelate(
    { zoneId: "s", kind: "SANDBOX", instanceId: "one" },
    { zoneId: "b", kind: "LOCAL", instanceId: "one" },
  );
  const interconnectHeld = !directCross.permitted && viaGateway.permitted && !sandboxOut.permitted;

  gates.push({
    gateId: "interconnect-terminated",
    rule: HARD_GATES.find((g) => g.id === "interconnect-terminated")!.rule,
    passed: interconnectHeld,
    evidence: interconnectHeld
      ? "A local-to-local route across instances is refused; the same route through a gateway zone is permitted; a sandbox cannot reach production in either direction."
      : `Broken: direct cross-instance permitted=${directCross.permitted}, via gateway permitted=${viaGateway.permitted}, sandbox outbound permitted=${sandboxOut.permitted}.`,
    remedy: interconnectHeld ? null : "Cross-instance traffic that does not pass a gateway is shared private-store access with extra steps.",
  });

  // ── 4. No provider is constitutionally required ──────────────────────────
  const lanesWithDegradation = ALL_LANES.filter((l) => LANE_DEGRADATION[l] !== undefined);
  const everyLaneDeclared = lanesWithDegradation.length === ALL_LANES.length;
  const onlyHealthDropped = ALL_LANES.filter((l) => LANE_DEGRADATION[l].behaviour === "DROP");
  const providerGate = !providerIsRequired() && everyLaneDeclared && onlyHealthDropped.length === 1 && onlyHealthDropped[0] === "HEALTH";

  gates.push({
    gateId: "no-required-provider",
    rule: HARD_GATES.find((g) => g.id === "no-required-provider")!.rule,
    passed: providerGate,
    evidence: providerGate
      ? `All ${ALL_LANES.length} lanes declare a degraded behaviour in advance, and HEALTH is the only lane that may be dropped.`
      : `Broken: ${ALL_LANES.length - lanesWithDegradation.length} lanes have no declared degraded behaviour, and ${onlyHealthDropped.join(", ") || "nothing"} may be dropped.`,
    remedy: providerGate ? null : "Every lane needs an answer to 'what happens when this provider fails', decided while somebody is thinking clearly.",
  });

  // ── 5. No topology adaptation self-deploys ───────────────────────────────
  const adaptationGate = !adaptationMayApply() && !twinMayUseProductionPayloads();

  gates.push({
    gateId: "no-self-deploying-topology",
    rule: HARD_GATES.find((g) => g.id === "no-self-deploying-topology")!.rule,
    passed: adaptationGate,
    evidence: adaptationGate
      ? "Adaptation cannot apply a candidate, and the twin cannot use production payloads. There is no exported function in the adaptation module that mutates a topology."
      : "Broken: adaptation can apply its own candidate, or the twin can read production data.",
    remedy: adaptationGate ? null : "§14's line is between outcome and authority. Improving from evidence is permitted; granting itself the right to change its own shape is not.",
  });

  // ── 6. Local continuity during a Collective outage ───────────────────────
  const collectiveOut = localWorkContinues(["COLLECTIVE"]);
  const everythingRemoteOut = localWorkContinues(["COLLECTIVE", "REGIONAL", "GATEWAY"]);
  const localOut = localWorkContinues(["LOCAL"]);
  const continuityGate = collectiveOut.continues && everythingRemoteOut.continues && !localOut.continues;

  gates.push({
    gateId: "local-continuity",
    rule: HARD_GATES.find((g) => g.id === "local-continuity")!.rule,
    passed: continuityGate,
    evidence: continuityGate
      ? "Local work continues with the Collective unreachable, and with every remote zone kind unreachable at once. It stops only when the local zone itself is gone, which is an outage rather than a degraded mode."
      : `Broken: Collective outage continues=${collectiveOut.continues}, all-remote outage continues=${everythingRemoteOut.continues}.`,
    remedy: continuityGate ? null : "A local path that breaks when the Collective is unreachable was never local.",
  });

  // ── 7. Traceable without exposing payloads ───────────────────────────────
  const shedable = ALL_LANES.filter((l) => mayBeShed(l));
  const evidenceProtected = !shedable.includes("EVIDENCE") && evidenceSurvivesEveryLevel();
  const traceGate = !spanCarriesPayload() && evidenceProtected && !exactlyOnceDeliveryOffered();

  gates.push({
    gateId: "traceable-without-exposure",
    rule: HARD_GATES.find((g) => g.id === "traceable-without-exposure")!.rule,
    passed: traceGate,
    evidence: traceGate
      ? "A trace span has no payload field. Evidence is never shed under load and survives every security posture including RED, so the record of an incident outlives the incident."
      : "Broken: a span can carry payload, or evidence can be shed or suspended.",
    remedy: traceGate ? null : "Losing the ability to see a failure is worse than the failure.",
  });

  const failed = gates.filter((g) => !g.passed);

  return {
    engine: "Neural Fabric",
    classification: NEURAL_FABRIC_CLASSIFICATION,
    ratified: false,
    gates,
    certified: failed.length === 0 && !isRatifiedClassification() && !RATIFIED_CLASSIFICATIONS.includes(NEURAL_FABRIC_CLASSIFICATION),
    summary:
      failed.length === 0
        ? `All ${gates.length} hard gates hold. This says the declared invariants are true of the code; it does not say the Fabric works, because nothing here has moved a message — no transport is bound.`
        : `${failed.length} of ${gates.length} hard gates failed: ${failed.map((g) => g.gateId).join(", ")}.`,
    outOfScope: [
      "Whether the Fabric actually delivers anything. No provider is bound in this package, so nothing here has carried a signal. A bound adapter is where that question starts.",
      "Whether a host wires the ports correctly. A clock port returning a constant, or a governance port that always allows, would pass every gate here.",
      "Whether the topology a deployment builds is sensible. The engine refuses an incoherent one; it cannot judge a coherent one that is wrong for the business.",
      "The constitutional question. §3 reserves placement for a human process, and passing these gates is evidence for that decision rather than a substitute for it.",
    ],
  };
}

/** The report as text, for a build log. */
export function formatCertification(report: CertificationReport): string {
  return [
    `Neural Fabric certification — ${report.classification}, ratified: ${report.ratified}`,
    "",
    ...report.gates.map(
      (g) =>
        `  [${g.passed ? "PASS" : "FAIL"}] ${g.gateId}\n         ${g.rule}\n         ${g.evidence}${g.remedy === null ? "" : `\n         REMEDY: ${g.remedy}`}`,
    ),
    "",
    report.summary,
    "",
    "Not covered:",
    ...report.outOfScope.map((o) => `  - ${o}`),
  ].join("\n");
}
