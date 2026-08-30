// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  SCOPE_PRECEDENCE,
  instanceRegistrationSchema,
  isCollectiveScope,
  knowledgeObjectSchema,
  scopeVisibleTo,
  type DistributionScope,
  type InstanceRegistration,
  type KnowledgeObject,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRIES, AND WHO IS ALLOWED TO SEE WHAT.
//
// Phase 9 built the door. This builds the two lists the door consults: which
// instances exist and what they are eligible for, and which knowledge has been
// published and at what reach.
//
// THE PRECEDENCE IS THE INTERESTING PART
//
// USER_OR_ROLE → TENANT → DOMAIN → GLOBAL, most specific first, because
// narrower knowledge is more likely to be right about this particular
// situation and the general answer is a fallback rather than an authority.
//
// But precedence is a SEARCH ORDER, not a permission. A caller with no domain
// binding does not reach DOMAIN knowledge by asking for it, and the resolver
// filters by what the requester HAS before it orders by specificity. Ordering
// first and filtering second would be the same code with a leak in it.
//
// REVOCATION WITHOUT DELETION
//
// A bad bundle stops being served and does not stop existing. Instances that
// adopted it need the record to explain what they were running, and an
// incident review needs the provenance more than the platform needs the disk
// space.
// ─────────────────────────────────────────────────────────────────────────────

export interface KnowledgeBundle {
  readonly bundleId: string;
  readonly scope: DistributionScope;
  readonly domainId: string | null;
  readonly objects: readonly KnowledgeObject[];
  readonly version: string;
  /** Signed by the control plane. A reference to a signature, not a scheme. */
  readonly signatureRef: string;
  readonly publishedAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

export type PublishResult =
  | { readonly published: true; readonly bundle: KnowledgeBundle }
  | { readonly published: false; readonly reason: string };

export type EligibilityVerdict = { readonly eligible: boolean; readonly reason: string };

/**
 * Where the registries keep what they know.
 *
 * Caught by the durability guard from the previous phase, on code written two
 * hours after it — which is what that guard is for. Both of these are worse to
 * lose than most: an instance registry that forgets who exists cannot decide
 * eligibility for anyone, and a knowledge registry that forgets its
 * revocations un-revokes a bad bundle by restarting.
 */
export interface FederationStore {
  readonly durability: "in-memory" | "durable";
  instances(): readonly InstanceRegistration[];
  instance(globalInstanceId: string): InstanceRegistration | null;
  putInstance(instance: InstanceRegistration): void;
  bundles(): readonly KnowledgeBundle[];
  bundle(bundleId: string): KnowledgeBundle | null;
  putBundle(bundle: KnowledgeBundle): void;
}

export function createInMemoryFederationStore(): FederationStore {
  const registeredInstances = new Map<string, InstanceRegistration>();
  const publishedBundles = new Map<string, KnowledgeBundle>();
  return {
    durability: "in-memory",
    instances: () => [...registeredInstances.values()],
    instance: (id) => registeredInstances.get(id) ?? null,
    putInstance: (i) => {
      registeredInstances.set(i.globalInstanceId, i);
    },
    bundles: () => [...publishedBundles.values()],
    bundle: (id) => publishedBundles.get(id) ?? null,
    putBundle: (b) => {
      publishedBundles.set(b.bundleId, b);
    },
  };
}

export interface InstanceRegistry {
  register(input: unknown): { registered: true; instance: InstanceRegistration } | { registered: false; reason: string };
  get(globalInstanceId: string): InstanceRegistration | null;
  /** Records that an instance took a bundle. */
  recordAdoption(globalInstanceId: string, bundleId: string): { ok: boolean; reason: string };
  all(): readonly InstanceRegistration[];
  /** Whether registrations survive a restart. */
  durability(): "in-memory" | "durable";
}

export interface KnowledgeRegistry {
  publish(input: {
    bundleId: string;
    scope: DistributionScope;
    domainId?: string;
    objects: readonly unknown[];
    version: string;
    signatureRef: string;
  }): PublishResult;

  /** Whether this instance may take this bundle. */
  eligibility(bundleId: string, instance: InstanceRegistration): EligibilityVerdict;

  /** Stops it being served. Does not delete it. */
  revoke(bundleId: string, reason: string, by: string): { revoked: boolean; reason: string };

  /**
   * Resolves one query across scopes, most specific first.
   *
   * Returns the narrowest visible answer, and nothing at all when the
   * requester's authority does not reach any scope that holds one.
   */
  resolve(input: {
    knowledgeId: string;
    requester: { tenantId?: string; domainId?: string; actorId?: string };
  }): { found: true; object: KnowledgeObject; scope: DistributionScope } | { found: false; reason: string };

  bundle(bundleId: string): KnowledgeBundle | null;
  bundles(): readonly KnowledgeBundle[];
  /** Whether published bundles and their revocations survive a restart. */
  durability(): "in-memory" | "durable";
}

export function createInstanceRegistry(store?: FederationStore): InstanceRegistry {
  const held = store ?? createInMemoryFederationStore();

  return {
    register(input) {
      const parsed = instanceRegistrationSchema.safeParse(input);
      if (!parsed.success) {
        return { registered: false, reason: `Not a valid registration: ${JSON.stringify(parsed.error.flatten())}` };
      }
      if (held.instance(parsed.data.globalInstanceId)) {
        return { registered: false, reason: `Instance ${parsed.data.globalInstanceId} is already registered.` };
      }
      held.putInstance(parsed.data);
      return { registered: true, instance: parsed.data };
    },

    get: (id) => held.instance(id),

    recordAdoption(globalInstanceId, bundleId) {
      const instance = held.instance(globalInstanceId);
      if (!instance) return { ok: false, reason: `No instance ${globalInstanceId}.` };
      if (instance.adoptedBundleIds.includes(bundleId)) {
        // Idempotent. Re-adopting is not an error, and treating it as one
        // would make a retried distribution look like a fault.
        return { ok: true, reason: "Already adopted." };
      }
      held.putInstance({
        ...instance,
        adoptedBundleIds: [...instance.adoptedBundleIds, bundleId],
      });
      return { ok: true, reason: "Adoption recorded." };
    },

    all: () => held.instances(),
    durability: () => held.durability,
  };
}

export interface KnowledgeRegistryOptions {
  readonly now?: () => Date;
  /** Where bundles live. Defaults to in-memory. */
  readonly store?: FederationStore;
  readonly onPublished?: (bundle: KnowledgeBundle) => void;
  readonly onRevoked?: (bundle: KnowledgeBundle, reason: string) => void;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function createKnowledgeRegistry(
  options: KnowledgeRegistryOptions = {},
): KnowledgeRegistry {
  const now = options.now ?? (() => new Date());
  const held = options.store ?? createInMemoryFederationStore();

  return {
    publish(input) {
      if (held.bundle(input.bundleId)) {
        return { published: false, reason: `Bundle ${input.bundleId} already exists. Bundles are immutable.` };
      }
      if (!isCollectiveScope(input.scope)) {
        // The core invariant, enforced at the only place a bundle is created.
        // Tenant and user knowledge does not become a bundle; it stays where
        // it was produced.
        return {
          published: false,
          reason: `${input.scope} knowledge is not distributable. Promotion is transformation plus authorization, never replication of what a tenant already had.`,
        };
      }
      if (input.scope === "DOMAIN" && !input.domainId) {
        return { published: false, reason: "A domain bundle must name its domain." };
      }

      const objects: KnowledgeObject[] = [];
      for (const raw of input.objects) {
        const parsed = knowledgeObjectSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            published: false,
            reason: `A knowledge object is not publishable: ${JSON.stringify(parsed.error.flatten())}`,
          };
        }
        if (parsed.data.scope !== input.scope) {
          // A GLOBAL bundle containing a DOMAIN object would distribute
          // restricted knowledge to every instance, and the bundle's own label
          // would say it was fine.
          return {
            published: false,
            reason: `Object ${parsed.data.knowledgeId} is ${parsed.data.scope} and the bundle is ${input.scope}. A bundle does not widen what it contains.`,
          };
        }
        objects.push(parsed.data);
      }

      if (objects.length === 0) {
        return { published: false, reason: "An empty bundle distributes nothing and invalidates caches for no reason." };
      }

      const bundle: KnowledgeBundle = {
        bundleId: input.bundleId,
        scope: input.scope,
        domainId: input.domainId ?? null,
        objects,
        version: input.version,
        signatureRef: input.signatureRef,
        publishedAt: now().toISOString(),
        revokedAt: null,
        revokedReason: null,
      };
      held.putBundle(bundle);
      options.onPublished?.(bundle);
      return { published: true, bundle };
    },

    eligibility(bundleId, instance) {
      const bundle = held.bundle(bundleId);
      if (!bundle) return { eligible: false, reason: `No bundle ${bundleId}.` };
      if (bundle.revokedAt) {
        return { eligible: false, reason: `Bundle ${bundleId} was revoked: ${bundle.revokedReason}` };
      }

      // Domain eligibility. An instance outside the domain does not receive
      // domain knowledge, and this is the check regulated deployments rest on.
      if (bundle.scope === "DOMAIN") {
        if (!bundle.domainId || !instance.domainIds.includes(bundle.domainId)) {
          return {
            eligible: false,
            reason: `This bundle is scoped to ${bundle.domainId ?? "an unnamed domain"} and ${instance.globalInstanceId} is not authorized for it.`,
          };
        }
      }

      // Compatibility. An object requiring an engine version the instance does
      // not run is refused for the whole bundle — partially adopting a bundle
      // would leave an instance holding knowledge whose neighbours are missing.
      for (const object of bundle.objects) {
        if (!object.minEngineVersion) continue;
        const engineId = object.contentType.split(":")[0] ?? "";
        const running = instance.engineVersions[engineId];
        if (running === undefined) {
          return {
            eligible: false,
            reason: `Object ${object.knowledgeId} requires ${engineId}, which this instance does not report running.`,
          };
        }
        if (compareVersions(running, object.minEngineVersion) < 0) {
          return {
            eligible: false,
            reason: `Object ${object.knowledgeId} needs ${engineId} >= ${object.minEngineVersion}; this instance runs ${running}.`,
          };
        }
      }

      return { eligible: true, reason: "Domain and compatibility both satisfied." };
    },

    revoke(bundleId, reason, by) {
      const bundle = held.bundle(bundleId);
      if (!bundle) return { revoked: false, reason: `No bundle ${bundleId}.` };
      if (bundle.revokedAt) return { revoked: false, reason: "Already revoked." };

      const revoked: KnowledgeBundle = {
        ...bundle,
        revokedAt: now().toISOString(),
        revokedReason: `${reason} (revoked by ${by})`,
      };
      held.putBundle(revoked);
      options.onRevoked?.(revoked, reason);
      return {
        revoked: true,
        reason: "Revoked; the bundle and its provenance remain so instances can explain what they ran.",
      };
    },

    resolve({ knowledgeId, requester }) {
      // Filter by authority FIRST, then order by specificity. Ordering first
      // and filtering second is the same code with a leak in it: it would find
      // the narrowest answer and then discover it was not allowed to have it,
      // having already skipped the one it was.
      //
      // The `scopeVisibleTo` call is currently REDUNDANT for everything this
      // registry can hold, and a mutation proved it: only DOMAIN and GLOBAL
      // bundles exist here, GLOBAL is visible to all, and DOMAIN is caught by
      // the domain comparison below. It stops being redundant the moment
      // TENANT or USER_OR_ROLE knowledge is resolvable through this function —
      // which the precedence list anticipates and this registry does not yet
      // hold, because that knowledge is instance-local by design.
      for (const scope of SCOPE_PRECEDENCE) {
        if (!scopeVisibleTo(scope, requester)) continue;

        for (const bundle of held.bundles()) {
          if (bundle.revokedAt) continue;
          if (bundle.scope !== scope) continue;
          if (scope === "DOMAIN" && bundle.domainId !== requester.domainId) continue;

          const object = bundle.objects.find((o) => o.knowledgeId === knowledgeId);
          if (object && object.validationStatus !== "revoked") {
            return { found: true, object, scope };
          }
        }
      }
      return {
        found: false,
        reason: `Nothing named ${knowledgeId} is visible at any scope this requester reaches.`,
      };
    },

    bundle: (bundleId) => held.bundle(bundleId),
    bundles: () => held.bundles(),
    durability: () => held.durability,
  };
}

/**
 * Whether an instance may write into another instance.
 *
 * Always false. Instances adopt versioned artifacts from the control plane;
 * none of them reaches into another. An instance that could patch its
 * neighbour would make every isolation guarantee conditional on nobody
 * choosing to.
 */
export function instanceMayPatchAnother(): false {
  return false;
}

/**
 * Whether a revoked bundle is deleted.
 *
 * Always false. Instances that adopted it need the record to explain what they
 * were running, and an incident review needs the provenance more than the
 * platform needs the disk space.
 */
export function revocationDeletes(): false {
  return false;
}
