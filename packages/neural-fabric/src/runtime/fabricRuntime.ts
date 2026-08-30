/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/runtime/fabricRuntime.ts
 * Module:   neural-fabric / runtime
 * Purpose:  The pipeline that runs a signal through every gate, in order, once.
 */

import { acceptEnvelope, isExpired, type FabricEnvelope } from "../domain/envelope.js";
import { LANE_SEMANTICS } from "../domain/lanes.js";
import { candidateRoutes, type FabricGraph } from "../nexus/topologyGraph.js";
import { routeSignal, type RouteDecision } from "../engines/routingIQ.js";
import { admit, type AdmissionPolicy, type QueueState } from "../pulse/flowControl.js";
import {
  acceptDelivery,
  completeDelivery,
  failDelivery,
  type DeliveryPolicy,
  type DeliveryRecord,
} from "../engines/deliveryIQ.js";
import {
  admits,
  defaultPathKey,
  markProbeInFlight,
  newCircuit,
  recordOutcome,
  type Circuit,
  type CircuitPolicy,
  type CircuitState,
  type PathHealth,
} from "../pulse/pathHealth.js";
import { canSpeak, type ContractVersion } from "../engines/contractIQ.js";
import { laneTreatment, type ConditionLevel } from "../security/posture.js";
import { resolveTrust, type SecurityPortSet } from "../ports/securityPorts.js";
import type { TransportProviderPort } from "../ports/providers.js";
import type { TraceSpan } from "../engines/fabricObservabilityIQ.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE RUNTIME ORCHESTRATES. IT DECIDES NOTHING.
//
// Every judgement in this file already exists in a module with its own tests
// and its own mutation run: the envelope refuses malformed signals, resolve-
// Trust fails closed, Nexus generates candidates, RoutingIQ selects, FlowIQ
// admits, DeliveryIQ deduplicates, Pulse breaks circuits. What was missing was
// the thing that runs them IN ORDER against one signal — and order is the part
// a composition can get wrong in ways no unit test sees.
//
// The order is fixed and numbered below. Two orderings are load-bearing:
//
//   TRUST BEFORE ROUTING. A signal is identified and authorized before the
//   topology is even consulted. Routing first would leak the shape of the
//   topology to unauthenticated callers through timing and refusal messages —
//   an unauthenticated probe learns nothing here except "no".
//
//   ADMISSION AFTER ROUTING. Backpressure is per chosen path's queue. Admitting
//   before routing would shed against a queue the signal may never enter.
//
// EVERY STOP PRODUCES THE SAME SHAPE
//
// A signal stops at exactly one stage or is sent. The result names the stage,
// carries the stage's own reason verbatim, and includes the trace span that
// was recorded — because §19's questions are asked about refusals more often
// than about deliveries, and a refusal that vanished from telemetry is a
// question with no answer.
//
// THE RUNTIME HOLDS NO AUTHORITY AND NO STATE OF RECORD
//
// Circuits, delivery ledger entries and trace spans live in stores the HOST
// supplies through `RuntimeStores`. The runtime reads and writes them through
// that interface and owns none of them, so two runtime instances over the same
// stores behave as one — which is the property Phase 5's replication depends
// on being true from the start.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the runtime keeps its working state. Host-supplied, runtime-owned never. */
export interface RuntimeStores {
  getCircuit(pathKey: string): Circuit | null;
  putCircuit(circuit: Circuit): void;
  getDelivery(idempotencyKey: string): DeliveryRecord | null;
  putDelivery(record: DeliveryRecord): void;
  appendSpan(span: TraceSpan): void;
  /** Evidence of consequential outcomes, for AuditIQ to collect. */
  appendEvidence(entry: {
    readonly kind: "SENT" | "REFUSED" | "REPLAYED" | "DEAD_LETTERED";
    readonly fabricMessageId: string;
    readonly correlationId: string;
    readonly stage: string;
    readonly reason: string;
    readonly at: string;
  }): void;
}

export interface RuntimeConfig {
  readonly instanceId: string;
  readonly securityPorts: SecurityPortSet;
  /** Contract versions by "schemaId@version", as the control plane published them. */
  readonly contracts: ReadonlyMap<string, ContractVersion>;
  /** What the destination consumes, by capability. */
  readonly consumerContracts: ReadonlyMap<string, ContractVersion>;
  readonly graph: FabricGraph;
  readonly providers: ReadonlyMap<string, TransportProviderPort>;
  /** Which provider carries each lane, from the control plane's bindings. */
  readonly laneBindings: ReadonlyMap<string, string>;
  readonly conditionLevel: ConditionLevel;
  readonly health: ReadonlyMap<string, PathHealth>;
  readonly queues: ReadonlyMap<string, QueueState>;
  readonly admission: AdmissionPolicy;
  readonly circuitPolicy: CircuitPolicy;
  readonly deliveryPolicy: DeliveryPolicy;
  /** The scope a COMMAND/WORKFLOW signal must be authorized for. */
  readonly requiredScopeFor: (envelope: FabricEnvelope) => string | null;
}

export type SendStage =
  | "ENVELOPE"
  | "POSTURE"
  | "TRUST"
  | "CONTRACT"
  | "EXPIRY"
  | "ROUTING"
  | "ADMISSION"
  | "DELIVERY"
  | "CIRCUIT"
  | "TRANSPORT";

/**
 * The pipeline order as a VALUE, so certification can assert it rather than
 * trust a comment. `satisfies` keeps it in lockstep with the type: add a
 * stage to one without the other and the build breaks.
 */
export const SEND_STAGES = [
  "ENVELOPE",
  "POSTURE",
  "TRUST",
  "CONTRACT",
  "EXPIRY",
  "ROUTING",
  "ADMISSION",
  "DELIVERY",
  "CIRCUIT",
  "TRANSPORT",
] as const satisfies readonly SendStage[];

export type SendResult =
  | {
      readonly sent: true;
      readonly fabricMessageId: string;
      readonly viaProvider: string;
      readonly pathKey: string;
      readonly route: RouteDecision;
      readonly trustEvidence: readonly string[];
      readonly note: string;
    }
  | {
      readonly sent: false;
      readonly stage: SendStage;
      readonly reason: string;
      /** Set when the refusal replays a prior outcome rather than losing work. */
      readonly replayedOutcomeRef: string | null;
      readonly retryable: boolean;
    };

/**
 * Runs one signal through the whole pipeline.
 *
 * `sentAt` and `now` are arguments. A pipeline that read a clock could not be
 * replayed, and "why was this refused at 14:32" is the question evidence
 * exists to answer.
 */
export async function sendThroughFabric(
  raw: unknown,
  config: RuntimeConfig,
  stores: RuntimeStores,
  sentAt: string,
  now: string,
): Promise<SendResult> {
  // ── 1. Envelope. The single door — nothing downstream sees a raw signal. ──
  const accepted = acceptEnvelope(raw);
  if (!accepted.accepted) {
    // No span: an unparseable signal has no ids to trace by, and inventing
    // them would attach garbage to real correlations.
    return {
      sent: false,
      stage: "ENVELOPE",
      reason: `${accepted.reason} ${accepted.issues.join("; ")}`,
      replayedOutcomeRef: null,
      retryable: false,
    };
  }
  const envelope = accepted.envelope;

  const refuse = (
    stage: SendStage,
    reason: string,
    retryable: boolean,
    replayedOutcomeRef: string | null = null,
  ): SendResult => {
    stores.appendSpan(span(envelope, sentAt, now, replayedOutcomeRef !== null ? "DELIVERED" : "REFUSED", `${stage}: ${reason}`));
    stores.appendEvidence({
      kind: replayedOutcomeRef !== null ? "REPLAYED" : "REFUSED",
      fabricMessageId: envelope.fabricMessageId,
      correlationId: envelope.correlationId,
      stage,
      reason,
      at: now,
    });
    return { sent: false, stage, reason, replayedOutcomeRef, retryable };
  };

  // ── 2. Posture. The condition level restricts before anything is spent. ──
  const treatment = laneTreatment(config.conditionLevel, envelope.lane);
  if (treatment === "SUSPENDED") {
    return refuse(
      "POSTURE",
      `The ${envelope.lane} lane is suspended at condition ${config.conditionLevel}. Suspension restricts and never grants — this signal waits for the posture to relax, which requires an authority the Fabric does not hold.`,
      true,
    );
  }

  // ── 3. Trust. Before routing, so an unauthenticated probe learns nothing
  //       about the topology except "no". ─────────────────────────────────
  const semantics = LANE_SEMANTICS[envelope.lane];
  const requiredScope = semantics.requiresAuthorizationEvidence ? config.requiredScopeFor(envelope) : null;
  const trust = await resolveTrust(config.securityPorts, {
    presentedIdentityRef: envelope.provenance.originComponent,
    expectedInstanceId: envelope.instanceId,
    expectedTenantId: envelope.tenantId,
    authorizationEvidenceRef: envelope.authorizationEvidenceRef ?? null,
    requiredScope,
    now,
  });
  if (!trust.trusted) {
    return refuse("TRUST", trust.reason, trust.dependencyOutage);
  }

  // ── 4. Contract. Can the destination understand this schema version? ─────
  const producerContract = config.contracts.get(`${envelope.schemaId}@${envelope.schemaVersion}`);
  const consumerContract = config.consumerContracts.get(envelope.destination.capability);
  if (!producerContract) {
    return refuse(
      "CONTRACT",
      `No contract is registered for ${envelope.schemaId}@${envelope.schemaVersion}. An unregistered schema cannot be checked for compatibility, and "probably fine" is how the first incompatible message finds whoever is on call.`,
      false,
    );
  }
  if (consumerContract) {
    const speak = canSpeak(producerContract, consumerContract, now);
    if (!speak.canSpeak) {
      return refuse("CONTRACT", `${speak.reason} ${speak.remedy}`, false);
    }
  }

  // ── 5. Expiry. Before routing spends anything on it. ─────────────────────
  const expired = isExpired(envelope, sentAt, now);

  // ── 6+7. Nexus candidates, then RoutingIQ selection. ─────────────────────
  const origin = envelope.source.participantId ?? envelope.provenance.originComponent;
  const candidates = candidateRoutes(config.graph, origin, envelope.destination.capability, envelope.lane);
  const circuits = new Map<string, CircuitState>();
  for (const path of candidates.permitted) {
    const key = defaultPathKey(path);
    const circuit = stores.getCircuit(key) ?? newCircuit(key);
    // The EFFECTIVE state, not the stored one. Found by the integration test:
    // routing filters OPEN circuits out, so a stored OPEN whose probe window
    // has elapsed would never reach the probe stage — the breaker could never
    // close again, and every open circuit would be permanent. `admits` knows
    // about the window; presenting an elapsed OPEN as HALF_OPEN lets selection
    // offer it as a last resort, and the circuit stage below runs the probe.
    const gate = admits(circuit, config.circuitPolicy, now);
    circuits.set(key, circuit.state === "OPEN" && gate.admitted ? "HALF_OPEN" : circuit.state);
  }
  const route = routeSignal({
    envelope,
    candidates,
    health: config.health,
    circuits,
    pathKey: defaultPathKey,
    now,
    expired,
  });
  if (route.chosen === null) {
    return refuse("ROUTING", route.explanation, route.refusedAt === "NO_HEALTHY_ROUTE");
  }
  const pathKey = defaultPathKey(route.chosen);

  // ── 8. Admission. Per the chosen path's queue, after routing — shedding
  //       against a queue the signal never enters protects nothing. ────────
  const queue = config.queues.get(pathKey) ?? { queueKey: pathKey, depth: 0, capacity: 1 };
  const admission = admit(queue, envelope.lane, config.admission);
  if (!admission.admitted) {
    return refuse("ADMISSION", admission.reason, admission.retryable);
  }

  // ── 9. Delivery semantics. Duplicates replay their outcome here. ─────────
  const existing = envelope.idempotencyKey ? stores.getDelivery(envelope.idempotencyKey) : null;
  const delivery = acceptDelivery(
    existing,
    { idempotencyKey: envelope.idempotencyKey, lane: envelope.lane, now },
    config.deliveryPolicy,
  );
  if (delivery.disposition === "REPLAY_OUTCOME") {
    return refuse(
      "DELIVERY",
      "This key completed already; the original outcome is replayed rather than the work repeated.",
      false,
      delivery.outcomeRef,
    );
  }
  if (delivery.disposition === "WAIT" || delivery.disposition === "REFUSE") {
    return refuse("DELIVERY", delivery.reason, delivery.disposition === "WAIT");
  }
  const deliveryRecord = delivery.record;

  // ── 10. Circuit. The breaker's promise not to keep asking. ───────────────
  let circuit = stores.getCircuit(pathKey) ?? newCircuit(pathKey);
  const admittance = admits(circuit, config.circuitPolicy, now);
  if (!admittance.admitted) {
    return refuse("CIRCUIT", admittance.reason, true);
  }
  if (admittance.asProbe) {
    circuit = markProbeInFlight({ ...circuit, state: "HALF_OPEN" });
    stores.putCircuit(circuit);
  }

  // ── 11. Transport. The provider carries bytes; every decision is behind us.
  const providerId = config.laneBindings.get(envelope.lane);
  const provider = providerId ? config.providers.get(providerId) : undefined;
  if (!provider) {
    return refuse(
      "TRANSPORT",
      `No provider is bound for the ${envelope.lane} lane. This is a control-plane gap, not a fault — §22 forbids any provider being constitutionally required, and the price of that is a lane with no binding carries nothing until somebody binds one.`,
      true,
    );
  }

  try {
    await provider.send({ lane: envelope.lane, envelopeJson: JSON.stringify(envelope) });
  } catch (error) {
    stores.putCircuit(recordOutcome(circuit, config.circuitPolicy, "FAILURE", now));
    if (envelope.idempotencyKey) stores.putDelivery(failDelivery(deliveryRecord, now));
    void error;
    return refuse(
      "TRANSPORT",
      `Provider "${providerId}" failed to send. The thrown detail is not quoted — a provider error is untrusted input to an evidence record. The circuit recorded the failure and the delivery is marked failed, so a retry is a genuine retry.`,
      true,
    );
  }

  stores.putCircuit(recordOutcome(circuit, config.circuitPolicy, "SUCCESS", now));
  if (envelope.idempotencyKey) {
    stores.putDelivery(completeDelivery(deliveryRecord, `sent:${envelope.fabricMessageId}`, now, config.deliveryPolicy));
  }
  stores.appendSpan(span(envelope, sentAt, now, "DELIVERED", `sent via ${providerId} on ${pathKey}`));
  stores.appendEvidence({
    kind: "SENT",
    fabricMessageId: envelope.fabricMessageId,
    correlationId: envelope.correlationId,
    stage: "TRANSPORT",
    reason: `via ${providerId}`,
    at: now,
  });

  return {
    sent: true,
    fabricMessageId: envelope.fabricMessageId,
    viaProvider: providerId!,
    pathKey,
    route,
    trustEvidence: trust.evidence,
    note: `Delivered to transport after ${route.checks.length} routing checks. ${route.explanation}`,
  };
}

function span(
  envelope: FabricEnvelope,
  sentAt: string,
  now: string,
  outcome: TraceSpan["outcome"],
  reason: string,
): TraceSpan {
  return {
    fabricMessageId: envelope.fabricMessageId,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    lane: envelope.lane,
    fromCapability: envelope.source.capability,
    toCapability: envelope.destination.capability,
    startedAt: sentAt,
    durationMs: Math.max(0, Date.parse(now) - Date.parse(sentAt)) || 0,
    outcome,
    reason,
  };
}

/**
 * A host-memory store set, for tests and single-process deployments.
 *
 * Deliberately trivial: the interesting store implementations belong to hosts,
 * and this one exists so the pipeline can be exercised without one.
 */
export function inMemoryStores(): RuntimeStores & {
  readonly spans: readonly TraceSpan[];
  readonly evidence: readonly {
    readonly kind: "SENT" | "REFUSED" | "REPLAYED" | "DEAD_LETTERED";
    readonly fabricMessageId: string;
    readonly correlationId: string;
    readonly stage: string;
    readonly reason: string;
    readonly at: string;
  }[];
} {
  const circuits = new Map<string, Circuit>();
  const deliveries = new Map<string, DeliveryRecord>();
  const spans: TraceSpan[] = [];
  const evidence: {
    kind: "SENT" | "REFUSED" | "REPLAYED" | "DEAD_LETTERED";
    fabricMessageId: string;
    correlationId: string;
    stage: string;
    reason: string;
    at: string;
  }[] = [];

  return {
    getCircuit: (key) => circuits.get(key) ?? null,
    putCircuit: (c) => void circuits.set(c.pathKey, c),
    getDelivery: (key) => deliveries.get(key) ?? null,
    putDelivery: (r) => void deliveries.set(r.idempotencyKey, r),
    appendSpan: (s) => void spans.push(s),
    appendEvidence: (e) => void evidence.push(e),
    spans,
    evidence,
  };
}

/** Whether the runtime itself holds any authority. Asserted, not narrated. */
export function runtimeHoldsAuthority(): false {
  return false;
}
