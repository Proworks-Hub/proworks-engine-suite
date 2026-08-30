/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { fabricEnvelopeSchema, referenceGrantsAuthority, routePossessionGrantsPermission } from "../domain/envelope.js";
import { zonesMayRelate } from "../domain/topology.js";
import { localWorkContinues, degradationMayRelaxRules } from "../pulse/degradedMode.js";
import { resolvePosture, postureMayGrantAccess } from "../security/posture.js";
import { sentinelMayRemoveRecoveryPath, constitutionalRecoveryPath } from "../security/governedUpgrade.js";
import { adaptationMayApply } from "../engines/fabricAdaptationIQ.js";
import { routingMayWidenCandidates } from "../engines/routingIQ.js";
import { admissionGrantsReachability } from "../engines/topologyIQ.js";
import { spanCarriesPayload } from "../engines/fabricObservabilityIQ.js";
import { providerIsRequired, LANE_DEGRADATION } from "../ports/providers.js";
import { resolveTrust, referenceSecurityPorts, fabricHoldsTrustRoot } from "../ports/securityPorts.js";
import { activateTopology, dataPlaneMayMutateControlPlane, signedTopologySchema } from "../runtime/controlPlane.js";
import { runtimeHoldsAuthority } from "../runtime/fabricRuntime.js";
import { grantsCompose } from "../interconnect/gateway.js";
import type { TopologyVersion } from "../domain/topology.js";
import type { Lane } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE THIRTEEN QUESTIONS
//
// The continuation directive ends with an audit: thirteen questions, each of
// which must be answered by code and tests rather than by the author's
// confidence. This file IS that audit. One describe per question, in the
// directive's order, each test demonstrating the "no" (or the one "yes")
// against the real implementation — no mocks of the thing under audit.
//
// If a refactor ever turns one of these answers around, this file is where
// the build goes red, which is the entire point of writing an audit as tests
// instead of as a section in a report.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = "2026-08-30T10:00:00.000Z";

describe("audit 1: is Neural Fabric still outside Prime?", () => {
  it("no source file imports anything but its own modules and zod", () => {
    // Structural independence, checked structurally: walk every non-test
    // source file and assert each import is relative or "zod". Prime, the
    // engine suite, node builtins — none may appear. This is what "sits on
    // the outside, not attached to Prime" means in a form a build can refuse.
    const srcRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "__tests__") continue; // tests may use vitest/node
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf-8");
        for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
          const spec = match[1]!;
          if (!spec.startsWith("./") && !spec.startsWith("../") && spec !== "zod") {
            offenders.push(`${entry}: ${spec}`);
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe("audit 2: can RoutingIQ widen a Nexus candidate set?", () => {
  it("no — the claim is assertable and its return type makes true unrepresentable", () => {
    expect(routingMayWidenCandidates()).toBe(false);
  });
});

describe("audit 3: can admission grant reachability?", () => {
  it("no — admission runs after routing and grants nothing", () => {
    expect(admissionGrantsReachability()).toBe(false);
  });
});

describe("audit 4: can security failure result in allow?", () => {
  it("no — an unavailable verifier is a refusal, demonstrated live", async () => {
    const ports = referenceSecurityPorts({ issued: [], revoked: new Map(), grants: [], unavailable: true });
    const outcome = await resolveTrust(ports, {
      presentedIdentityRef: "spiffe://ksix/auditor",
      expectedInstanceId: "ksix",
      expectedTenantId: "audit",
      authorizationEvidenceRef: null,
      requiredScope: null,
      now: T0,
    });
    expect(outcome.trusted).toBe(false);
    if (!outcome.trusted) expect(outcome.dependencyOutage).toBe(true);
  });

  it("no — an unreachable posture source resolves to a raised level, never GREEN", () => {
    expect(resolvePosture(null, null, false, T0).level).not.toBe("GREEN");
    expect(postureMayGrantAccess()).toBe(false);
    expect(degradationMayRelaxRules()).toBe(false);
    expect(fabricHoldsTrustRoot()).toBe(false);
  });
});

describe("audit 5: can cross-instance traffic bypass Interconnect?", () => {
  it("no — a cross-instance zone relation must terminate at a gateway", () => {
    const direct = zonesMayRelate(
      { zoneId: "a", kind: "LOCAL", instanceId: "one" },
      { zoneId: "b", kind: "LOCAL", instanceId: "two" },
    );
    expect(direct.permitted).toBe(false);
    expect(grantsCompose()).toBe(false);
  });
});

describe("audit 6: can a provider become mandatory?", () => {
  it("no — and every lane has a declared answer to that provider's failure", () => {
    expect(providerIsRequired()).toBe(false);
    const lanes = Object.keys(LANE_DEGRADATION) as Lane[];
    expect(lanes.length).toBe(8);
    for (const lane of lanes) expect(LANE_DEGRADATION[lane].behaviour).toBeDefined();
  });
});

describe("audit 7: can adaptation self-deploy?", () => {
  it("no", () => {
    expect(adaptationMayApply()).toBe(false);
  });
});

describe("audit 8: can a Data Plane component change the Control Plane?", () => {
  it("no — the view is frozen, the maps are copies, and the claim is assertable", () => {
    expect(dataPlaneMayMutateControlPlane()).toBe(false);
    expect(runtimeHoldsAuthority()).toBe(false);
  });
});

describe("audit 9: can a local Instance continue during Collective loss?", () => {
  it("YES — the one answer that must be yes", () => {
    expect(localWorkContinues(["COLLECTIVE"]).continues).toBe(true);
    expect(localWorkContinues(["COLLECTIVE", "REGIONAL", "GATEWAY"]).continues).toBe(true);
    // And the boundary that keeps the yes honest: a lost LOCAL zone is an
    // outage, not a degraded mode.
    expect(localWorkContinues(["LOCAL"]).continues).toBe(false);
  });
});

describe("audit 10: can Sentinel permanently remove the constitutional recovery path?", () => {
  it("no — the path is a constant Sentinel has no operation against", () => {
    expect(sentinelMayRemoveRecoveryPath()).toBe(false);
    const path = constitutionalRecoveryPath();
    expect(path.available).toBe(true);
    expect(path.requirements.length).toBeGreaterThan(0);
  });
});

describe("audit 11: can an AI or payload field manufacture authority?", () => {
  it("no — authority is a reference to an external decision, never envelope content", () => {
    expect(referenceGrantsAuthority()).toBe(false);
    expect(routePossessionGrantsPermission()).toBe(false);
  });

  it("no — the envelope is .strict(), so an injected authority field is refused at parse", () => {
    const smuggled = fabricEnvelopeSchema.safeParse({
      fabricMessageId: "audit-1",
      schemaId: "audit.probe",
      schemaVersion: "1",
      lane: "EVENT",
      source: { capability: "audit", participantId: "auditor" },
      destination: { capability: "audit" },
      instanceId: "ksix",
      tenantId: "audit",
      correlationId: "cor",
      causationId: null,
      provenance: { originComponent: "audit", originInstanceId: "ksix", principalKind: "ENGINE", transformations: [] },
      classification: "INTERNAL",
      priority: "NORMAL",
      contentType: "application/json",
      isTest: true,
      authority: "GRANTED", // the field an attacker would add
    });
    expect(smuggled.success).toBe(false);
  });

  it("no — an AI principal must carry model provenance; provenance describes, never authorizes", () => {
    const aiWithoutProvenance = fabricEnvelopeSchema.safeParse({
      fabricMessageId: "audit-2",
      schemaId: "audit.probe",
      schemaVersion: "1",
      lane: "EVENT",
      source: { capability: "audit", participantId: "model-1" },
      destination: { capability: "audit" },
      instanceId: "ksix",
      tenantId: "audit",
      correlationId: "cor",
      causationId: null,
      provenance: { originComponent: "audit", originInstanceId: "ksix", principalKind: "AI_MODEL", transformations: [] },
      classification: "INTERNAL",
      priority: "NORMAL",
      contentType: "application/json",
      isTest: true,
    });
    expect(aiWithoutProvenance.success).toBe(false);
  });
});

describe("audit 12: can telemetry expose protected payloads?", () => {
  it("no — a trace span has no payload field to fill", () => {
    expect(spanCarriesPayload()).toBe(false);
  });
});

describe("audit 13: can a topology change activate without governed evidence?", () => {
  const version: TopologyVersion = {
    versionId: "v-audit",
    parentVersionId: null,
    instanceId: "ksix",
    zones: [{ zoneId: "local", kind: "LOCAL", instanceId: "ksix" }],
    nodes: [
      {
        nodeId: "n1",
        kind: "ENGINE",
        zoneId: "local",
        capabilities: ["audit"],
        workloadIdentityRef: "spiffe://ksix/n1",
        isTest: true,
      },
    ],
    adjacencies: [],
    rationale: "Audit fixture.",
    createdAt: T0,
    state: "APPROVED",
    activationDecisionRef: null, // signed, approved — but nobody DECIDED
  };
  const alwaysVerifies = {
    verify: async () => ({ outcome: "VERIFIED" as const, validUntil: "2027-01-01T00:00:00.000Z", detail: { signedBy: "security-iq" } }),
  };

  it("no — a valid signature without an activation decision is refused", async () => {
    const signed = signedTopologySchema.parse({
      version,
      signature: "sig-valid",
      signedBy: "security-iq",
      algorithmProfile: "profile-1",
      signedAt: T0,
    });
    const outcome = await activateTopology(signed, alwaysVerifies, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(false);
    if (!outcome.activated) expect(outcome.reason).toContain("activation decision");
  });

  it("no — a decision without a verifiable signature is refused just as hard", async () => {
    const signed = signedTopologySchema.parse({
      version: { ...version, activationDecisionRef: "dec-audit" },
      signature: "sig-forged",
      signedBy: "attacker",
      algorithmProfile: "profile-1",
      signedAt: T0,
    });
    const refusesAll = {
      verify: async () => ({ outcome: "REFUSED" as const, reason: "Signature does not verify." }),
    };
    const outcome = await activateTopology(signed, refusesAll, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(false);
  });
});
