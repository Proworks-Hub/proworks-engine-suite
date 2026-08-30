/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/certificationLayers.ts
 * Module:   neural-fabric
 * Purpose:  Certification beyond the kernel — layered, evidenced, allowed to fail.
 */

import { certify } from "./certification.js";
import { resolveTrust, fabricHoldsTrustRoot, type SecurityPortSet } from "./ports/securityPorts.js";
import { ingressCheck, grantsCompose, type GatewayConfig } from "./interconnect/gateway.js";
import { mayCarry, providerIsRequired, type ProviderCapability } from "./ports/providers.js";
import { SEND_STAGES } from "./runtime/fabricRuntime.js";
import { runtimeHoldsAuthority } from "./runtime/fabricRuntime.js";
import { dataPlaneMayMutateControlPlane } from "./runtime/controlPlane.js";
import { twinMayActivate } from "./twin/executableTwin.js";
import type { SimulationResult } from "./engines/fabricAdaptationIQ.js";
import { fabricEnvelopeSchema } from "./domain/envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE KERNEL GATES INSPECT. THE OUTER LAYERS DEMAND RECEIPTS.
//
// `certify()` asks structural questions and can answer them from the code
// alone. Everything past the kernel is different in kind: whether a provider
// carries what it claims, whether the pipeline refuses in the right order,
// whether a forged peer is turned away, whether the system survived faults,
// whether a latency target was MET — none of those can be read off a type.
// They have to be run, and this module's rule is that a layer with no run
// behind it FAILS, with a remedy naming the run that is missing.
//
// So the resilience and performance layers take evidence as input, and refuse
// to pass on its absence. That is deliberate: the alternative is a
// certification that passes on a fresh checkout that has never executed a
// benchmark, and a certificate you cannot lose is a logo.
//
// Every gate carries evidence and, on failure, a remedy. There is no score.
// A number out of a hundred tells nobody what to fix; a failed gate with a
// remedy does.
// ─────────────────────────────────────────────────────────────────────────────

export type LayerId =
  | "KERNEL"
  | "PROVIDER"
  | "RUNTIME"
  | "SECURITY_INTEGRATION"
  | "CROSS_INSTANCE"
  | "RESILIENCE"
  | "PERFORMANCE";

export interface LayerGate {
  readonly gateId: string;
  readonly rule: string;
  readonly passed: boolean;
  readonly evidence: string;
  readonly remedy: string | null;
}

export interface LayerResult {
  readonly layer: LayerId;
  readonly gates: readonly LayerGate[];
  readonly passed: boolean;
}

export interface LayeredCertificationReport {
  readonly engine: "Neural Fabric";
  readonly layers: readonly LayerResult[];
  /** True only when EVERY layer passed. Expected to be false until every run has receipts. */
  readonly certified: boolean;
  readonly summary: string;
}

/** One measured size from the scale program. All times are wall-clock milliseconds. */
export interface PerformanceMeasurement {
  readonly logicalNodes: number;
  readonly graphBuildMs: number;
  readonly routeLookupP50Ms: number;
  readonly routeLookupP95Ms: number;
  readonly routeLookupP99Ms: number;
  /** Honesty about method: whether a route cache sat in front of the lookup. */
  readonly cached: boolean;
}

export interface LayerEvidence {
  /** Capabilities of the providers actually bound in this deployment. */
  readonly boundProviders: readonly ProviderCapability[];
  /** The security ports actually wired, so fail-closed can be demonstrated live. */
  readonly securityPorts: SecurityPortSet;
  /** A gateway config with at least one real grant, for the live forged-peer check. */
  readonly gateway: GatewayConfig;
  /** Chaos/twin scenarios that were RUN, with their results. */
  readonly resilienceRuns: readonly SimulationResult[];
  /** Benchmark measurements that were RUN. */
  readonly performanceRuns: readonly PerformanceMeasurement[];
  readonly now: string;
}

const gate = (gateId: string, rule: string, passed: boolean, evidence: string, remedy: string): LayerGate => ({
  gateId,
  rule,
  passed,
  evidence,
  remedy: passed ? null : remedy,
});

/** §25 hot-path target: low-single-digit milliseconds p95 for a local route decision. */
export const ROUTE_LOOKUP_P95_TARGET_MS = 5;

/**
 * Runs every layer. Async because two of the checks are live calls into
 * fail-closed compositions rather than readings of declared structure.
 */
export async function certifyLayers(input: LayerEvidence): Promise<LayeredCertificationReport> {
  const layers: LayerResult[] = [];

  // ── KERNEL: the seven hard gates, unchanged ────────────────────────────────
  const kernel = certify();
  layers.push({
    layer: "KERNEL",
    gates: kernel.gates.map((g) => ({ gateId: g.gateId, rule: g.rule, passed: g.passed, evidence: g.evidence, remedy: g.remedy })),
    passed: kernel.gates.every((g) => g.passed),
  });

  // ── PROVIDER: what is bound, and whether its claims are lawful ────────────
  {
    const gates: LayerGate[] = [];
    gates.push(
      gate(
        "no-required-provider",
        "No provider is constitutionally required.",
        !providerIsRequired(),
        "providerIsRequired() returns false; every lane declares its degraded behaviour in advance.",
        "A provider the constitution requires is a provider that owns the constitution.",
      ),
    );
    gates.push(
      gate(
        "providers-bound",
        "At least one transport provider is bound and probed.",
        input.boundProviders.length > 0,
        input.boundProviders.length > 0
          ? `${input.boundProviders.length} provider(s) bound: ${input.boundProviders.map((c) => `${c.providerId} (${c.family}, lanes: ${c.lanesOffered.join("/")})`).join("; ")}.`
          : "No provider capability was supplied.",
        "Bind at least one provider and pass its probed capability here. A fabric with no transport has moved nothing.",
      ),
    );
    // A capability sheet is a CLAIM; `mayCarry` is the law applied at
    // binding. The gate does not demand that every offered lane be lawful —
    // the reference bus deliberately offers EVENT and is refused, which is
    // the law working. It demands two things: every bound provider has at
    // least one lane it may lawfully carry (a provider with none is dead
    // weight wearing a binding), and every refusal names a consequence, so
    // the refusal teaches instead of stonewalls.
    const lawfulByProvider = new Map<string, string[]>();
    const refusalsWithoutConsequence: string[] = [];
    for (const capability of input.boundProviders) {
      const lawful: string[] = [];
      for (const lane of capability.lanesOffered) {
        const verdict = mayCarry(capability, lane);
        if (verdict.permitted) lawful.push(lane);
        else if (verdict.problems.some((pr) => pr.consequence.length === 0))
          refusalsWithoutConsequence.push(`${capability.providerId}/${lane}`);
      }
      lawfulByProvider.set(capability.providerId, lawful);
    }
    const deadProviders = [...lawfulByProvider.entries()].filter(([, lanes]) => lanes.length === 0).map(([id]) => id);
    gates.push(
      gate(
        "binding-law-applied",
        "Every bound provider carries at least one lane lawfully, and every refused binding names its consequence.",
        input.boundProviders.length > 0 && deadProviders.length === 0 && refusalsWithoutConsequence.length === 0,
        input.boundProviders.length === 0
          ? "No providers to check."
          : `Lawful lanes: ${[...lawfulByProvider.entries()].map(([id, lanes]) => `${id} → ${lanes.join("/") || "NONE"}`).join("; ")}.${refusalsWithoutConsequence.length > 0 ? ` Refusals missing a consequence: ${refusalsWithoutConsequence.join(", ")}.` : ""}`,
        deadProviders.length > 0
          ? "A provider with no lawful lane is bound to nothing. Unbind it or fix its declared semantics."
          : "Bind at least one provider, and make every mayCarry refusal state its consequence.",
      ),
    );
    layers.push({ layer: "PROVIDER", gates, passed: gates.every((g) => g.passed) });
  }

  // ── RUNTIME: pipeline order and authority ─────────────────────────────────
  {
    const idx = (s: string) => SEND_STAGES.indexOf(s as (typeof SEND_STAGES)[number]);
    const trustBeforeRouting = idx("TRUST") >= 0 && idx("ROUTING") > idx("TRUST");
    const admissionAfterRouting = idx("ADMISSION") > idx("ROUTING");
    const gates: LayerGate[] = [
      gate(
        "trust-before-routing",
        "Identity and authorization are checked before any route is computed — an unauthenticated probe learns nothing about the topology.",
        trustBeforeRouting,
        `Pipeline order: ${SEND_STAGES.join(" → ")}.`,
        "Reorder the pipeline. A refusal that arrives after routing has already told the caller which capabilities exist.",
      ),
      gate(
        "admission-after-routing",
        "Admission (backpressure) runs after routing, so shedding never becomes a topology oracle.",
        admissionAfterRouting,
        `ADMISSION at position ${idx("ADMISSION")}, ROUTING at ${idx("ROUTING")}.`,
        "Reorder the pipeline.",
      ),
      gate(
        "runtime-holds-no-authority",
        "The runtime composes verdicts; it holds no authority of its own and the data plane cannot mutate the control plane.",
        !runtimeHoldsAuthority() && !dataPlaneMayMutateControlPlane(),
        "runtimeHoldsAuthority() and dataPlaneMayMutateControlPlane() both return false, and their return types make true unrepresentable.",
        "If either claim inverted, the send path has become an authority. Nothing downstream of it is trustworthy.",
      ),
    ];
    layers.push({ layer: "RUNTIME", gates, passed: gates.every((g) => g.passed) });
  }

  // ── SECURITY_INTEGRATION: fail-closed, demonstrated live ──────────────────
  {
    const throwingPorts: SecurityPortSet = {
      ...input.securityPorts,
      workloadIdentity: {
        verify: () => {
          throw new Error("simulated identity-provider outage");
        },
      },
    };
    const duringOutage = await resolveTrust(throwingPorts, {
      presentedIdentityRef: "spiffe://ksix/certifier",
      expectedInstanceId: "ksix",
      expectedTenantId: "certification",
      authorizationEvidenceRef: null,
      requiredScope: null,
      now: input.now,
    });
    // Mutating this line to `true` is an EQUIVALENT MUTANT today: resolveTrust
    // genuinely always fails closed against a throwing verifier, so the check
    // cannot be made to differ from `true` without also breaking the kernel.
    // It stays because it is a live tripwire — the day a refactor makes
    // resolveTrust fail open, this gate goes red in the report, which is the
    // whole reason the check is a call and not a constant.
    const failedClosed = !duringOutage.trusted && duringOutage.dependencyOutage;
    const gates: LayerGate[] = [
      gate(
        "fabric-holds-no-trust-root",
        "The Fabric holds no key material and no trust root; Security IQ and IdentityIQ do.",
        !fabricHoldsTrustRoot(),
        "fabricHoldsTrustRoot() returns false; the reference integrity verifier refuses because it holds no key material by design.",
        "A fabric with its own trust root is a second security system, and two security systems disagree eventually.",
      ),
      gate(
        "outage-is-refusal",
        "A security dependency that throws is an outage, and an outage is a refusal — demonstrated by calling resolveTrust against a throwing identity port.",
        failedClosed,
        failedClosed
          ? `Live check: resolveTrust returned trusted=false, failedAt=${duringOutage.trusted ? "-" : duringOutage.failedAt}, dependencyOutage=true.`
          : `Live check FAILED: resolveTrust returned trusted=${duringOutage.trusted} against a throwing verifier.`,
        "The worst outage this system could have is the one where an errored verifier counted as a yes.",
      ),
    ];
    layers.push({ layer: "SECURITY_INTEGRATION", gates, passed: gates.every((g) => g.passed) });
  }

  // ── CROSS_INSTANCE: non-transitive trust, demonstrated live ───────────────
  {
    // A forged relay: the envelope claims origin "instance-a" while the
    // supplied gateway's verifier will verify whatever peer it verifies —
    // which, by construction of the claim, is not instance-a.
    const forged = fabricEnvelopeSchema.parse({
      fabricMessageId: `cert-forged-${input.now}`,
      schemaId: "certification.probe",
      schemaVersion: "1",
      lane: "EVENT",
      source: { capability: "certification", participantId: "certifier" },
      destination: { capability: "certification" },
      instanceId: input.gateway.localInstanceId,
      tenantId: "certification",
      correlationId: "cert",
      causationId: null,
      idempotencyKey: "cert-forged-probe",
      provenance: {
        originComponent: "certifier",
        originInstanceId: "instance-that-did-not-present",
        principalKind: "ENGINE",
        transformations: [],
      },
      classification: "INTERNAL",
      priority: "NORMAL",
      contentType: "application/json",
      isTest: true,
    });
    const relayVerdict = await ingressCheck(forged, input.gateway, "presented-by-someone-else", input.now);
    const relayRefused = !relayVerdict.passed;
    const gates: LayerGate[] = [
      gate(
        "grants-never-compose",
        "Interconnect grants are directional and never compose — A→B plus B→C grants nothing A→C.",
        !grantsCompose(),
        "grantsCompose() returns false; ingress refuses any envelope whose claimed origin is not the verified presenter.",
        "Composable grants are transitive trust, and transitive trust is how one compromised peer becomes every peer.",
      ),
      gate(
        "relay-refused-live",
        "A relayed envelope — claimed origin ≠ verified presenter — is refused at ingress, demonstrated against the supplied gateway.",
        relayRefused,
        relayRefused
          ? `Live check: ingress refused at stage ${relayVerdict.passed ? "-" : relayVerdict.stage}.`
          : "Live check FAILED: a forged-origin envelope passed ingress.",
        "If a relay passes ingress, every peer's grant is every other peer's grant.",
      ),
    ];
    layers.push({ layer: "CROSS_INSTANCE", gates, passed: gates.every((g) => g.passed) });
  }

  // ── RESILIENCE: faults that were RUN ──────────────────────────────────────
  {
    const runs = input.resilienceRuns;
    const isolationBreaches = runs.filter((r) => !r.isolationHeld);
    const gates: LayerGate[] = [
      gate(
        "scenarios-were-run",
        "A chaos scenario has to be run, not inspected. This layer fails on an empty ledger.",
        runs.length > 0,
        runs.length > 0 ? `${runs.length} scenario(s) supplied, covering faults: ${[...new Set(runs.map((r) => r.fault))].sort().join(", ")}.` : "No scenario results supplied.",
        "Run the twin scenarios (runScenarios) and the chaos suite, and pass their results here.",
      ),
      gate(
        "isolation-held-everywhere",
        "No fault scenario breached zone isolation.",
        runs.length > 0 && isolationBreaches.length === 0,
        isolationBreaches.length === 0
          ? `Isolation held in ${runs.length}/${runs.length} scenarios.`
          : `Isolation BREACHED in: ${isolationBreaches.map((r) => r.scenarioId).join(", ")}.`,
        "An isolation breach under fault is the finding. Fix the topology rule it exposed before anything else.",
      ),
      gate(
        "twin-cannot-activate",
        "The twin that produced these results can activate nothing.",
        !twinMayActivate(),
        "twinMayActivate() returns false; simulation verdicts carry isAuthorization: false in their type.",
        "A twin that can activate is an untested deployment pipeline wearing a lab coat.",
      ),
    ];
    layers.push({ layer: "RESILIENCE", gates, passed: gates.every((g) => g.passed) });
  }

  // ── PERFORMANCE: targets MET, not targets HOPED ───────────────────────────
  {
    const runs = input.performanceRuns;
    const misses = runs.filter((m) => m.routeLookupP95Ms > ROUTE_LOOKUP_P95_TARGET_MS);
    const gates: LayerGate[] = [
      gate(
        "benchmarks-were-run",
        "Never claim the architecture meets a performance target until the benchmark proves it. This layer fails on an empty ledger.",
        runs.length > 0,
        runs.length > 0
          ? runs
              .map(
                (m) =>
                  `${m.logicalNodes} nodes: build ${m.graphBuildMs.toFixed(1)}ms, lookup p50/p95/p99 = ${m.routeLookupP50Ms.toFixed(2)}/${m.routeLookupP95Ms.toFixed(2)}/${m.routeLookupP99Ms.toFixed(2)}ms (${m.cached ? "cached" : "uncached"})`,
              )
              .join("; ")
          : "No measurements supplied.",
        "Run the scale program and pass its measurements here.",
      ),
      gate(
        "route-lookup-p95",
        `Local route decision p95 ≤ ${ROUTE_LOOKUP_P95_TARGET_MS}ms at every measured size (§25).`,
        runs.length > 0 && misses.length === 0,
        misses.length === 0
          ? `Target met at all ${runs.length} measured sizes.`
          : `Target MISSED at: ${misses.map((m) => `${m.logicalNodes} nodes (p95 ${m.routeLookupP95Ms.toFixed(1)}ms, ${m.cached ? "cached" : "uncached"})`).join("; ")}. The gate stays failed rather than moving the target.`,
        "At hub-scale fan-out an uncached full candidate enumeration is linear in edges. §25's target speaks of a CACHED decision; a host-level route cache (invalidated on topology activation) is the designed remedy, and it has not been built or measured. Until it is, this gate fails.",
      ),
    ];
    layers.push({ layer: "PERFORMANCE", gates, passed: gates.every((g) => g.passed) });
  }

  const failedLayers = layers.filter((l) => !l.passed);
  return {
    engine: "Neural Fabric",
    layers,
    certified: failedLayers.length === 0,
    summary:
      failedLayers.length === 0
        ? `All ${layers.length} layers hold against the supplied evidence. This certifies the invariants and the runs presented — not the deployment that has not happened.`
        : `${failedLayers.length} of ${layers.length} layers failed: ${failedLayers
            .map((l) => `${l.layer} (${l.gates.filter((g) => !g.passed).map((g) => g.gateId).join(", ")})`)
            .join("; ")}. Each failed gate carries a remedy; there is no score to hide behind.`,
  };
}

/** The layered report as text, for a build log. */
export function formatLayeredCertification(report: LayeredCertificationReport): string {
  const lines: string[] = [`Neural Fabric layered certification`, ""];
  for (const layer of report.layers) {
    lines.push(`━━ ${layer.layer} — ${layer.passed ? "PASS" : "FAIL"}`);
    for (const g of layer.gates) {
      lines.push(`  [${g.passed ? "PASS" : "FAIL"}] ${g.gateId}: ${g.rule}`);
      lines.push(`         ${g.evidence}`);
      if (g.remedy !== null) lines.push(`         REMEDY: ${g.remedy}`);
    }
  }
  lines.push("", report.summary);
  return lines.join("\n");
}
