// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  SCOPE_PRECEDENCE,
  distributionScopeSchema,
  isCollectiveScope,
  knowledgeObjectSchema,
  ownershipOf,
  sameCodeMeansSharedData,
  scopeVisibleTo,
  tenantKnowledgePromotesByCopy,
} from "@proworks-hub/contracts";
import {
  createInMemoryFederationStore,
  createInstanceRegistry,
  createKnowledgeRegistry,
  instanceMayPatchAnother,
  revocationDeletes,
} from "@proworks-hub/platform-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 11 — the federated instance and knowledge architecture.
//
// The directive's minimum acceptance tests, and the invariant they all defend:
// SAME CODE DOES NOT MEAN SHARED DATA. Promotion is transformation plus
// authorization, never replication.
//
//   Tenant A's knowledge cannot be reached by Tenant B.
//   A global update reaches two instances without transferring either's data.
//   A domain bundle is rejected outside its domain.
//   A promotion carrying PII markers is blocked before publication.
//   A bad bundle can be revoked and stops being used.
//   Pinned instances do not silently upgrade.
//   Lookup respects USER_OR_ROLE → TENANT → DOMAIN → GLOBAL.
//
// The precedence deserves its own note. It is a SEARCH ORDER, not a
// permission: the resolver filters by what the requester HAS before it orders
// by specificity, because ordering first and filtering second is the same code
// with a leak in it.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = () => new Date("2026-08-29T12:00:00.000Z");

const object = (over: Record<string, unknown> = {}) => ({
  knowledgeId: "k.kerf",
  scope: "GLOBAL",
  sourceInstanceId: "hive.instance.a",
  semanticVersion: "1.0.0",
  schemaVersion: "1",
  contentType: "forgeiq:nesting-rule",
  piiStatus: "none_detected",
  restrictedDataFlags: [],
  validationStatus: "validated",
  governanceApprovalRef: "gd.approve.k1",
  sentinelVerificationRef: "sf.verify.k1",
  promotionParentIds: [],
  checksum: "sha256:kkk",
  createdAt: "2026-08-01T00:00:00.000Z",
  approvedAt: "2026-08-20T00:00:00.000Z",
  ...over,
});

const instance = (over: Record<string, unknown> = {}) => ({
  globalInstanceId: "hive.instance.a",
  tenantIds: ["ksix"],
  domainIds: [],
  engineVersions: { forgeiq: "0.20.0" },
  channel: "stable",
  pinnedVersions: {},
  adoptedBundleIds: [],
  registeredAt: "2026-08-29T12:00:00.000Z",
  ...over,
});

const registry = () => createKnowledgeRegistry({ now: NOW });

const publishGlobal = (r: ReturnType<typeof registry>, over: Record<string, unknown> = {}) =>
  r.publish({
    bundleId: "bundle.1",
    scope: "GLOBAL",
    objects: [object()],
    version: "1.0.0",
    signatureRef: "sig:abc",
    ...over,
  });

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO VOCABULARIES
// ─────────────────────────────────────────────────────────────────────────────

describe("distribution scope and ownership never disagree", () => {
  it("maps every distribution scope to an ownership class", () => {
    // Total, walked over the enum. Two vocabularies for adjacent ideas is the
    // drift this codebase refuses elsewhere; adding a scope without deciding
    // what it owns should not be possible.
    for (const scope of distributionScopeSchema.options) {
      expect(["canonical", "host-private", "tenant-private"]).toContain(ownershipOf(scope));
    }
  });

  it("keeps user and tenant knowledge tenant-private", () => {
    expect(ownershipOf("USER_OR_ROLE")).toBe("tenant-private");
    expect(ownershipOf("TENANT")).toBe("tenant-private");
  });

  it("treats domain knowledge as canonical with an eligibility rule", () => {
    // Not a fourth ownership class. It belongs to nobody in particular and is
    // shared among instances that qualify.
    expect(ownershipOf("DOMAIN")).toBe("canonical");
    expect(ownershipOf("GLOBAL")).toBe("canonical");
  });

  it("names only DOMAIN and GLOBAL as collective", () => {
    expect(isCollectiveScope("GLOBAL")).toBe(true);
    expect(isCollectiveScope("DOMAIN")).toBe(true);
    for (const scope of ["TENANT", "USER_OR_ROLE", "EPHEMERAL"] as const) {
      expect(isCollectiveScope(scope)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRECEDENCE AND VISIBILITY
// ─────────────────────────────────────────────────────────────────────────────

describe("lookup goes narrowest first, and only where authority reaches", () => {
  it("orders most specific to least", () => {
    expect(SCOPE_PRECEDENCE).toEqual(["USER_OR_ROLE", "TENANT", "DOMAIN", "GLOBAL"]);
  });

  it("does not let a caller reach DOMAIN by naming a domain it lacks", () => {
    // `scopeVisibleTo` takes what the requester HAS, not what they asked for.
    expect(scopeVisibleTo("DOMAIN", { tenantId: "ksix" })).toBe(false);
    expect(scopeVisibleTo("DOMAIN", { tenantId: "ksix", domainId: "manufacturing" })).toBe(true);
  });

  it("makes GLOBAL visible to everyone and EPHEMERAL to nobody", () => {
    // Ephemeral is runtime context. Serving it from a registry would be
    // persisting the thing defined by not being persisted.
    expect(scopeVisibleTo("GLOBAL", {})).toBe(true);
    expect(scopeVisibleTo("EPHEMERAL", { tenantId: "ksix", domainId: "d", actorId: "u" })).toBe(false);
  });

  it("returns the narrowest answer a requester can see", () => {
    const r = registry();
    publishGlobal(r);
    r.publish({
      bundleId: "bundle.dom",
      scope: "DOMAIN",
      domainId: "manufacturing",
      objects: [object({ scope: "DOMAIN", domainId: "manufacturing", semanticVersion: "2.0.0" })],
      version: "1.0.0",
      signatureRef: "sig:dom",
    });

    const domainCaller = r.resolve({
      knowledgeId: "k.kerf",
      requester: { tenantId: "ksix", domainId: "manufacturing" },
    });
    expect(domainCaller.found).toBe(true);
    if (!domainCaller.found) return;
    expect(domainCaller.scope).toBe("DOMAIN");
    expect(domainCaller.object.semanticVersion).toBe("2.0.0");

    // The same query from an instance with no domain falls through to global.
    const generalCaller = r.resolve({ knowledgeId: "k.kerf", requester: { tenantId: "brighton" } });
    expect(generalCaller.found).toBe(true);
    if (!generalCaller.found) return;
    expect(generalCaller.scope).toBe("GLOBAL");
    expect(generalCaller.object.semanticVersion).toBe("1.0.0");
  });

  it("finds nothing when authority reaches no scope holding it", () => {
    const r = registry();
    r.publish({
      bundleId: "bundle.dom",
      scope: "DOMAIN",
      domainId: "healthcare",
      objects: [object({ scope: "DOMAIN", domainId: "healthcare", knowledgeId: "k.phi.rule" })],
      version: "1.0.0",
      signatureRef: "sig:h",
    });
    const outsider = r.resolve({ knowledgeId: "k.phi.rule", requester: { tenantId: "ksix" } });
    expect(outsider.found).toBe(false);
  });

  it("does not serve one domain's knowledge to another domain", () => {
    const r = registry();
    r.publish({
      bundleId: "b.h",
      scope: "DOMAIN",
      domainId: "healthcare",
      objects: [object({ scope: "DOMAIN", domainId: "healthcare", knowledgeId: "k.x" })],
      version: "1",
      signatureRef: "s",
    });
    expect(
      r.resolve({ knowledgeId: "k.x", requester: { tenantId: "t", domainId: "manufacturing" } }).found,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLICATION
// ─────────────────────────────────────────────────────────────────────────────

describe("what may be published, and what may not", () => {
  it("refuses to bundle TENANT or USER knowledge at all", () => {
    // The core invariant, at the only place a bundle is created. Tenant
    // knowledge does not become a bundle; it stays where it was produced.
    const r = registry();
    for (const scope of ["TENANT", "USER_OR_ROLE", "EPHEMERAL"] as const) {
      const result = r.publish({
        bundleId: `b.${scope}`,
        scope,
        objects: [object({ scope })],
        version: "1",
        signatureRef: "s",
      });
      expect(result.published).toBe(false);
    }
    expect(tenantKnowledgePromotesByCopy()).toBe(false);
  });

  it("refuses an object whose scope is wider than the bundle's", () => {
    // A GLOBAL bundle containing a DOMAIN object would distribute restricted
    // knowledge to every instance, and the bundle's own label would say it was
    // fine.
    const r = registry();
    const result = r.publish({
      bundleId: "b.mixed",
      scope: "GLOBAL",
      objects: [object({ scope: "DOMAIN", domainId: "healthcare" })],
      version: "1",
      signatureRef: "s",
    });
    expect(result.published).toBe(false);
    if (result.published) return;
    expect(result.reason).toMatch(/does not widen what it contains/);
  });

  it("blocks a promotion carrying detected personal data", () => {
    expect(knowledgeObjectSchema.safeParse(object({ piiStatus: "detected" })).success).toBe(false);
  });

  it("blocks one that was never scanned", () => {
    // `not_scanned` is an honest state and a disqualifying one. Unknown is not
    // the same as clean.
    expect(knowledgeObjectSchema.safeParse(object({ piiStatus: "not_scanned" })).success).toBe(false);
  });

  it("requires a domain on domain-scoped knowledge", () => {
    // Without one it is global knowledge with a label, and it would reach the
    // instances the restriction exists to exclude.
    expect(
      knowledgeObjectSchema.safeParse(object({ scope: "DOMAIN", domainId: undefined })).success,
    ).toBe(false);
  });

  it("requires a Governance reference on validated knowledge", () => {
    // Validation says it works. Approval says it may be distributed.
    expect(
      knowledgeObjectSchema.safeParse(object({ governanceApprovalRef: undefined })).success,
    ).toBe(false);
  });

  it("keeps bundles immutable and non-empty", () => {
    const r = registry();
    expect(publishGlobal(r).published).toBe(true);
    expect(publishGlobal(r).published).toBe(false);
    expect(
      r.publish({ bundleId: "b.empty", scope: "GLOBAL", objects: [], version: "1", signatureRef: "s" })
        .published,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ELIGIBILITY AND ADOPTION
// ─────────────────────────────────────────────────────────────────────────────

describe("a bundle reaches only the instances entitled to it", () => {
  it("gives one global update to two instances without moving either's data", () => {
    const r = registry();
    publishGlobal(r);
    const reg = createInstanceRegistry();
    reg.register(instance({ globalInstanceId: "hive.a", tenantIds: ["ksix"] }));
    reg.register(instance({ globalInstanceId: "hive.b", tenantIds: ["brighton"] }));

    for (const id of ["hive.a", "hive.b"]) {
      const inst = reg.get(id)!;
      expect(r.eligibility("bundle.1", inst).eligible).toBe(true);
      expect(reg.recordAdoption(id, "bundle.1").ok).toBe(true);
    }

    // Neither instance's tenants appear anywhere in what was distributed.
    const bundle = r.bundle("bundle.1")!;
    expect(JSON.stringify(bundle)).not.toMatch(/ksix|brighton/);
    expect(sameCodeMeansSharedData()).toBe(false);
  });

  it("rejects a domain bundle at an instance outside the domain", () => {
    const r = registry();
    r.publish({
      bundleId: "b.health",
      scope: "DOMAIN",
      domainId: "healthcare",
      objects: [object({ scope: "DOMAIN", domainId: "healthcare" })],
      version: "1",
      signatureRef: "s",
    });

    const outside = instanceRegistrationFor({ domainIds: ["manufacturing"] });
    const verdict = r.eligibility("b.health", outside);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/not authorized for it/);

    const inside = instanceRegistrationFor({ domainIds: ["healthcare"] });
    expect(r.eligibility("b.health", inside).eligible).toBe(true);
  });

  it("refuses a bundle an instance is too old to use", () => {
    const r = registry();
    r.publish({
      bundleId: "b.new",
      scope: "GLOBAL",
      objects: [object({ minEngineVersion: "0.21.0" })],
      version: "1",
      signatureRef: "s",
    });
    const old = instanceRegistrationFor({ engineVersions: { forgeiq: "0.19.0" } });
    expect(r.eligibility("b.new", old).eligible).toBe(false);

    const current = instanceRegistrationFor({ engineVersions: { forgeiq: "0.22.0" } });
    expect(r.eligibility("b.new", current).eligible).toBe(true);
  });

  it("refuses when the instance does not report the engine at all", () => {
    // Not running it is not the same as running an incompatible version, and a
    // dependency nobody has checked is not one that passed.
    const r = registry();
    r.publish({
      bundleId: "b.new",
      scope: "GLOBAL",
      objects: [object({ minEngineVersion: "0.21.0" })],
      version: "1",
      signatureRef: "s",
    });
    expect(r.eligibility("b.new", instanceRegistrationFor({ engineVersions: {} })).eligible).toBe(false);
  });

  it("records adoption idempotently", () => {
    // A retried distribution is not a fault.
    const reg = createInstanceRegistry();
    reg.register(instance());
    expect(reg.recordAdoption("hive.instance.a", "bundle.1").ok).toBe(true);
    expect(reg.recordAdoption("hive.instance.a", "bundle.1").ok).toBe(true);
    expect(reg.get("hive.instance.a")?.adoptedBundleIds).toEqual(["bundle.1"]);
  });

  it("keeps a pin as a decision rather than a hint", () => {
    const reg = createInstanceRegistry();
    reg.register(instance({ pinnedVersions: { forgeiq: "0.19.0" } }));
    expect(reg.get("hive.instance.a")?.pinnedVersions).toEqual({ forgeiq: "0.19.0" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVOCATION
// ─────────────────────────────────────────────────────────────────────────────

describe("a bad bundle stops being used and does not stop existing", () => {
  it("becomes ineligible and unresolvable once revoked", () => {
    const r = registry();
    publishGlobal(r);
    const inst = instanceRegistrationFor();
    expect(r.eligibility("bundle.1", inst).eligible).toBe(true);

    expect(r.revoke("bundle.1", "wrong kerf value", "user.steven").revoked).toBe(true);
    expect(r.eligibility("bundle.1", inst).eligible).toBe(false);
    expect(r.resolve({ knowledgeId: "k.kerf", requester: { tenantId: "ksix" } }).found).toBe(false);
  });

  it("keeps the record so an instance can explain what it ran", () => {
    const r = registry();
    publishGlobal(r);
    r.revoke("bundle.1", "wrong kerf value", "user.steven");

    const bundle = r.bundle("bundle.1");
    expect(bundle).not.toBeNull();
    expect(bundle?.revokedReason).toMatch(/wrong kerf value/);
    expect(bundle?.objects).toHaveLength(1);
    expect(revocationDeletes()).toBe(false);
  });

  it("refuses a second revocation", () => {
    const r = registry();
    publishGlobal(r);
    r.revoke("bundle.1", "bad", "user.steven");
    expect(r.revoke("bundle.1", "bad again", "user.steven").revoked).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe("one instance does not reach into another", () => {
  it("has no method by which it could", () => {
    // Instances adopt versioned artifacts from the control plane; none of them
    // reaches into another. An instance that could patch its neighbour would
    // make every isolation guarantee conditional on nobody choosing to.
    const reg = createInstanceRegistry();
    expect(Object.keys(reg).sort()).toEqual([
      "all",
      "durability",
      "get",
      "recordAdoption",
      "register",
    ]);
    for (const forbidden of ["patch", "push", "write", "sync", "mirror"]) {
      expect(Object.keys(reg)).not.toContain(forbidden);
    }
    expect(instanceMayPatchAnother()).toBe(false);
  });

  it("refuses to register the same instance twice", () => {
    const reg = createInstanceRegistry();
    expect(reg.register(instance()).registered).toBe(true);
    expect(reg.register(instance()).registered).toBe(false);
  });

  it("requires an instance to name at least one tenant", () => {
    const reg = createInstanceRegistry();
    expect(reg.register(instance({ tenantIds: [] })).registered).toBe(false);
  });
});

/** A parsed registration, for the eligibility checks. */
function instanceRegistrationFor(over: Record<string, unknown> = {}) {
  const reg = createInstanceRegistry();
  const result = reg.register(instance(over));
  if (!result.registered) throw new Error(`fixture did not register: ${result.reason}`);
  return result.instance;
}

describe("the registries survive a restart", () => {
  it("does not un-revoke a bad bundle by restarting", () => {
    // The worst thing to lose here. A knowledge registry that forgot its
    // revocations would bring a withdrawn bundle back every time the process
    // came up — and the failure that prompted the revocation with it.
    //
    // Caught by the durability guard written in an earlier phase, on this
    // file, two hours after that guard existed.
    const store = createInMemoryFederationStore();
    const first = createKnowledgeRegistry({ now: NOW, store });
    publishGlobal(first);
    first.revoke("bundle.1", "wrong kerf value", "user.steven");

    const restarted = createKnowledgeRegistry({ now: NOW, store });
    expect(restarted.bundle("bundle.1")?.revokedAt).toBeTruthy();
    expect(
      restarted.resolve({ knowledgeId: "k.kerf", requester: { tenantId: "ksix" } }).found,
    ).toBe(false);
  });

  it("remembers which instances exist and what they adopted", () => {
    // An instance registry that forgot who exists cannot decide eligibility
    // for anyone.
    const store = createInMemoryFederationStore();
    const before = createInstanceRegistry(store);
    before.register(instance());
    before.recordAdoption("hive.instance.a", "bundle.1");

    const after = createInstanceRegistry(store);
    expect(after.get("hive.instance.a")?.adoptedBundleIds).toEqual(["bundle.1"]);
    // And it is still one registration, not two.
    expect(after.register(instance()).registered).toBe(false);
  });

  it("says which kind of store is bound", () => {
    expect(createInstanceRegistry().durability()).toBe("in-memory");
    expect(createKnowledgeRegistry().durability()).toBe("in-memory");
  });
});
