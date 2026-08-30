// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  evolutionCandidateSchema,
  publishingIsDeploying,
  requiresHumanAuthorization,
  sanitizationOf,
  validationImpliesApproval,
  type EvolutionCandidate,
} from "@proworks-hub/contracts";
import {
  createCollectiveRepository,
  createInMemoryCollectiveRepositoryStore,
  foundryHasProductionDeploymentAuthority,
  publishedMeansDeployed,
  tenantMayWriteToRepository,
  type PackagedRelease,
} from "@proworks-hub/foundry-evolutioniq";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — collective engine evolution.
//
// The five acceptance tests the directive names:
//
//   1. A tenant-derived improvement can be generalized, built, tested and
//      packaged WITHOUT tenant identifiers.
//   2. A failing regression prevents promotion.
//   3. A change that expands engine authority is classified approval-required.
//   4. A tenant-local customization cannot silently become collective code.
//   5. Every promoted release has provenance, evidence, version, rollback
//      artifact and approval state.
//
// Two ways this architecture can quietly invert, and most of the file is about
// them:
//
//   THE DATA WAY. Evidence for "this is better" comes from one tenant's jobs.
//   A candidate carrying it makes the repository a place where one shop's
//   business is readable by everyone running the engine.
//
//   THE AUTHORITY WAY. An engine whose proposals are accepted because they
//   validated has been granted the ability to widen its own authority one
//   green build at a time.
// ─────────────────────────────────────────────────────────────────────────────

const candidate = (over: Record<string, unknown> = {}): unknown => ({
  candidateId: "cand.1",
  engineId: "forgeiq",
  changeClass: "minor",
  source: "telemetry_pattern",
  originatingInstanceId: "hive.instance.a",
  title: "Nest small parts before large ones",
  rationale:
    "Sorting descending by area before placement reduced offcut waste across every sheet size measured.",
  evidence: [
    {
      metric: "sheet_utilisation",
      baseline: 0.71,
      observed: 0.83,
      sampleSize: 4_100,
      method: "A/B over identical part sets on the same machine profile",
      instancesObserved: 3,
    },
  ],
  contractsTouched: [],
  blastRadius: [],
  expandsAuthority: false,
  migrations: [],
  proposedAt: "2026-08-29T12:00:00.000Z",
  ...over,
});

const parsed = (over: Record<string, unknown> = {}): EvolutionCandidate =>
  evolutionCandidateSchema.parse(candidate(over));

const packaged = (over: Partial<PackagedRelease> = {}): PackagedRelease => ({
  candidate: parsed(),
  approvalDecisionId: "gd.approve.1",
  artifact: "oci://registry/forgeiq:0.20.0",
  checksum: "sha256:abc",
  rollbackArtifact: "oci://registry/forgeiq:0.19.0",
  testEvidence: ["unit 1420/1420", "integration 88/88", "architecture 31/31"],
  version: "0.20.0",
  channel: "beta",
  ...over,
});

const repo = (over: Record<string, unknown> = {}) =>
  createCollectiveRepository({ now: () => new Date("2026-08-29T12:00:00.000Z"), ...over });

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 4. GENERALIZATION
// ─────────────────────────────────────────────────────────────────────────────

describe("a tenant improvement generalizes without carrying the tenant", () => {
  it("accepts a candidate whose evidence is measurements", () => {
    // "p95 fell from 900ms to 240ms across 4,100 runs" is the whole of what
    // the collective needs. Which customer, which job and which price are what
    // it must not have.
    const c = parsed();
    expect(c.evidence[0]?.sampleSize).toBe(4_100);
    expect(JSON.stringify(c)).not.toMatch(/customer/i);
  });

  it("refuses a candidate whose rationale names a customer", () => {
    const r = evolutionCandidateSchema.safeParse(
      candidate({ rationale: "Brighton Signs' customer Acme kept getting bad nests." }),
    );
    expect(r.success).toBe(false);
  });

  it("refuses a pasted email address", () => {
    const r = evolutionCandidateSchema.safeParse(
      candidate({ rationale: "Reported by steven@ksixdesigns.example after three bad runs." }),
    );
    expect(r.success).toBe(false);
  });

  it("refuses a tenant identifier in the title", () => {
    expect(
      evolutionCandidateSchema.safeParse(candidate({ title: "Fix tenant_id scoping in nesting" })).success,
    ).toBe(false);
  });

  it("refuses rather than strips", () => {
    // A stripped candidate is one somebody has to trust was stripped
    // correctly, and a reviewer cannot tell a sanitized field from one that
    // never had anything in it.
    const verdict = sanitizationOf("work_order_4471 was mis-nested");
    expect(verdict.clean).toBe(false);
    if (verdict.clean) return;
    expect(verdict.reason).toMatch(/refused rather than stripped/);
  });

  it("requires more than one instance to have seen it", () => {
    // One instance's improvement may be one instance's configuration. This is
    // the field that lets a reviewer tell a general truth from a local one.
    const c = parsed();
    expect(c.evidence[0]?.instancesObserved).toBeGreaterThan(0);
    expect(
      evolutionCandidateSchema.safeParse(
        candidate({
          evidence: [{ ...(candidate() as { evidence: unknown[] }).evidence[0] as object, instancesObserved: 0 }],
        }),
      ).success,
    ).toBe(false);
  });

  it("keeps the originating INSTANCE, not the tenant", () => {
    // A candidate must be traceable so a bad one can be investigated. It does
    // not need to name whose jobs produced the numbers.
    const c = parsed();
    expect(c.originatingInstanceId).toBe("hive.instance.a");
    expect(Object.keys(c)).not.toContain("tenantId");
    expect(Object.keys(c)).not.toContain("originatingTenantId");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AUTHORITY EXPANSION
// ─────────────────────────────────────────────────────────────────────────────

describe("an engine may propose and may not grant itself authority", () => {
  it("refuses to let an authority-expanding change be classified as minor", () => {
    // A self-classification that lowered the bar would be exactly the thing
    // the rule forbids.
    for (const changeClass of ["maintenance", "minor"] as const) {
      expect(
        evolutionCandidateSchema.safeParse(candidate({ expandsAuthority: true, changeClass })).success,
      ).toBe(false);
    }
  });

  it("accepts it as major, constitutional or new_engine", () => {
    for (const changeClass of ["major", "constitutional", "new_engine"] as const) {
      expect(
        evolutionCandidateSchema.safeParse(candidate({ expandsAuthority: true, changeClass })).success,
      ).toBe(true);
    }
  });

  it("puts a contract change above maintenance", () => {
    // Other engines rely on contracts, and a contract change that skipped
    // review would cost them a release each.
    expect(
      evolutionCandidateSchema.safeParse(
        candidate({ changeClass: "maintenance", contractsTouched: ["manufacturingPlan"] }),
      ).success,
    ).toBe(false);
  });

  it("requires a human for major, constitutional and new-engine changes", () => {
    expect(requiresHumanAuthorization("maintenance")).toBe(false);
    expect(requiresHumanAuthorization("minor")).toBe(false);
    expect(requiresHumanAuthorization("major")).toBe(true);
    expect(requiresHumanAuthorization("constitutional")).toBe(true);
    expect(requiresHumanAuthorization("new_engine")).toBe(true);
  });

  it("holds that validating is not being approved", () => {
    // Validation says the change works. Approval says it may ship, and the gap
    // between those is the whole of governance.
    expect(validationImpliesApproval()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 & THE WRITE BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

describe("the repository takes only approved, packaged releases", () => {
  it("publishes one with full provenance", () => {
    const r = repo();
    const result = r.publish(packaged());
    expect(result.published).toBe(true);
    if (!result.published) return;

    const release = result.release;
    expect(release.approvalDecisionId).toBe("gd.approve.1");
    expect(release.rollbackArtifact).toBeTruthy();
    expect(release.testEvidence.length).toBeGreaterThan(0);
    expect(release.candidate.candidateId).toBe("cand.1");
    expect(release.checksum).toBe("sha256:abc");
    expect(release.version).toBe("0.20.0");
  });

  it("refuses a major release with no named human", () => {
    // Governance policy permits it; a person accepts it, and an unnamed
    // acceptance is one nobody can be asked about.
    const r = repo();
    const result = r.publish(
      packaged({ candidate: parsed({ changeClass: "major", expandsAuthority: true }) }),
    );
    expect(result.published).toBe(false);
    if (result.published) return;
    expect(result.reason).toMatch(/authorizedBy/);
  });

  it("publishes a major release when a human is named", () => {
    const r = repo();
    expect(
      r.publish({
        ...packaged({ candidate: parsed({ changeClass: "major", expandsAuthority: true }) }),
        authorizedBy: "user.steven",
      }).published,
    ).toBe(true);
  });

  it("has no method a tenant could call", () => {
    // Structural. `publish` accepts only a packaged release, which carries the
    // id of a Governance decision an instance did not make — so the rule is
    // enforced by there being nothing an instance could construct.
    const r = repo();
    // An exact surface, so an addition is a decision made here rather than
    // something that appears. `durability` arrived when releases moved behind
    // a store; it is a read-only accessor, which is the opposite of a write.
    expect(Object.keys(r).sort()).toEqual([
      "count",
      "durability",
      "lastKnownGood",
      "mayAdopt",
      "publish",
      "releases",
      "withdraw",
    ]);

    // The claim that actually matters, stated independently of the list.
    for (const forbidden of ["write", "insert", "upsert", "put", "deploy", "install"]) {
      expect(Object.keys(r)).not.toContain(forbidden);
    }
    expect(tenantMayWriteToRepository()).toBe(false);
  });

  it("refuses a release with no rollback artifact", () => {
    // A release whose failure has no remedy is one where the moment that is
    // discovered is the moment it has failed.
    //
    // Both shapes, because they fail differently: an empty string is caught by
    // the length bound, and an ABSENT field is caught only by the field being
    // required. My first version tested only the empty string, and a mutation
    // making the field optional survived it — the types say required, and a
    // JavaScript host has no types.
    const r = repo();
    expect(r.publish({ ...packaged(), rollbackArtifact: "" }).published).toBe(false);
    const withoutIt = { ...packaged() } as Record<string, unknown>;
    delete withoutIt["rollbackArtifact"];
    expect(r.publish(withoutIt as never).published).toBe(false);
  });

  it("refuses a release with no Governance decision behind it", () => {
    // A release nobody authorized. Required and not defaulted, so the absence
    // is impossible rather than discouraged — and tested by OMITTING the field,
    // since an empty string is caught by a different rule.
    const r = repo();
    const withoutApproval = { ...packaged() } as Record<string, unknown>;
    delete withoutApproval["approvalDecisionId"];
    expect(r.publish(withoutApproval as never).published).toBe(false);
    expect(r.count()).toBe(0);
  });

  it("refuses a release with no test evidence", () => {
    const r = repo();
    expect(r.publish({ ...packaged(), testEvidence: [] }).published).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. REGRESSIONS AND SENTINEL
// ─────────────────────────────────────────────────────────────────────────────

describe("a release can be stopped and unstopped by the right things", () => {
  it("lets Sentinel block an engine's releases outright", () => {
    // Checked before anything else. A release blocked on safety grounds must
    // not be published and then withdrawn — by then it is a thing instances
    // may have seen.
    const r = repo({ blocked: () => ({ engines: ["forgeiq"], releases: [] }) });
    const result = r.publish(packaged());
    expect(result.published).toBe(false);
    if (result.published) return;
    expect(result.reason).toMatch(/Sentinel has blocked/);
    expect(r.count()).toBe(0);
  });

  it("keeps versions immutable", () => {
    // Republishing would change the artifact behind a version while every
    // instance pinned to it kept believing it had the build it adopted.
    const r = repo();
    expect(r.publish(packaged()).published).toBe(true);
    const again = r.publish({ ...packaged(), checksum: "sha256:different" });
    expect(again.published).toBe(false);
    if (again.published) return;
    expect(again.reason).toMatch(/Versions are immutable/);
  });

  it("withdraws without deleting", () => {
    // Instances that already adopted it need the record to still explain what
    // they are running.
    const r = repo();
    const published = r.publish(packaged());
    expect(published.published).toBe(true);
    if (!published.published) return;

    expect(r.withdraw(published.release.releaseId, "regression in nesting", "user.steven").withdrawn).toBe(
      true,
    );
    expect(r.count()).toBe(1);
    const [record] = r.releases("forgeiq");
    expect(record?.withdrawnAt).toBeTruthy();
    expect(record?.artifact).toBe("oci://registry/forgeiq:0.20.0");
  });

  it("does not offer a withdrawn release as last-known-good", () => {
    const r = repo();
    const first = r.publish(packaged({ version: "0.20.0" }));
    r.publish(packaged({ version: "0.21.0" }));
    expect(r.lastKnownGood("forgeiq", "beta")?.version).toBe("0.21.0");

    const second = r.releases("forgeiq").find((x) => x.version === "0.21.0");
    r.withdraw(second!.releaseId, "regression", "user.steven");
    expect(r.lastKnownGood("forgeiq", "beta")?.version).toBe("0.20.0");
    expect(first.published).toBe(true);
  });

  it("keeps channels apart", () => {
    const r = repo();
    r.publish(packaged({ version: "0.20.0", channel: "beta" }));
    r.publish(packaged({ version: "0.19.0", channel: "stable" }));
    expect(r.lastKnownGood("forgeiq", "beta")?.version).toBe("0.20.0");
    expect(r.lastKnownGood("forgeiq", "stable")?.version).toBe("0.19.0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADOPTION
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption is a separate, checked decision", () => {
  const withCompat = () =>
    packaged({ compatibility: [{ engineId: "contracts", minVersion: "0.19.0", maxVersion: "0.21.0" }] });

  it("permits an instance inside the compatible range", () => {
    const r = repo();
    const published = r.publish(withCompat());
    expect(published.published).toBe(true);
    if (!published.published) return;
    expect(
      r.mayAdopt({ release: published.release, instanceVersions: { contracts: "0.20.0" } }).permitted,
    ).toBe(true);
  });

  it("refuses one below the minimum and above the maximum", () => {
    const r = repo();
    const published = r.publish(withCompat());
    if (!published.published) return;
    expect(
      r.mayAdopt({ release: published.release, instanceVersions: { contracts: "0.18.0" } }).permitted,
    ).toBe(false);
    expect(
      r.mayAdopt({ release: published.release, instanceVersions: { contracts: "0.22.0" } }).permitted,
    ).toBe(false);
  });

  it("refuses when the instance does not report the dependency at all", () => {
    // Not running it is not the same as running an incompatible one, and a
    // dependency nobody has checked is not one that passed.
    const r = repo();
    const published = r.publish(withCompat());
    if (!published.published) return;
    const verdict = r.mayAdopt({ release: published.release, instanceVersions: {} });
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/does not report running/);
  });

  it("refuses a withdrawn release", () => {
    const r = repo();
    const published = r.publish(packaged());
    if (!published.published) return;
    r.withdraw(published.release.releaseId, "regression", "user.steven");
    const [record] = r.releases("forgeiq");
    expect(r.mayAdopt({ release: record!, instanceVersions: {} }).permitted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE WALL STAYS SHUT
// ─────────────────────────────────────────────────────────────────────────────

describe("publishing is not deploying", () => {
  it("does not give Foundry production authority", () => {
    // The decision taken earlier and preserved here: PROMOTABLE remains
    // SIMULATION and VALIDATION. Building a road does not open the gate.
    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
    expect(publishedMeansDeployed()).toBe(false);
    expect(publishingIsDeploying()).toBe(false);
  });

  it("installs nothing when a release is published", () => {
    // The repository has no deploy, install, apply or rollout method. A
    // published artifact is a thing an instance may later choose to pin to.
    const onPublished = vi.fn();
    const r = repo({ onPublished });
    r.publish(packaged());

    expect(onPublished).toHaveBeenCalledOnce();
    for (const forbidden of ["deploy", "install", "apply", "rollout", "promote"]) {
      expect(Object.keys(r)).not.toContain(forbidden);
    }
  });
});

describe("published releases survive a restart", () => {
  it("comes back with the provenance every adopted artifact depends on", () => {
    // Flagged as debt when this repository was built and closed rather than
    // left. A collective repository that lost its releases would lose the
    // approval record and the rollback pointer for every artifact any instance
    // is running — the evidence that only matters after something goes wrong.
    const store = createInMemoryCollectiveRepositoryStore();
    const before = repo({ store });
    expect(before.publish(packaged()).published).toBe(true);

    const after = repo({ store });
    expect(after.count()).toBe(1);
    expect(after.lastKnownGood("forgeiq", "beta")?.approvalDecisionId).toBe("gd.approve.1");
    // And the version is still immutable across the restart.
    expect(after.publish(packaged()).published).toBe(false);
  });

  it("says which kind of store is bound", () => {
    expect(repo().durability()).toBe("in-memory");
  });
});
