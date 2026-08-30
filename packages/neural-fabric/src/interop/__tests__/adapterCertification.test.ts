/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  adapterManifestSchema,
  describeWidening,
  manifestEstablishesCapability,
  type AdapterManifest,
} from "../adapterManifest.js";
import {
  certificationImpliesAdmission,
  certifyAdapter,
  mayEnterProductionPath,
  type AdapterUnderTest,
  type HarnessEnvironment,
  type ProductionAdmission,
} from "../certificationHarness.js";

const T0 = "2026-08-30T10:00:00.000Z";

const manifest = (over: Record<string, unknown> = {}): AdapterManifest =>
  adapterManifestSchema.parse({
    adapterId: "reference-queue",
    version: "1.0.0",
    summary: "An in-process durable queue used to exercise the harness.",
    provenance: {
      publisher: "Interaxys Solutions",
      sourceRef: "packages/neural-fabric/src/providers",
      artifactDigest: "sha256:aaaa",
      signedBy: "security-iq",
      license: "UNLICENSED",
      knownAdvisories: [],
    },
    trustTier: "FIRST_PARTY",
    protocols: ["in-process"],
    lanesOffered: ["COMMAND", "EVENT"],
    capabilities: ["durable-queue", "acknowledgement"],
    durable: true,
    replayable: false,
    redelivers: true,
    orderingScopes: ["PER_KEY"],
    maxMessageBytes: 65_536,
    maxInFlight: 100,
    supportsBackpressure: true,
    mutualTlsCapable: false,
    propagatesAuthorizationEvidence: true,
    propagatesTraceContext: true,
    suitableForMobileEdge: false,
    supportsReconnect: true,
    permittedClassifications: ["INTERNAL", "TENANT_PRIVATE"],
    requiresFilesystemAccess: false,
    requiresOutboundNetwork: false,
    requiresSandbox: false,
    requiresControlPlaneWrite: false,
    certificationEvidenceRef: null,
    ...over,
  });

const ENVIRONMENT: HarnessEnvironment = {
  crossLanguageRuntimeAvailable: false,
  pkiAvailable: false,
  supplyChainScannerAvailable: true,
  previousManifest: null,
};

/**
 * A configurable adapter under test. Each flag disables one honest behaviour,
 * so a test can prove the harness NOTICES rather than merely passes.
 */
interface Flaws {
  readonly acceptsMalformed?: boolean;
  readonly losesOnRestart?: boolean;
  readonly reordersUnderKey?: boolean;
  readonly unboundedBuffer?: boolean;
  readonly acceptsOversized?: boolean;
  readonly throwsOnHostileInput?: boolean;
  readonly stripsAuthorizationRef?: boolean;
  readonly silentDescribe?: boolean;
}

function makeAdapter(manifestUsed: AdapterManifest, flaws: Flaws = {}): AdapterUnderTest {
  let store: { messageId: string; key: string | null; bodyJson: string }[] = [];
  let history: { messageId: string }[] = [];
  let counter = 0;

  return {
    send({ key, bodyJson, metadata }) {
      if (flaws.throwsOnHostileInput === true && !bodyJson.startsWith("{\"probe\"")) {
        throw new Error("adapter exploded on unexpected input");
      }
      let parsed = true;
      try {
        JSON.parse(bodyJson);
      } catch {
        parsed = false;
      }
      if (!parsed && flaws.acceptsMalformed !== true) {
        return { accepted: false, reason: "Not parseable." };
      }
      if (bodyJson.length > manifestUsed.maxMessageBytes && flaws.acceptsOversized !== true) {
        return { accepted: false, reason: "Above the declared size ceiling." };
      }
      if (store.length >= manifestUsed.maxInFlight && flaws.unboundedBuffer !== true) {
        return { accepted: false, reason: "In-flight ceiling reached." };
      }
      counter += 1;
      const messageId = `m-${counter}`;
      const stored =
        flaws.stripsAuthorizationRef === true
          ? bodyJson.replace(/"authorizationEvidenceRef":"[^"]*"/, '"authorizationEvidenceRef":""')
          : bodyJson;
      void metadata;
      store.push({ messageId, key, bodyJson: stored });
      history.push({ messageId });
      return { accepted: true, messageId };
    },
    drain() {
      const out = flaws.reordersUnderKey === true ? [...store].reverse() : [...store];
      store = [];
      return out;
    },
    restart() {
      if (flaws.losesOnRestart === true) {
        store = [];
        history = [];
      }
      return true;
    },
    replay() {
      return manifestUsed.replayable ? [...history] : null;
    },
    inFlight() {
      return store.length;
    },
    describe() {
      return flaws.silentDescribe === true ? "" : `reference-queue@1.0.0, ${store.length} message(s) held, connected.`;
    },
  };
}

describe("an adapter manifest is a claim, and the schema refuses the dangerous ones", () => {
  it("establishes no capability by itself", () => {
    expect(manifestEstablishesCapability()).toBe(false);
  });

  it("refuses any adapter that asks to write the control plane", () => {
    const result = adapterManifestSchema.safeParse({ ...manifest(), requiresControlPlaneWrite: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("grant itself a route");
  });

  it("refuses a replay claim without durability", () => {
    expect(adapterManifestSchema.safeParse({ ...manifest(), replayable: true, durable: false }).success).toBe(false);
  });

  it("refuses an unsigned verified-third-party adapter", () => {
    const result = adapterManifestSchema.safeParse({
      ...manifest(),
      trustTier: "VERIFIED_THIRD_PARTY",
      provenance: { ...manifest().provenance, signedBy: null },
    });
    expect(result.success).toBe(false);
  });

  it("refuses an untrusted adapter that does not require a sandbox", () => {
    const result = adapterManifestSchema.safeParse({ ...manifest(), trustTier: "UNTRUSTED", requiresSandbox: false });
    expect(result.success).toBe(false);
  });

  it("refuses restricted data over a channel that cannot authenticate both ends", () => {
    const result = adapterManifestSchema.safeParse({
      ...manifest(),
      permittedClassifications: ["RESTRICTED"],
      mutualTlsCapable: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("capability widening is visible across versions", () => {
  it("names every addition, including dropped sandbox requirements and raised limits", () => {
    const before = manifest();
    const after = manifest({
      version: "2.0.0",
      lanesOffered: ["COMMAND", "EVENT", "EVIDENCE"],
      permittedClassifications: ["INTERNAL", "TENANT_PRIVATE", "PERSONAL"],
      requiresFilesystemAccess: true,
      maxMessageBytes: 10_000_000,
    });
    const widening = describeWidening(before, after);
    expect(widening.widened).toBe(true);
    expect(widening.additions).toContain("lane: EVIDENCE");
    expect(widening.additions).toContain("classification: PERSONAL");
    expect(widening.additions).toContain("privilege: filesystem access");
    expect(widening.additions.some((a) => a.includes("max message bytes"))).toBe(true);
  });

  it("reports no widening when a version claims nothing new", () => {
    expect(describeWidening(manifest(), manifest({ version: "1.0.1" })).widened).toBe(false);
  });
});

describe("the harness tests claims rather than reading them", () => {
  it("certifies an adapter that keeps every claim it made", () => {
    const m = manifest();
    const evidence = certifyAdapter(m, makeAdapter(m), ENVIRONMENT, T0);
    expect(evidence.certified).toBe(true);
    expect(evidence.failed).toBe(0);
    expect(evidence.checks).toHaveLength(25);
  });

  it("records what it could not exercise instead of passing it", () => {
    const m = manifest();
    const evidence = certifyAdapter(m, makeAdapter(m), ENVIRONMENT, T0);
    expect(evidence.notExercised).toBeGreaterThan(0);
    const crossLanguage = evidence.checks.find((c) => c.checkId === "23-cross-language")!;
    expect(crossLanguage.outcome).toBe("NOT_EXERCISED");
    expect(crossLanguage.remedy).toContain("second runtime");
  });

  it("refuses to certify a durability claim the adapter cannot keep", () => {
    const m = manifest({ durable: true });
    const evidence = certifyAdapter(m, makeAdapter(m, { losesOnRestart: true }), ENVIRONMENT, T0);
    expect(evidence.certified).toBe(false);
    const durability = evidence.checks.find((c) => c.checkId === "08-durability")!;
    expect(durability.outcome).toBe("FAILED");
    expect(durability.remedy).toContain("drop the claim");
  });

  it("refuses to certify an ordering claim the adapter violates", () => {
    const m = manifest({ orderingScopes: ["PER_KEY"] });
    const evidence = certifyAdapter(m, makeAdapter(m, { reordersUnderKey: true }), ENVIRONMENT, T0);
    expect(evidence.certified).toBe(false);
    expect(evidence.checks.find((c) => c.checkId === "07-ordering")!.outcome).toBe("FAILED");
  });

  it("catches an unbounded buffer behind a backpressure claim", () => {
    const m = manifest({ supportsBackpressure: true, maxInFlight: 20 });
    const evidence = certifyAdapter(m, makeAdapter(m, { unboundedBuffer: true }), ENVIRONMENT, T0);
    expect(evidence.certified).toBe(false);
    const backpressure = evidence.checks.find((c) => c.checkId === "10-backpressure")!;
    expect(backpressure.outcome).toBe("FAILED");
    expect(backpressure.evidence).toContain("unbounded in practice");
  });

  it("catches an adapter that accepts malformed input", () => {
    const m = manifest();
    const evidence = certifyAdapter(m, makeAdapter(m, { acceptsMalformed: true }), ENVIRONMENT, T0);
    expect(evidence.checks.find((c) => c.checkId === "01-contract-correctness")!.outcome).toBe("FAILED");
  });

  it("catches an adapter that ignores its own size ceiling", () => {
    const m = manifest();
    const evidence = certifyAdapter(m, makeAdapter(m, { acceptsOversized: true }), ENVIRONMENT, T0);
    expect(evidence.checks.find((c) => c.checkId === "18-size-limits")!.outcome).toBe("FAILED");
  });

  it("catches an adapter that throws on hostile input instead of refusing it", () => {
    const m = manifest();
    const evidence = certifyAdapter(m, makeAdapter(m, { throwsOnHostileInput: true }), ENVIRONMENT, T0);
    const adversarial = evidence.checks.find((c) => c.checkId === "21-adversarial-input")!;
    expect(adversarial.outcome).toBe("FAILED");
    expect(adversarial.evidence).toContain("attacker-reachable");
  });

  it("catches an adapter that drops the authorization reference it claims to carry", () => {
    const m = manifest({ propagatesAuthorizationEvidence: true });
    const evidence = certifyAdapter(m, makeAdapter(m, { stripsAuthorizationRef: true }), ENVIRONMENT, T0);
    expect(evidence.checks.find((c) => c.checkId === "15-authorization-propagation")!.outcome).toBe("FAILED");
  });

  it("catches an adapter with no operator diagnostics", () => {
    const m = manifest();
    const evidence = certifyAdapter(m, makeAdapter(m, { silentDescribe: true }), ENVIRONMENT, T0);
    expect(evidence.checks.find((c) => c.checkId === "24-operator-diagnostics")!.outcome).toBe("FAILED");
  });

  it("does not certify when a REQUIRED check could not be exercised", () => {
    // mutualTlsCapable makes checks 13/14 (rotation, auth failure) required,
    // and this environment has no PKI to exercise them. The honest outcome is
    // "not certified", not "certified with caveats" — that distinction is the
    // entire reason NOT_EXERCISED exists as an outcome.
    const m = manifest({ mutualTlsCapable: true });
    const evidence = certifyAdapter(m, makeAdapter(m), { ...ENVIRONMENT, pkiAvailable: false }, T0);
    const rotation = evidence.checks.find((c) => c.checkId === "13-credential-rotation")!;
    expect(rotation.required).toBe(true);
    expect(rotation.outcome).toBe("NOT_EXERCISED");
    expect(evidence.failed).toBe(0);
    expect(evidence.certified).toBe(false);
    expect(evidence.summary).toContain("NOT certified");
  });

  it("certifies the same adapter once a PKI is available to exercise those checks", () => {
    const m = manifest({ mutualTlsCapable: true });
    const evidence = certifyAdapter(m, makeAdapter(m), { ...ENVIRONMENT, pkiAvailable: true }, T0);
    expect(evidence.certified).toBe(true);
  });

  it("marks a claim the adapter never made as not applicable, not as a pass", () => {
    const m = manifest({ replayable: false, durable: true });
    const evidence = certifyAdapter(m, makeAdapter(m), ENVIRONMENT, T0);
    expect(evidence.checks.find((c) => c.checkId === "09-replay")!.outcome).toBe("NOT_APPLICABLE");
  });

  it("fails a version that quietly widens what the adapter may do", () => {
    const previous = manifest();
    const widened = manifest({ version: "2.0.0", lanesOffered: ["COMMAND", "EVENT", "EVIDENCE"] });
    const evidence = certifyAdapter(widened, makeAdapter(widened), { ...ENVIRONMENT, previousManifest: previous }, T0);
    const rollback = evidence.checks.find((c) => c.checkId === "25-rollback-compatibility")!;
    expect(rollback.outcome).toBe("FAILED");
    expect(rollback.remedy).toContain("ApproveAdapterCapabilityExpansion");
    expect(evidence.certified).toBe(false);
  });
});

describe("certification is evidence; Governance decides admission", () => {
  const m = manifest();
  const evidence = certifyAdapter(m, makeAdapter(m), ENVIRONMENT, T0);

  const admission = (over: Partial<ProductionAdmission> = {}): ProductionAdmission => ({
    adapterId: "reference-queue",
    adapterVersion: "1.0.0",
    authorizingDecisionRef: "dec-admit-1",
    admittedAt: T0,
    notAfter: "2027-01-01T00:00:00.000Z",
    revoked: false,
    ...over,
  });

  it("says so, assertably", () => {
    expect(certificationImpliesAdmission()).toBe(false);
  });

  it("refuses production with certification but no admission decision", () => {
    const verdict = mayEnterProductionPath(m, evidence, null, T0);
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("Governance makes it");
  });

  it("permits production with certification and a live admission", () => {
    expect(mayEnterProductionPath(m, evidence, admission(), T0).permitted).toBe(true);
  });

  it("refuses when the admission covers a different version", () => {
    const verdict = mayEnterProductionPath(m, evidence, admission({ adapterVersion: "0.9.0" }), T0);
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("approval of one version is not an approval of the next");
  });

  it("refuses when the evidence describes a different artifact digest", () => {
    const other = { ...evidence, artifactDigest: "sha256:bbbb" };
    const verdict = mayEnterProductionPath(m, other, admission(), T0);
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("not evidence about this one");
  });

  it("refuses a revoked or expired admission", () => {
    expect(mayEnterProductionPath(m, evidence, admission({ revoked: true }), T0).permitted).toBe(false);
    expect(mayEnterProductionPath(m, evidence, admission(), "2028-01-01T00:00:00.000Z").permitted).toBe(false);
  });

  it("refuses production for an adapter that failed certification, admission or not", () => {
    const failing = certifyAdapter(m, makeAdapter(m, { losesOnRestart: true }), ENVIRONMENT, T0);
    expect(mayEnterProductionPath(m, failing, admission(), T0).permitted).toBe(false);
  });
});
