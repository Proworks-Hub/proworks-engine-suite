// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  candidateKnowledgeSchema,
  knowledgeRequestSchema,
  knowledgeResponseSchema,
  sanitizationOf,
  type CandidateKnowledge,
  type KnowledgeRequest,
  type KnowledgeResponse,
  type KnowledgeScope,
  type PromotionClassification,
  type Provenance,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The knowledge gateway.
//
// One door in front of the collective, and three things it is for:
//
//   IT ANSWERS reads, from a bounded cache when policy allows and from the
//   collective when it does not.
//
//   IT REFUSES cross-tenant reads, stale answers to callers that asked for
//   fresh ones, and any use of a cached critical fact past its life.
//
//   IT SANITIZES contributions on the way out, and rejects rather than strips
//   — the same rule Phase 7 applies to evolution candidates, reusing the same
//   function so the two cannot drift apart.
//
// THE CACHE KEY IS THE WHOLE DESIGN
//
// Canonical knowledge is keyed WITHOUT the tenant, so two shops asking the
// same question share one authoritative answer — which is the entire point of
// having a collective. Tenant-private knowledge is keyed WITH it, so one
// shop's answer can never be served to another.
//
// Getting that backwards fails in both directions and only one of them is
// visible: keying canonical per-tenant merely wastes the cache, and omitting
// the tenant from a private key serves one shop's data to the next caller with
// the same question. That asymmetry is why the key is built in one place.
//
// A CACHE, NEVER AN AUTHORITY
//
// Entries carry the collective version they reflect. An instance that answered
// from its own store while disagreeing with the collective would have forked
// shared knowledge, and nobody would find out until two instances decided
// differently from the same question.
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheEntry {
  readonly key: string;
  readonly response: KnowledgeResponse;
  /** When this entry stops being usable at all. */
  readonly expiresAt: number;
  /** When it stops being fresh, if it may be served stale first. */
  readonly softExpiresAt: number;
  /** Whether policy permits serving this stale while refreshing. */
  readonly staleServable: boolean;
  /**
   * Whether this is safety-critical.
   *
   * Critical knowledge fails closed: never served stale, never served during
   * an outage past its life. A stale machine tolerance is not a slow answer,
   * it is a wrong answer about something that cuts metal.
   */
  readonly critical: boolean;
  readonly domain: string;
  readonly knowledgeId: string;
  readonly version: string;
  lastUsedAt: number;
}

export interface KnowledgeCache {
  readonly durability: "in-memory" | "durable";
  get(key: string): CacheEntry | null;
  put(entry: CacheEntry): void;
  /** Targeted removal. Returns how many entries went. */
  invalidate(match: { knowledgeId?: string; domain?: string; version?: string }): number;
  entries(): readonly CacheEntry[];
  size(): number;
}

/**
 * A bounded cache. Bounded is the point.
 *
 * An unbounded local copy of the collective is a mirror, and a mirror is a
 * second authority whether or not anybody calls it one.
 */
export function createInMemoryKnowledgeCache(maxEntries = 500): KnowledgeCache {
  const held = new Map<string, CacheEntry>();

  const evictIfNeeded = (): void => {
    while (held.size > maxEntries) {
      // Least recently used. An arbitrary eviction would make the cache's
      // behaviour depend on insertion order, which is not something an
      // operator can reason about during an incident.
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of held) {
        if (entry.lastUsedAt < oldest) {
          oldest = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      held.delete(oldestKey);
    }
  };

  return {
    durability: "in-memory",
    get: (key) => held.get(key) ?? null,
    put: (entry) => {
      held.set(entry.key, entry);
      evictIfNeeded();
    },
    invalidate(match) {
      let removed = 0;
      for (const [key, entry] of [...held]) {
        const hit =
          (match.knowledgeId !== undefined && entry.knowledgeId === match.knowledgeId) ||
          (match.domain !== undefined && entry.domain === match.domain) ||
          (match.version !== undefined && entry.version === match.version);
        if (hit) {
          held.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    entries: () => [...held.values()],
    size: () => held.size,
  };
}

/** What the collective service returns, or why it could not. */
export type CollectiveResult =
  | { readonly ok: true; readonly response: KnowledgeResponse; readonly knowledgeId: string; readonly critical?: boolean; readonly staleServable?: boolean }
  | { readonly ok: false; readonly reason: string };

export interface CollectiveKnowledgeService {
  fetch(request: KnowledgeRequest): CollectiveResult;
  /** Commits a new immutable version. Only reached for auto-promotable candidates. */
  commit(candidate: CandidateKnowledge): { committed: true; version: string } | { committed: false; reason: string };
}

export interface KnowledgePolicy {
  /** Whether this read is permitted, and under which decision. */
  mayRead(request: KnowledgeRequest): { permitted: boolean; reason: string; decisionId: string };
  /** How a candidate should be handled. Sentinel and Governance behind it. */
  classify(candidate: CandidateKnowledge): {
    classification: PromotionClassification;
    checks: readonly string[];
    reason: string;
  };
}

export type KnowledgeEvent =
  | "knowledge.requested"
  | "knowledge.cache.hit"
  | "knowledge.cache.miss"
  | "knowledge.collective.fetched"
  | "knowledge.candidate.submitted"
  | "knowledge.candidate.rejected"
  | "knowledge.candidate.review_required"
  | "knowledge.published"
  | "knowledge.cache.invalidate";

export type ReadResult =
  | { readonly served: true; readonly response: KnowledgeResponse }
  | { readonly served: false; readonly reason: string };

export type ContributeResult =
  | { readonly accepted: true; readonly classification: PromotionClassification; readonly version?: string; readonly reason: string }
  | { readonly accepted: false; readonly reason: string };

export interface KnowledgeGateway {
  /** The only read path. */
  read(input: unknown): ReadResult;
  /** The only contribution path. */
  contribute(input: unknown): ContributeResult;
  /** Removes affected entries after a publication elsewhere. */
  invalidate(match: { knowledgeId?: string; domain?: string; version?: string }): number;
  cacheSize(): number;
}

export interface KnowledgeGatewayOptions {
  readonly instanceId: string;
  readonly collective: CollectiveKnowledgeService;
  readonly policy: KnowledgePolicy;
  readonly cache?: KnowledgeCache;
  readonly now?: () => Date;
  /** Default life of a cache entry. */
  readonly ttlMs?: number;
  /** How long a stale-servable entry may be served past its soft expiry. */
  readonly staleGraceMs?: number;
  readonly onEvent?: (event: KnowledgeEvent, detail: Readonly<Record<string, string | number | boolean>>) => void;
}

/**
 * Builds the cache key.
 *
 * ONE place, because the asymmetry matters: keying canonical knowledge
 * per-tenant merely wastes cache, and omitting the tenant from a private key
 * serves one shop's data to the next caller asking the same question. Only one
 * of those is visible in testing.
 */
export function cacheKeyFor(request: {
  domain: string;
  query: string;
  requestedScope: KnowledgeScope;
  tenantId?: string;
}): string {
  const normalizedQuery = request.query.trim().toLowerCase().replace(/\s+/g, " ");
  const scopePart =
    request.requestedScope === "canonical"
      ? "canonical"
      : `${request.requestedScope}:${request.tenantId ?? "-"}`;
  return `${request.domain}|${scopePart}|${normalizedQuery}`;
}

export function createKnowledgeGateway(options: KnowledgeGatewayOptions): KnowledgeGateway {
  const now = options.now ?? (() => new Date());
  const cache = options.cache ?? createInMemoryKnowledgeCache();
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const staleGraceMs = options.staleGraceMs ?? 60_000;

  const emit = (event: KnowledgeEvent, detail: Record<string, string | number | boolean>): void => {
    options.onEvent?.(event, detail);
  };

  return {
    read(input) {
      const parsed = knowledgeRequestSchema.safeParse(input);
      if (!parsed.success) {
        return { served: false, reason: `Not a valid knowledge request: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const request = parsed.data;
      emit("knowledge.requested", { domain: request.domain, engineId: request.engineId });

      // ── The instance boundary ──────────────────────────────────────────
      //
      // A request naming another instance is not this gateway's to answer. The
      // caller's instance is bound by the runtime that built the request; a
      // mismatch means either a misrouted call or something trying to read
      // through somebody else's door.
      if (request.instanceId !== options.instanceId) {
        return {
          served: false,
          reason: `This gateway serves ${options.instanceId} and the request names ${request.instanceId}.`,
        };
      }

      const decision = options.policy.mayRead(request);
      if (!decision.permitted) {
        // Fails closed. A read the policy will not permit is not answered from
        // cache either — the cache is a copy of answers, not a way around the
        // question of whether they may be given.
        return { served: false, reason: `Refused: ${decision.reason}` };
      }

      const key = cacheKeyFor(request);
      const at = now().getTime();
      const cached = cache.get(key);

      if (cached) {
        const expired = at >= cached.expiresAt;
        const soft = at >= cached.softExpiresAt;

        if (!expired && !soft && request.freshness !== "fresh") {
          cached.lastUsedAt = at;
          emit("knowledge.cache.hit", { key, domain: request.domain });
          return { served: true, response: { ...cached.response, cacheStatus: "hit" } };
        }

        // Stale-while-revalidate, and only where BOTH the entry and the
        // request allow it, and never for critical knowledge. Three conditions
        // rather than one because each of them is a different party agreeing:
        // the knowledge's own risk, the policy that cached it, and the caller.
        if (
          !expired &&
          soft &&
          cached.staleServable &&
          !cached.critical &&
          request.freshness === "stale_while_revalidate"
        ) {
          cached.lastUsedAt = at;
          emit("knowledge.cache.hit", { key, stale: true });
          return { served: true, response: { ...cached.response, cacheStatus: "stale" } };
        }
      }

      emit("knowledge.cache.miss", { key, domain: request.domain });
      const fetched = options.collective.fetch(request);

      if (!fetched.ok) {
        // ── The outage path ──────────────────────────────────────────────
        //
        // A previously authorized, still-live entry stays usable. The point of
        // a cache during an outage is that a shop keeps working — but a
        // CRITICAL entry still fails closed, because "the collective is down"
        // is not a reason to act on a tolerance nobody can confirm.
        if (cached && at < cached.expiresAt && !cached.critical) {
          cached.lastUsedAt = at;
          emit("knowledge.cache.hit", { key, duringOutage: true });
          return { served: true, response: { ...cached.response, cacheStatus: "unavailable" } };
        }
        return {
          served: false,
          reason: cached?.critical
            ? `The collective is unreachable (${fetched.reason}) and this knowledge is safety-critical. A stale answer about something consequential is worse than no answer.`
            : `The collective is unreachable: ${fetched.reason}`,
        };
      }

      const response = knowledgeResponseSchema.safeParse({
        ...fetched.response,
        policyDecisionId: decision.decisionId,
        cacheStatus: "miss",
      });
      if (!response.success) {
        return {
          served: false,
          reason: `The collective returned something malformed: ${JSON.stringify(response.error.flatten())}`,
        };
      }

      emit("knowledge.collective.fetched", { key, version: response.data.version });

      // The effective scope may be narrower than what was asked for, and the
      // entry is keyed by what was ACTUALLY served. Caching a tenant-private
      // answer under a canonical key is the leak this whole file is about.
      const effectiveKey = cacheKeyFor({
        domain: request.domain,
        query: request.query,
        requestedScope: response.data.effectiveScope,
        ...(request.tenantId ? { tenantId: request.tenantId } : {}),
      });

      cache.put({
        key: effectiveKey,
        response: response.data,
        expiresAt: at + ttlMs,
        softExpiresAt: at + ttlMs - staleGraceMs,
        staleServable: fetched.staleServable ?? false,
        critical: fetched.critical ?? false,
        domain: request.domain,
        knowledgeId: fetched.knowledgeId,
        version: response.data.version,
        lastUsedAt: at,
      });

      return { served: true, response: response.data };
    },

    contribute(input) {
      const parsed = candidateKnowledgeSchema.safeParse(input);
      if (!parsed.success) {
        emit("knowledge.candidate.rejected", { reason: "malformed" });
        return { accepted: false, reason: `Not a valid candidate: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const candidate = parsed.data;
      emit("knowledge.candidate.submitted", { domain: candidate.domain, engineId: candidate.sourceEngineId });

      // ── Privacy, checked and not merely attested ───────────────────────
      //
      // The submitter's attestation is on the record and does not substitute
      // for this. Reusing `sanitizationOf` from the evolution candidate rather
      // than writing a second one: two privacy checks would eventually
      // disagree, and the weaker would be the one somebody routed through.
      const clean = sanitizationOf(candidate.generalizedClaim);
      if (!clean.clean) {
        emit("knowledge.candidate.rejected", { reason: "tenant data" });
        return { accepted: false, reason: clean.reason };
      }

      const classified = options.policy.classify(candidate);

      if (classified.classification === "prohibited") {
        emit("knowledge.candidate.rejected", { reason: classified.reason });
        return { accepted: false, reason: `Prohibited: ${classified.reason}` };
      }

      if (classified.classification === "review_required") {
        // Not committed and not lost. A governed approval package is somebody
        // else's job; what matters here is that the gateway did not decide.
        emit("knowledge.candidate.review_required", { candidateId: candidate.candidateId });
        return {
          accepted: true,
          classification: "review_required",
          reason: `Held for review: ${classified.reason}`,
        };
      }

      const committed = options.collective.commit(candidate);
      if (!committed.committed) {
        return { accepted: false, reason: `The collective refused the commit: ${committed.reason}` };
      }

      emit("knowledge.published", { candidateId: candidate.candidateId, version: committed.version });

      // A new version invalidates what it supersedes, by DOMAIN rather than
      // wholesale. Clearing the cache on every publication would turn one
      // instance's contribution into every instance's cold start.
      const removed = cache.invalidate({ domain: candidate.domain });
      if (removed > 0) emit("knowledge.cache.invalidate", { domain: candidate.domain, removed });

      return {
        accepted: true,
        classification: "auto_promotable",
        version: committed.version,
        reason: classified.reason,
      };
    },

    invalidate(match) {
      const removed = cache.invalidate(match);
      emit("knowledge.cache.invalidate", { removed });
      return removed;
    },

    cacheSize: () => cache.size(),
  };
}

/**
 * Whether the gateway itself may decide a contested promotion.
 *
 * Always false. It sanitizes, classifies through a policy port, and commits
 * only what that policy called auto-promotable. A gateway that could promote a
 * review-required candidate would be the door deciding what comes through it.
 */
export function gatewayMayPromoteWithoutPolicy(): false {
  return false;
}

/** The provenance an answer must never lose. Exported so callers can assert it. */
export function hasProvenance(response: { provenance: readonly Provenance[] }): boolean {
  return response.provenance.length > 0;
}
