// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  CATEGORY_OF,
  FORBIDDEN_VENDOR_TOKENS,
  HIVE_NATIVE_OBSERVATION_TYPES,
  OBSERVATION_TYPES,
  PRIMARY_CHAMBER_OF,
  SENSOR_KINDS,
  admitObservation,
  buildObservation,
  canonicalVocabulary,
  collectObservations,
  computeSensorCoverage,
  detectionLatencyMs,
  observeAiEnvelopeExcursion,
  observeAuditChainFailure,
  observeBreakGlassUse,
  observeChamberHealthChange,
  observeCrossTenantAttempt,
  observeFabricRoute,
  observeGovernanceRefusal,
  observeIntegrityMismatch,
  observePromptInjection,
  observeTrustDegradation,
  type NativeSensorContext,
  type SecuritySensorProvider,
} from "../index.js";

const context: NativeSensorContext = {
  instanceRef: "instance-a",
  observedAt: "2026-08-30T10:00:00Z",
  receivedAt: "2026-08-30T10:00:02Z",
  observationId: "obs-1",
};

const goodInput = {
  observationId: "obs-1",
  observedAt: "2026-08-30T10:00:00Z",
  receivedAt: "2026-08-30T10:00:02Z",
  source: { sensorKind: "hive-native", provider: "hive.neural-fabric", instanceRef: "instance-a" },
  subject: { kind: "fabric-route" as const, ref: "lane-7" },
  observationType: "fabric-route-denied" as const,
  severity: "moderate" as const,
  confidence: "confirmed" as const,
  dataClassification: "internal" as const,
  privacyScope: "instance-local" as const,
  sourceAttested: false,
  adapterRef: "adapter.test@1.0.0",
};

describe("§11 semantic conventions — one vocabulary, no vendor names", () => {
  it("every observation type has a canonical category, and every category a primary chamber", () => {
    for (const type of OBSERVATION_TYPES) {
      const category = CATEGORY_OF[type];
      expect(category, type).toBeDefined();
      expect(PRIMARY_CHAMBER_OF[category], `${type} -> ${category}`).toMatch(/^(shield|guard)$/);
    }
  });
  it("no vendor token appears anywhere in the canonical vocabulary", () => {
    for (const name of canonicalVocabulary()) {
      for (const vendor of FORBIDDEN_VENDOR_TOKENS) {
        expect(name.toLowerCase().includes(vendor), `${name} contains ${vendor}`).toBe(false);
      }
    }
  });
  it("sensor kinds name observation domains, not products", () => {
    for (const kind of SENSOR_KINDS) {
      for (const vendor of FORBIDDEN_VENDOR_TOKENS) {
        expect(kind.toLowerCase().includes(vendor), `${kind} contains ${vendor}`).toBe(false);
      }
    }
  });
});

describe("§9/§10 the observation contract — admission is the single door", () => {
  it("a well-formed observation is admitted with its category derived, not asserted", () => {
    const admission = buildObservation(goodInput);
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;
    expect(admission.observation.category).toBe("network-and-fabric");
    expect(admission.observation.normalization.conventionsVersion).toBe("1.0.0");
  });
  it("a mislabelled category is refused — it would route the observation to the wrong chamber", () => {
    const built = buildObservation(goodInput);
    if (!built.admitted) return;
    const tampered = { ...built.observation, category: "runtime" };
    const admission = admitObservation(tampered);
    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.reason).toBe("schema-invalid");
  });
  it("GATE: secret material in ANY free-text surface refuses the whole record, naming the field", () => {
    const withSecretAttribute = buildObservation({
      ...goodInput,
      attributes: { detail: "recovered config password: hunter2-rotate-me" },
    });
    expect(withSecretAttribute.admitted).toBe(false);
    if (withSecretAttribute.admitted) return;
    expect(withSecretAttribute.reason).toBe("secret-material-present");
    expect(withSecretAttribute.offendingFields).toContain("detail");
    // ...and in an evidence locator, and in a subject label.
    const inLocator = buildObservation({
      ...goodInput,
      evidenceRefs: [{ holder: "external", locator: "Bearer abcdefghijklmnop0123456789" }],
    });
    expect(inLocator.admitted).toBe(false);
    const inLabel = buildObservation({
      ...goodInput,
      subject: { kind: "identity", ref: "user-1", label: "-----BEGIN RSA PRIVATE KEY-----" },
    });
    expect(inLabel.admitted).toBe(false);
  });
  it("GATE: protected-health and regulated data are NEVER collective-eligible — refused at construction", () => {
    for (const classification of ["protected-health", "regulated"] as const) {
      const admission = buildObservation({
        ...goodInput,
        dataClassification: classification,
        privacyScope: "collective-eligible",
      });
      expect(admission.admitted, classification).toBe(false);
      if (admission.admitted) continue;
      expect(admission.reason).toBe("classification-scope-conflict");
      expect(admission.offendingFields).toContain("privacyScope");
    }
    // The same classification is fine when it stays local.
    expect(buildObservation({ ...goodInput, dataClassification: "protected-health", privacyScope: "instance-local" }).admitted).toBe(true);
  });
  it("normalization gaps are recorded, not dropped — an unmapped field is a visible blind spot", () => {
    const admission = buildObservation({ ...goodInput, unmappedFields: ["vendor_risk_score"], lossy: true });
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;
    expect(admission.observation.normalization.unmappedFields).toEqual(["vendor_risk_score"]);
    expect(admission.observation.normalization.lossy).toBe(true);
  });
  it("detection latency comes from the record's own instants; unusable timestamps give null, never zero", () => {
    const admission = buildObservation(goodInput);
    if (!admission.admitted) return;
    expect(detectionLatencyMs(admission.observation)).toBe(2_000);
    expect(detectionLatencyMs({ ...admission.observation, receivedAt: "not-a-time" })).toBeNull();
  });
  it("an ATT&CK reference must be well-formed or absent — never a free-text tag", () => {
    expect(buildObservation({ ...goodInput, attackTechniqueRef: "T1021.001" }).admitted).toBe(true);
    expect(buildObservation({ ...goodInput, attackTechniqueRef: "lateral movement" }).admitted).toBe(false);
  });
});

describe("§12 sensor ports — an unbound sensor is a NAMED blind spot", () => {
  const provider = (
    sensorKind: (typeof SENSOR_KINDS)[number],
    providerRef: string,
    pull: SecuritySensorProvider["pull"],
    declared: readonly string[] = [],
  ): SecuritySensorProvider => ({
    descriptor: { sensorKind, providerRef, declaredObservationTypes: declared, selfAttesting: false },
    pull,
  });
  it("coverage is a set difference with named gaps — never a percentage", () => {
    const coverage = computeSensorCoverage(
      [provider("hive-native", "hive", () => ({ state: "observations", observations: [] }), ["fabric-route-denied"])],
      ["fabric-route-denied", "process-executed"],
    );
    expect(coverage.boundKinds).toEqual(["hive-native"]);
    expect(coverage.unboundKinds).toContain("runtime");
    expect(coverage.unclaimedObservationTypes).toEqual(["process-executed"]);
    expect(coverage.coverageStatement).toContain("unclaimed observation types: process-executed");
    expect(JSON.stringify(coverage)).not.toMatch(/percent|Percent|%/);
  });
  it("an unavailable provider yields a gap, NOT an empty result that reads as calm", () => {
    const result = collectObservations(
      [provider("runtime", "runtime-sensor", () => ({ state: "unavailable", reason: "no runtime sensor bound" }))],
      "2026-08-30T10:00:00Z",
      "2026-08-30T11:00:00Z",
    );
    expect(result.observations).toHaveLength(0);
    expect(result.complete).toBe(false); // silence is not safety
    expect(result.gaps[0]!.reason).toBe("no runtime sensor bound");
    expect(result.gaps[0]!.degraded).toBe(false);
  });
  it("a degraded provider contributes its partial observations AND a gap", () => {
    const built = buildObservation(goodInput);
    if (!built.admitted) return;
    const result = collectObservations(
      [
        provider("host-siem", "siem", () => ({
          state: "degraded",
          reason: "query window truncated",
          partialObservations: [built.observation],
        })),
      ],
      "2026-08-30T10:00:00Z",
      "2026-08-30T11:00:00Z",
    );
    expect(result.observations).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.gaps[0]!.degraded).toBe(true);
  });
  it("only an all-answered collection is complete", () => {
    const result = collectObservations(
      [provider("hive-native", "hive", () => ({ state: "observations", observations: [] }))],
      "2026-08-30T10:00:00Z",
      "2026-08-30T11:00:00Z",
    );
    expect(result.complete).toBe(true);
  });
});

describe("§13 Hive-native sensors — translators, not judges", () => {
  it("a Governance refusal becomes a constitutional observation carrying its audit reference", () => {
    const admission = observeGovernanceRefusal(context, {
      subjectRef: "agent-9",
      capabilityRequested: "deploy_release",
      refusalReason: "capability not granted",
      severity: "moderate",
      confidence: "confirmed",
      auditLocator: "audit://decision/771",
    });
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;
    expect(admission.observation.category).toBe("constitutional");
    expect(admission.observation.evidenceRefs[0]!.holder).toBe("audit-iq");
    expect(admission.observation.privacyScope).toBe("instance-local");
  });
  it("severity and confidence come from the OWNING component — the translator invents neither", () => {
    const low = observeFabricRoute(context, {
      routeRef: "lane-1",
      outcome: "failed",
      reason: "timeout",
      severity: "low",
      confidence: "suspected",
      evidenceLocator: "fabric://route/1",
    });
    const high = observeFabricRoute(context, {
      routeRef: "lane-1",
      outcome: "denied",
      reason: "policy",
      severity: "high",
      confidence: "confirmed",
      evidenceLocator: "fabric://route/1",
    });
    if (!low.admitted || !high.admitted) return;
    expect(low.observation.severity).toBe("low");
    expect(high.observation.severity).toBe("high");
    expect(low.observation.observationType).toBe("fabric-route-failed");
    expect(high.observation.observationType).toBe("fabric-route-denied");
  });
  it("a broken audit chain caps confidence at probable — it does not say WHO broke it", () => {
    const admission = observeAuditChainFailure(context, {
      ledgerRef: "ledger-main",
      brokenAtSequence: "44219",
      severity: "catastrophic",
      evidenceLocator: "audit://chain/44219",
    });
    if (!admission.admitted) return;
    expect(admission.observation.confidence).toBe("probable");
  });
  it("a prompt-injection observation NEVER inlines the attacker's directives", () => {
    const admission = observePromptInjection(context, { agentRef: "agent-x", inertDirectiveCount: 3, severity: "high" });
    if (!admission.admitted) return;
    expect(admission.observation.attributes["inertDirectiveCount"]).toBe("3");
    expect(admission.observation.attributes["directivesInlined"]).toBe("false");
    // The screened text itself appears nowhere in the record.
    expect(JSON.stringify(admission.observation)).not.toMatch(/ignore prior instructions/i);
  });
  it("Sentinel observing itself uses the self category, and native sensors never claim attestation", () => {
    const self = observeIntegrityMismatch(context, {
      artifactRef: "sentineliq.dist",
      expectedDigest: "abc",
      observedDigest: "def",
      isSentinelSelf: true,
      severity: "catastrophic",
      confidence: "confirmed",
    });
    if (!self.admitted) return;
    expect(self.observation.category).toBe("sentinel-self");
    expect(self.observation.sourceAttested).toBe(false); // claiming it would be the false-validator move
    const chamber = observeChamberHealthChange(context, { chamber: "guard", from: "operational", to: "impaired", severity: "high" });
    expect(chamber.admitted && chamber.observation.category).toBe("sentinel-self");
  });
  it("the remaining native producers admit and categorize correctly", () => {
    const trust = observeTrustDegradation(context, { workloadRef: "w1", reason: "ttl expired", severity: "moderate", confidence: "confirmed", evidenceLocator: "x" });
    expect(trust.admitted && trust.observation.category).toBe("identity-and-trust");
    const ai = observeAiEnvelopeExcursion(context, { agentRef: "aria", capabilityRequested: "write_policy", violation: "undeclared", severity: "high", confidence: "confirmed" });
    expect(ai.admitted && ai.observation.category).toBe("ai-activity");
    const tenancy = observeCrossTenantAttempt(context, { subjectRef: "svc-3", fromTenant: "t1", towardTenant: "t2", severity: "catastrophic", confidence: "probable", evidenceLocator: "y" });
    expect(tenancy.admitted && tenancy.observation.category).toBe("data-protection");
    const glass = observeBreakGlassUse(context, { operatorRef: "human.steven", reason: "recovery", recordRef: "bg-1" });
    expect(glass.admitted && glass.observation.severity).toBe("high"); // always visible afterwards
  });
  it("every native producer type is in the coverage catalogue — the Hive's own visibility, computable", () => {
    for (const type of HIVE_NATIVE_OBSERVATION_TYPES) {
      expect(OBSERVATION_TYPES.includes(type), type).toBe(true);
    }
    const coverage = computeSensorCoverage(
      [
        {
          descriptor: { sensorKind: "hive-native", providerRef: "hive", declaredObservationTypes: [...HIVE_NATIVE_OBSERVATION_TYPES], selfAttesting: false },
          pull: () => ({ state: "observations", observations: [] }),
        },
      ],
      [...HIVE_NATIVE_OBSERVATION_TYPES, "process-executed"],
    );
    // With no third-party sensor bound, runtime is exactly the blind spot.
    expect(coverage.unclaimedObservationTypes).toEqual(["process-executed"]);
  });
});

// ─── guards ─────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("guards — observation plane", () => {
  const dir = join(process.cwd(), "packages", "sentineliq", "src", "v2");
  const files = ["securityConventions.ts", "observation.ts", "providers.ts", "hiveSensors.ts"].map((name) => ({
    name,
    text: readFileSync(join(dir, name), "utf8"),
  }));
  it("no sensor implementation ships in the kernel — ports only, no network or fs", () => {
    for (const f of files) {
      expect(/require\(|from\s+"node:(net|http|https|fs|child_process)"/.test(f.text), f.name).toBe(false);
      expect(/fetch\(/.test(f.text), f.name).toBe(false);
    }
  });
  it("no clock reads: instants are always supplied", () => {
    for (const f of files) {
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)/.test(f.text), f.name).toBe(false);
    }
  });
  it("the observation plane never bypasses admission — no exported raw constructor", () => {
    const observation = files.find((f) => f.name === "observation.ts")!;
    // Every path out of this module returns an admission result.
    expect(/export function (buildObservation|admitObservation)/.test(observation.text)).toBe(true);
    expect(/export function createObservationUnchecked|export const rawObservation/.test(observation.text)).toBe(false);
  });
});
