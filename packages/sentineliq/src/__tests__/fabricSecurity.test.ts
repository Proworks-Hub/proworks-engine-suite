// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  ADAPTER_CONTAINMENT_INVARIANTS,
  detectAdapterAnomalies,
  detectCrossTenantMapping,
  detectEvidenceSuppression,
  detectRetryAmplification,
  detectTraceInjection,
  fabricFindingSchema,
  sentinelAppliesContainment,
  sentinelHoldsTrustRoot,
  sentinelRoutesTraffic,
  type AdapterObservation,
} from "../fabricSecurity.js";

const T0 = "2026-08-30T10:00:00.000Z";

const observation = (over: Partial<AdapterObservation> = {}): AdapterObservation => ({
  adapterId: "durable-log",
  version: "1.2.0",
  admittedDigest: "sha256:aaaa",
  runningDigest: "sha256:aaaa",
  admittedCapabilities: ["durable-queue", "acknowledgement"],
  claimedCapabilities: ["durable-queue", "acknowledgement"],
  newAdvisories: [],
  observedAt: T0,
  isTest: true,
  ...over,
});

describe("Sentinel observes the Fabric without joining it", () => {
  it("routes nothing, applies nothing, holds no trust root", () => {
    expect(sentinelRoutesTraffic()).toBe(false);
    expect(sentinelAppliesContainment()).toBe(false);
    expect(sentinelHoldsTrustRoot()).toBe(false);
  });

  it("names all five adapter containment invariants with what enforces each", () => {
    expect(ADAPTER_CONTAINMENT_INVARIANTS).toHaveLength(5);
    for (const item of ADAPTER_CONTAINMENT_INVARIANTS) {
      expect(item.enforcedBy.length).toBeGreaterThan(30);
    }
    expect(ADAPTER_CONTAINMENT_INVARIANTS.map((i) => i.invariant).join(" ")).toContain("bypass Interconnect");
  });

  it("produces findings that are requests, never actions", () => {
    const findings = detectAdapterAnomalies(observation({ runningDigest: "sha256:bbbb" }));
    for (const f of findings) expect(fabricFindingSchema.safeParse(f).success).toBe(true);
    expect(findings[0]!.requestedContainment).toBe("QUARANTINE_ADAPTER");
    expect(findings[0]!.containmentRationale.length).toBeGreaterThan(30);
  });
});

describe("adapter anomalies are judged against the admission record", () => {
  it("finds nothing when the running artifact matches what was admitted", () => {
    expect(detectAdapterAnomalies(observation())).toHaveLength(0);
  });

  it("flags an integrity mismatch as critical and confirmed", () => {
    const findings = detectAdapterAnomalies(observation({ runningDigest: "sha256:tampered" }));
    const integrity = findings.find((f) => f.threat === "ADAPTER_INTEGRITY_MISMATCH")!;
    expect(integrity.severity).toBe("critical");
    expect(integrity.summary).toContain("not an approval of this code");
  });

  it("flags capability drift against admission, not against the adapter's own manifest", () => {
    const findings = detectAdapterAnomalies(
      observation({ claimedCapabilities: ["durable-queue", "acknowledgement", "artifact-store"] }),
    );
    const drift = findings.find((f) => f.threat === "ADAPTER_CAPABILITY_DRIFT")!;
    expect(drift.summary).toContain("artifact-store");
    expect(drift.summary).toContain("capability nobody granted");
  });

  it("treats a new advisory as investigate-only, not as automatic quarantine", () => {
    const findings = detectAdapterAnomalies(observation({ newAdvisories: ["CVE-2026-1234"] }));
    const advisory = findings.find((f) => f.threat === "SUPPLY_CHAIN_ADVISORY")!;
    expect(advisory.requestedContainment).toBe("INVESTIGATE_ONLY");
    expect(advisory.containmentRationale).toContain("train operators to ignore Sentinel");
  });
});

describe("trace injection is verified independently, not taken on trust", () => {
  it("flags baggage arriving inbound as high severity", () => {
    const findings = detectTraceInjection({
      boundary: "INGRESS",
      contextKeys: ["traceparent", "baggage"],
      sourceInstanceId: "partner",
      observedAt: T0,
      isTest: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.summary).toContain("key-value store the sender controls");
  });

  it("says nothing when only allowlisted keys arrive", () => {
    expect(
      detectTraceInjection({ boundary: "INGRESS", contextKeys: ["traceparent", "tracestate"], sourceInstanceId: "p", observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });

  it("does not police egress — outbound context is ours to set", () => {
    expect(
      detectTraceInjection({ boundary: "EGRESS", contextKeys: ["baggage"], sourceInstanceId: "ksix", observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });
});

describe("retry amplification is a ratio, not a volume", () => {
  it("ignores a busy but healthy route", () => {
    expect(
      detectRetryAmplification({ routeId: "r1", attemptsInWindow: 1_000_000, distinctMessagesInWindow: 999_000, windowSeconds: 60, observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });

  it("flags many attempts across few messages", () => {
    const findings = detectRetryAmplification({
      routeId: "r1",
      attemptsInWindow: 10_000,
      distinctMessagesInWindow: 3,
      windowSeconds: 60,
      observedAt: T0,
      isTest: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.requestedContainment).toBe("SUSPEND_ROUTE");
  });

  it("does not divide by zero when nothing was sent", () => {
    expect(
      detectRetryAmplification({ routeId: "r1", attemptsInWindow: 5, distinctMessagesInWindow: 0, windowSeconds: 60, observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });
});

describe("cross-tenant mapping is critical whatever the intent", () => {
  it("flags private data reaching another tenant", () => {
    const findings = detectCrossTenantMapping({
      mappingContractId: "map-1",
      sourceTenantId: "acme",
      destinationTenantId: "globex",
      classification: "TENANT_PRIVATE",
      observedAt: T0,
      isTest: true,
    });
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.containmentRationale).toContain("cannot be undone");
  });

  it("says nothing when the tenants match", () => {
    expect(
      detectCrossTenantMapping({ mappingContractId: "m", sourceTenantId: "acme", destinationTenantId: "acme", classification: "TENANT_PRIVATE", observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });

  it("says nothing about public data crossing tenants", () => {
    expect(
      detectCrossTenantMapping({ mappingContractId: "m", sourceTenantId: "acme", destinationTenantId: "globex", classification: "PUBLIC", observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });
});

describe("silence where evidence should be is itself a finding", () => {
  it("treats total silence during known failures as critical", () => {
    const findings = detectEvidenceSuppression({
      adapterId: "rogue",
      failuresObserved: 50,
      evidenceReceived: 0,
      windowSeconds: 300,
      observedAt: T0,
      isTest: true,
    });
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.requestedContainment).toBe("QUARANTINE_ADAPTER");
    expect(findings[0]!.summary).toContain("learned it is being watched");
  });

  it("treats partial loss as investigate-only, since a lossy sink is likelier", () => {
    const findings = detectEvidenceSuppression({
      adapterId: "durable-log",
      failuresObserved: 50,
      evidenceReceived: 47,
      windowSeconds: 300,
      observedAt: T0,
      isTest: true,
    });
    expect(findings[0]!.requestedContainment).toBe("INVESTIGATE_ONLY");
    expect(findings[0]!.confidence).toBe("suspected");
  });

  it("says nothing when evidence keeps up with failures", () => {
    expect(
      detectEvidenceSuppression({ adapterId: "a", failuresObserved: 5, evidenceReceived: 5, windowSeconds: 60, observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });

  it("says nothing when there were no failures to report", () => {
    expect(
      detectEvidenceSuppression({ adapterId: "a", failuresObserved: 0, evidenceReceived: 0, windowSeconds: 60, observedAt: T0, isTest: true }),
    ).toHaveLength(0);
  });
});
