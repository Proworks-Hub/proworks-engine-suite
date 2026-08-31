// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  REQUIRED_FOR_PROTECTED_DEPLOYMENT,
  SELF_CHECK_SURFACES,
  blastContainment,
  buildObservation,
  causalChain,
  mapAdvisory,
  preservationOrder,
  reconstruct,
  selfCheck,
  supplyChainGate,
  type ArtifactRecord,
  type ObservationType,
  type SecurityObservation,
  type SelfCheckSurface,
  type SurfaceState,
} from "../index.js";

let seq = 0;
function obs(input: {
  id?: string;
  type: ObservationType;
  at: string;
  subjectRef: string;
  locator?: string;
  causationId?: string;
}): SecurityObservation {
  seq += 1;
  const admission = buildObservation({
    observationId: input.id ?? `obs-${seq}`,
    observedAt: input.at,
    receivedAt: input.at,
    source: { sensorKind: "hive-native", provider: "hive.test", instanceRef: "instance-a" },
    subject: { kind: "identity", ref: input.subjectRef },
    observationType: input.type,
    severity: "moderate",
    confidence: "confirmed",
    dataClassification: "internal",
    privacyScope: "instance-local",
    sourceAttested: false,
    adapterRef: "adapter.test@1.0.0",
    ...(input.locator !== undefined ? { evidenceRefs: [{ holder: "audit-iq" as const, locator: input.locator }] } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
  });
  if (!admission.admitted) throw new Error(admission.detail);
  return admission.observation;
}

describe("§25 forensics — references only, gaps first-class, causality declared", () => {
  const observations = [
    obs({ id: "o1", type: "authentication-failed", at: "2026-08-30T10:00:00Z", subjectRef: "u-1", locator: "audit://1" }),
    obs({ id: "o2", type: "privilege-escalated", at: "2026-08-30T10:05:00Z", subjectRef: "u-1", locator: "audit://2", causationId: "o1" }),
    obs({ id: "o3", type: "unexpected-egress", at: "2026-08-30T10:09:00Z", subjectRef: "u-1", locator: "audit://3", causationId: "o2" }),
  ];
  it("builds a timeline of REFERENCES and names AuditIQ as authoritative", () => {
    const pkg = reconstruct({
      packageId: "pkg-1",
      incidentId: "inc-1",
      windowStart: "2026-08-30T10:00:00Z",
      windowEnd: "2026-08-30T11:00:00Z",
      observations,
      verifications: [
        { locator: "audit://1", verification: "confirmed" },
        { locator: "audit://2", verification: "confirmed" },
        { locator: "audit://3", verification: "confirmed" },
      ],
      gaps: [],
    });
    expect(pkg.authoritativeEvidenceSystem).toBe("audit-iq");
    expect(pkg.timeline.map((t) => t.observationId)).toEqual(["o1", "o2", "o3"]);
    expect(pkg.complete).toBe(true);
    // No evidence content anywhere — only holders and locators.
    expect(JSON.stringify(pkg)).not.toMatch(/payload|body|content/i);
  });
  it("GATE: an unverifiable reference is MARKED, never dropped — forensics does not tidy history", () => {
    const pkg = reconstruct({
      packageId: "pkg-2",
      incidentId: "inc-1",
      windowStart: "a",
      windowEnd: "b",
      observations,
      verifications: [{ locator: "audit://1", verification: "confirmed" }],
      gaps: [],
    });
    expect(pkg.timeline).toHaveLength(3); // nothing dropped
    expect(pkg.unconfirmedCount).toBe(2);
    expect(pkg.complete).toBe(false);
    expect(pkg.statement).toContain("Absence of an event here is not evidence it did not occur");
  });
  it("an integrity mismatch is counted separately from a merely unconfirmed one", () => {
    const pkg = reconstruct({
      packageId: "pkg-3",
      incidentId: "inc-1",
      windowStart: "a",
      windowEnd: "b",
      observations,
      verifications: [
        { locator: "audit://1", verification: "confirmed" },
        { locator: "audit://2", verification: "integrity-mismatch" },
        { locator: "audit://3", verification: "confirmed" },
      ],
      gaps: [],
    });
    expect(pkg.integrityMismatchCount).toBe(1);
    expect(pkg.unconfirmedCount).toBe(0);
    expect(pkg.complete).toBe(false);
  });
  it("GATE: causality is DECLARED — an edge exists only where a causationId says so", () => {
    const noCausation = [
      obs({ id: "a1", type: "authentication-failed", at: "2026-08-30T10:00:00Z", subjectRef: "u-2", locator: "audit://a" }),
      obs({ id: "a2", type: "unexpected-egress", at: "2026-08-30T10:01:00Z", subjectRef: "u-2", locator: "audit://b" }),
    ];
    const pkg = reconstruct({
      packageId: "pkg-4",
      incidentId: "inc-2",
      windowStart: "a",
      windowEnd: "b",
      observations: noCausation,
      verifications: [
        { locator: "audit://a", verification: "confirmed" },
        { locator: "audit://b", verification: "confirmed" },
      ],
      gaps: [],
    });
    // One minute apart on the same subject — and NO causal edge, because
    // nothing declared one.
    expect(pkg.causalEdges).toHaveLength(0);
  });
  it("a cause outside the package is reported as dangling, not silently ignored", () => {
    const orphan = [obs({ id: "x1", type: "unexpected-egress", at: "t", subjectRef: "u-3", locator: "audit://x", causationId: "missing-parent" })];
    const pkg = reconstruct({
      packageId: "pkg-5",
      incidentId: "inc-3",
      windowStart: "a",
      windowEnd: "b",
      observations: orphan,
      verifications: [{ locator: "audit://x", verification: "confirmed" }],
      gaps: [],
    });
    expect(pkg.danglingCauses).toEqual([{ observationId: "x1", missingCauseId: "missing-parent" }]);
    expect(pkg.complete).toBe(false);
  });
  it("declared gaps make a reconstruction incomplete even when everything present verified", () => {
    const pkg = reconstruct({
      packageId: "pkg-6",
      incidentId: "inc-1",
      windowStart: "a",
      windowEnd: "b",
      observations,
      verifications: observations.map((o) => ({ locator: o.evidenceRefs[0]!.locator, verification: "confirmed" as const })),
      gaps: [{ windowStart: "2026-08-30T10:06:00Z", windowEnd: "2026-08-30T10:08:00Z", reason: "runtime sensor restart" }],
    });
    expect(pkg.complete).toBe(false);
    expect(pkg.gaps).toHaveLength(1);
  });
  it("the causal chain walks declared edges and stops where declaration stops", () => {
    const pkg = reconstruct({
      packageId: "pkg-7",
      incidentId: "inc-1",
      windowStart: "a",
      windowEnd: "b",
      observations,
      verifications: observations.map((o) => ({ locator: o.evidenceRefs[0]!.locator, verification: "confirmed" as const })),
      gaps: [],
    });
    expect(causalChain(pkg, "o3")).toEqual(["o1", "o2", "o3"]);
    expect(causalChain(pkg, "o1")).toEqual(["o1"]);
  });
  it("preservation order is volatile-first — what disappears is captured first", () => {
    const mixed = [
      obs({ id: "m1", type: "fabric-route-failed", at: "t1", subjectRef: "r-1" }),
      obs({ id: "m2", type: "governance-decision-refused", at: "t2", subjectRef: "u-4", locator: "audit://m2" }),
    ];
    const withFabric: SecurityObservation[] = [
      { ...mixed[0]!, evidenceRefs: [{ holder: "fabric", locator: "fabric://vol" }] },
      mixed[1]!,
    ];
    const pkg = reconstruct({
      packageId: "pkg-8",
      incidentId: "inc-4",
      windowStart: "a",
      windowEnd: "b",
      observations: withFabric,
      verifications: [],
      gaps: [],
    });
    const order = preservationOrder(pkg);
    expect(order[0]!.holder).toBe("fabric"); // most volatile first
    expect(order[order.length - 1]!.holder).toBe("audit-iq");
  });
});

describe("§27 self-defense — a self-check cannot clear itself", () => {
  const allVerified = Object.fromEntries(
    SELF_CHECK_SURFACES.map((s) => [s, { state: "verified", attestedBy: "security-iq" } as SurfaceState]),
  ) as Record<SelfCheckSurface, SurfaceState>;

  it("all surfaces verified and both chambers operational is healthy", () => {
    const result = selfCheck({ surfaces: allVerified, shieldHealth: "operational", guardHealth: "operational", asOf: "t" });
    expect(result.verdict).toBe("healthy");
    expect(result.requiredResponse).toHaveLength(0);
    expect(result.authorityChange).toBe("none");
  });
  it("GATE: an unattested surface is DEGRADED, never assumed fine — unknown integrity is not integrity", () => {
    const { "binaries": _dropped, ...rest } = allVerified;
    const result = selfCheck({ surfaces: rest, shieldHealth: "operational", guardHealth: "operational", asOf: "t" });
    expect(result.verdict).toBe("degraded");
    expect(result.unattestedSurfaces).toContain("binaries");
    expect(result.requiredResponse.join(" ")).toContain("obtain attestation");
  });
  it("GATE: a mismatch is compromise-suspected and ALWAYS escalates — there is no dismiss path", () => {
    const result = selfCheck({
      surfaces: { ...allVerified, configuration: { state: "mismatch", expected: "abc", observed: "def" } },
      shieldHealth: "operational",
      guardHealth: "operational",
      asOf: "t",
    });
    expect(result.verdict).toBe("compromise-suspected");
    expect(result.mismatchedSurfaces).toEqual(["configuration"]);
    expect(result.requiredResponse.join(" ")).toContain("escalate to Governance and a human operator");
    expect(result.requiredResponse.join(" ")).toContain("preserve forensic evidence before any remediation");
    // A self-check never expands Sentinel's own authority.
    expect(result.authorityChange).toBe("none");
  });
  it("a compromised chamber drives compromise-suspected; an impaired one drives degraded", () => {
    expect(selfCheck({ surfaces: allVerified, shieldHealth: "compromised-suspected", guardHealth: "operational", asOf: "t" }).verdict).toBe(
      "compromise-suspected",
    );
    expect(selfCheck({ surfaces: allVerified, shieldHealth: "impaired", guardHealth: "operational", asOf: "t" }).verdict).toBe("degraded");
  });
  it("GATE: compromise of one chamber cannot touch the other's authority or Sentinel's permissions", () => {
    for (const chamber of ["shield", "guard"] as const) {
      const bounds = blastContainment(chamber);
      expect(bounds.otherChamberAuthorityIntact).toBe(true);
      expect(bounds.cannotAffect).toContain("the other chamber's authority");
      expect(bounds.cannotAffect).toContain("Sentinel's own permissions");
      expect(bounds.cannotAffect).toContain("the last constitutional recovery authority");
      expect(bounds.cannotAffect).toContain("the AuditIQ ledger");
    }
    expect(blastContainment("shield").cannotAffect.join(" ")).toContain("Guard's");
    expect(blastContainment("guard").cannotAffect.join(" ")).toContain("Shield's");
  });
});

describe("§26 supply chain — provenance required, SBOM is evidence not a guarantee", () => {
  const full: ArtifactRecord = {
    artifactRef: "release-9",
    sourceIdentity: "github:Proworks-Hub/proworks-engine-suite",
    repositoryRef: "repo-1",
    sourceRevision: "58d5e84",
    builderIdentity: "foundry-builder",
    buildEnvironmentRef: "env-1",
    digest: "sha256:abc",
    sbomRef: "sbom-1",
    provenanceRef: "prov-1",
    signatureRefs: [
      { role: "build", ref: "sig-1" },
      { role: "release", ref: "sig-2" },
    ],
    testEvidenceRef: "tests-1",
    approvalRef: "approval-1",
  };
  it("a complete artifact clears, and deployment authority is NOT Sentinel", () => {
    const verdict = supplyChainGate(full, 2);
    expect(verdict.cleared).toBe(true);
    if (!verdict.cleared) return;
    expect(verdict.distinctSigningRoles).toEqual(["build", "release"]);
    expect(verdict.deploymentAuthority).toBe("not-sentinel");
  });
  it("GATE: one signing role cannot satisfy a two-role threshold", () => {
    const oneRole = supplyChainGate({ ...full, signatureRefs: [{ role: "build", ref: "a" }, { role: "build", ref: "b" }] }, 2);
    expect(oneRole.cleared).toBe(false);
    if (oneRole.cleared) return;
    expect(oneRole.reasons.join(" ")).toContain("compromise of one role must not replace trusted software");
  });
  it("missing provenance or attribution is named field by field", () => {
    const verdict = supplyChainGate({ ...full, provenanceRef: null, approvalRef: null }, 2);
    expect(verdict.cleared).toBe(false);
    if (verdict.cleared) return;
    expect(verdict.missing).toContain("provenanceRef");
    expect(verdict.missing).toContain("approvalRef");
  });
  it("an SBOM is EVIDENCE, not a requirement — absent it is recorded, not blocking", () => {
    expect(REQUIRED_FOR_PROTECTED_DEPLOYMENT).not.toContain("sbomRef");
    const verdict = supplyChainGate({ ...full, sbomRef: null }, 2);
    // Still clears on provenance, with the absence recorded rather than
    // treated as proof of safety either way.
    expect(verdict.cleared).toBe(true);
  });
  it("advisories map to affected artifacts and are REPORT-ONLY — never auto-installed", () => {
    const match = mapAdvisory("CVE-2026-0001", "lib-x", [
      { artifactRef: "a1", components: ["lib-x", "lib-y"] },
      { artifactRef: "a2", components: ["lib-z"] },
    ]);
    expect(match.affectedArtifactRefs).toEqual(["a1"]);
    expect(match.action).toBe("report-only");
    expect(match.autoInstalled).toBe(false);
  });
});

// ─── guards ─────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("guards — forensics and self-defense", () => {
  const dir = join(process.cwd(), "packages", "sentineliq", "src", "v2");
  const files = ["forensics.ts", "selfDefense.ts"].map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  it("no clock reads and no storage — forensics holds no ledger", () => {
    for (const f of files) {
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)/.test(f.text), f.name).toBe(false);
    }
    const forensics = files.find((f) => f.name === "forensics.ts")!;
    // No parallel AuditIQ: no write/append/store surface anywhere.
    expect(/function (append|store|persist|writeLedger)/.test(forensics.text)).toBe(false);
  });
  it("no suppression path exists in self-defense", () => {
    const self = files.find((f) => f.name === "selfDefense.ts")!;
    expect(/suppress|dismiss|ignoreFinding|acknowledgeAndClear/.test(self.text)).toBe(false);
  });
  it("a self-check result cannot carry an authority change", () => {
    const self = files.find((f) => f.name === "selfDefense.ts")!;
    expect(/authorityChange: "none"/.test(self.text)).toBe(true);
    expect(/authorityChange: "(granted|expanded)"/.test(self.text)).toBe(false);
  });
});
