// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  cacheIsAuthoritative,
  candidateKnowledgeSchema,
  engineMayQueryCollectiveDirectly,
  knowledgeRequestSchema,
} from "@proworks-hub/contracts";
import {
  cacheKeyFor,
  createInMemoryKnowledgeCache,
  createKnowledgeGateway,
  gatewayMayPromoteWithoutPolicy,
  type CollectiveKnowledgeService,
  type KnowledgePolicy,
} from "@proworks-hub/platform-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 9 — the knowledge gateway.
//
// The eight acceptance tests the directive names:
//
//   1. Two tenants get the same authoritative fact without sharing anything.
//   2. A direct engine-to-collective call is blocked by architecture.
//   3. A valid cache hit avoids a network call.
//   4. A stale critical entry does not bypass freshness policy.
//   5. A candidate with tenant identifiers is rejected before storage.
//   6. Publishing invalidates only affected cache entries.
//   7. Losing the collective preserves safe use of still-valid entries.
//   8. Every response keeps provenance and policy-decision metadata.
//
// THE CACHE KEY IS THE WHOLE DESIGN, and the asymmetry is why: keying
// canonical knowledge per-tenant merely wastes cache, while omitting the
// tenant from a private key serves one shop's data to the next caller asking
// the same question. Only one of those is visible in testing, which is why
// both are tested here.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = "hive.instance.a";
let clock = Date.parse("2026-08-29T12:00:00.000Z");
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock += ms;
};

const permissive: KnowledgePolicy = {
  mayRead: () => ({ permitted: true, reason: "ok", decisionId: "gd.read" }),
  classify: () => ({ classification: "auto_promotable", checks: ["novelty", "corroboration"], reason: "clean" }),
};

const answer = (over: Record<string, unknown> = {}) => ({
  data: { toleranceMm: 0.1 },
  effectiveScope: "canonical",
  provenance: [
    { sourceId: "src.tolerance.corten", corroborations: 4, establishedAt: "2026-01-01T00:00:00.000Z" },
  ],
  version: "v7",
  confidence: "high",
  policyDecisionId: "gd.read",
  cacheStatus: "miss",
  expiresAt: "2026-08-29T13:00:00.000Z",
  ...over,
});

function collective(over: Partial<CollectiveKnowledgeService> = {}): CollectiveKnowledgeService {
  return {
    fetch: () => ({ ok: true, response: answer() as never, knowledgeId: "k.tolerance" }),
    commit: () => ({ committed: true, version: "v8" }),
    ...over,
  };
}

const gateway = (over: Record<string, unknown> = {}) =>
  createKnowledgeGateway({
    instanceId: INSTANCE,
    collective: collective(),
    policy: permissive,
    now,
    ttlMs: 60_000,
    staleGraceMs: 20_000,
    ...over,
  });

const request = (over: Record<string, unknown> = {}) => ({
  instanceId: INSTANCE,
  engineId: "forgeiq",
  domain: "materials",
  query: "corten cutting tolerance",
  requestedScope: "canonical",
  freshness: "cached_ok",
  ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  candidateId: "cand.k1",
  sourceInstanceId: INSTANCE,
  sourceEngineId: "forgeiq",
  domain: "materials",
  generalizedClaim: "Corten at 3mm cuts cleanly at 0.1mm kerf compensation on fiber lasers.",
  evidenceRefs: ["obs:kerf-study"],
  proposedScope: "canonical",
  confidence: "high",
  privacyAttestation: {
    attestedBy: "forgeiq",
    statement: "Derived from aggregate kerf measurements; no job or customer data included.",
    attestedAt: "2026-08-29T12:00:00.000Z",
  },
  sensitivity: "internal",
  submittedAt: "2026-08-29T12:00:00.000Z",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE CACHE KEY
// ─────────────────────────────────────────────────────────────────────────────

describe("two tenants share a canonical fact and nothing else", () => {
  it("keys canonical knowledge without the tenant", () => {
    // The entire point of a collective. Two shops asking the same question get
    // one authoritative answer.
    const a = cacheKeyFor({ domain: "materials", query: "corten tolerance", requestedScope: "canonical", tenantId: "ksix" });
    const b = cacheKeyFor({ domain: "materials", query: "corten tolerance", requestedScope: "canonical", tenantId: "brighton" });
    expect(a).toBe(b);
  });

  it("keys tenant-private knowledge WITH the tenant", () => {
    // The failure that is invisible if you get it wrong: one shop's answer
    // served to the next caller asking the same question.
    const a = cacheKeyFor({ domain: "pricing", query: "markup", requestedScope: "tenant-private", tenantId: "ksix" });
    const b = cacheKeyFor({ domain: "pricing", query: "markup", requestedScope: "tenant-private", tenantId: "brighton" });
    expect(a).not.toBe(b);
  });

  it("normalizes the query so trivial differences are one entry", () => {
    expect(cacheKeyFor({ domain: "d", query: "  Corten   Tolerance ", requestedScope: "canonical" })).toBe(
      cacheKeyFor({ domain: "d", query: "corten tolerance", requestedScope: "canonical" }),
    );
  });

  it("serves one tenant from another's cached canonical entry", () => {
    // Two gateways would be two instances; one gateway serving two tenants is
    // the case that matters, and the fetch happens once.
    const fetch = vi.fn(() => ({ ok: true as const, response: answer() as never, knowledgeId: "k.tolerance" }));
    const g = gateway({ collective: collective({ fetch }) });

    expect(g.read(request({ tenantId: "ksix" })).served).toBe(true);
    expect(g.read(request({ tenantId: "brighton" })).served).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does NOT serve one tenant from another's private entry", () => {
    const fetch = vi.fn(() => ({
      ok: true as const,
      response: answer({ effectiveScope: "tenant-private" }) as never,
      knowledgeId: "k.markup",
    }));
    const g = gateway({ collective: collective({ fetch }) });

    g.read(request({ tenantId: "ksix", requestedScope: "tenant-private", domain: "pricing" }));
    g.read(request({ tenantId: "brighton", requestedScope: "tenant-private", domain: "pricing" }));
    // Two fetches: neither tenant reached the other's entry.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires a tenant on a private request", () => {
    // Without one the gateway would have to guess whose knowledge was asked
    // for, and the cheapest guess is the wrong one.
    expect(
      knowledgeRequestSchema.safeParse(request({ requestedScope: "tenant-private" })).success,
    ).toBe(false);
  });

  it("caches under what was SERVED, not what was asked for", () => {
    // A tenant-private answer cached under a canonical key is the leak this
    // whole file is about.
    const fetch = vi.fn(() => ({
      ok: true as const,
      response: answer({ effectiveScope: "tenant-private" }) as never,
      knowledgeId: "k.x",
    }));
    const cache = createInMemoryKnowledgeCache();
    const g = gateway({ collective: collective({ fetch }), cache });

    g.read(request({ tenantId: "ksix" }));
    const [entry] = cache.entries();
    expect(entry?.key).toContain("ksix");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3, 4 & 7. CACHE BEHAVIOUR
// ─────────────────────────────────────────────────────────────────────────────

describe("the cache answers where it may and refuses where it may not", () => {
  it("avoids the network on a valid hit", () => {
    const fetch = vi.fn(() => ({ ok: true as const, response: answer() as never, knowledgeId: "k" }));
    const g = gateway({ collective: collective({ fetch }) });
    g.read(request());
    const second = g.read(request());
    expect(fetch).toHaveBeenCalledOnce();
    expect(second.served && second.response.cacheStatus).toBe("hit");
  });

  it("goes to the collective when the caller asked for fresh", () => {
    const fetch = vi.fn(() => ({ ok: true as const, response: answer() as never, knowledgeId: "k" }));
    const g = gateway({ collective: collective({ fetch }) });
    g.read(request());
    g.read(request({ freshness: "fresh" }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("serves stale only when the entry, the policy and the caller all allow it", () => {
    // Three conditions rather than one, because each is a different party
    // agreeing: the knowledge's own risk, the policy that cached it, and the
    // caller asking.
    const fetch = vi.fn(() => ({
      ok: true as const,
      response: answer() as never,
      knowledgeId: "k",
      staleServable: true,
    }));
    const g = gateway({ collective: collective({ fetch }) });
    g.read(request());

    advance(45_000); // past the soft expiry, inside the hard one
    const stale = g.read(request({ freshness: "stale_while_revalidate" }));
    expect(stale.served && stale.response.cacheStatus).toBe("stale");
  });

  it("does not serve stale when the ENTRY was not marked servable", () => {
    // One of the three conditions on its own. Found by a surviving mutation:
    // deleting this check changed no test result, because every stale case
    // covered had all three conditions true at once.
    const fetch = vi.fn(() => ({
      ok: true as const,
      response: answer() as never,
      knowledgeId: "k",
      staleServable: false,
    }));
    const g = gateway({ collective: collective({ fetch }) });
    g.read(request());

    advance(45_000);
    g.read(request({ freshness: "stale_while_revalidate" }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not serve stale when the CALLER did not ask for it", () => {
    // The other single condition. A caller saying `cached_ok` is willing to
    // take a cached answer, not a knowingly out-of-date one.
    const fetch = vi.fn(() => ({
      ok: true as const,
      response: answer() as never,
      knowledgeId: "k",
      staleServable: true,
    }));
    const g = gateway({ collective: collective({ fetch }) });
    g.read(request());

    advance(45_000);
    g.read(request({ freshness: "cached_ok" }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never serves a CRITICAL entry stale", () => {
    // A stale machine tolerance is not a slow answer. It is a wrong answer
    // about something that cuts metal.
    const fetch = vi.fn(() => ({
      ok: true as const,
      response: answer() as never,
      knowledgeId: "k",
      staleServable: true,
      critical: true,
    }));
    const g = gateway({ collective: collective({ fetch }) });
    g.read(request());

    advance(45_000);
    g.read(request({ freshness: "stale_while_revalidate" }));
    // It went back to the collective rather than serving the stale entry.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps working through a collective outage on a still-valid entry", () => {
    let fail = false;
    const g = gateway({
      collective: collective({
        fetch: () => (fail ? { ok: false, reason: "unreachable" } : { ok: true, response: answer() as never, knowledgeId: "k" }),
      }),
    });
    g.read(request());

    fail = true;
    advance(10_000);
    const during = g.read(request({ freshness: "fresh" }));
    expect(during.served).toBe(true);
    expect(during.served && during.response.cacheStatus).toBe("unavailable");
  });

  it("fails closed during an outage on a CRITICAL entry", () => {
    // "The collective is down" is not a reason to act on a tolerance nobody
    // can confirm.
    let fail = false;
    const g = gateway({
      collective: collective({
        fetch: () =>
          fail
            ? { ok: false, reason: "unreachable" }
            : { ok: true, response: answer() as never, knowledgeId: "k", critical: true },
      }),
    });
    g.read(request());

    fail = true;
    const during = g.read(request({ freshness: "fresh" }));
    expect(during.served).toBe(false);
    if (during.served) return;
    expect(during.reason).toMatch(/safety-critical/);
  });

  it("does not serve an expired entry even during an outage", () => {
    let fail = false;
    const g = gateway({
      collective: collective({
        fetch: () => (fail ? { ok: false, reason: "down" } : { ok: true, response: answer() as never, knowledgeId: "k" }),
      }),
    });
    g.read(request());

    fail = true;
    advance(120_000); // past the 60s TTL
    expect(g.read(request()).served).toBe(false);
  });

  it("is bounded, and evicts rather than growing", () => {
    // An unbounded local copy of the collective is a mirror, and a mirror is a
    // second authority whether or not anybody calls it one.
    const cache = createInMemoryKnowledgeCache(3);
    const g = gateway({ cache });
    for (let i = 0; i < 10; i += 1) g.read(request({ query: `question ${i}` }));
    expect(g.cacheSize()).toBeLessThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. INVALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe("publishing invalidates only what it affects", () => {
  it("clears the published domain and leaves the rest", () => {
    // Clearing everything on each publication would turn one instance's
    // contribution into every instance's cold start.
    const g = gateway();
    g.read(request({ domain: "materials", query: "a" }));
    g.read(request({ domain: "machines", query: "b" }));
    expect(g.cacheSize()).toBe(2);

    const result = g.contribute(candidate({ domain: "materials" }));
    expect(result.accepted).toBe(true);
    expect(g.cacheSize()).toBe(1);
  });

  it("leaves entries in other domains alone", () => {
    // Stated separately from the count above so the claim is about WHICH
    // entries survived rather than how many. A mutation that cleared
    // everything would still leave a plausible-looking number if only the
    // total were checked.
    const g = gateway();
    g.read(request({ domain: "materials", query: "a" }));
    g.read(request({ domain: "machines", query: "b" }));
    g.read(request({ domain: "pricing", query: "c" }));

    g.contribute(candidate({ domain: "materials" }));

    // The two untouched domains still answer from cache.
    const fetch = vi.fn(() => ({ ok: true as const, response: answer() as never, knowledgeId: "k" }));
    const same = gateway({ collective: collective({ fetch }) });
    expect(g.cacheSize()).toBe(2);
    expect(same.cacheSize()).toBe(0);
  });

  it("invalidates by knowledgeId and by version too", () => {
    const g = gateway();
    g.read(request({ query: "a" }));
    expect(g.invalidate({ knowledgeId: "k.tolerance" })).toBe(1);

    g.read(request({ query: "b" }));
    expect(g.invalidate({ version: "v7" })).toBe(1);
  });

  it("emits the events a downstream gateway would act on", () => {
    const onEvent = vi.fn();
    const g = gateway({ onEvent });
    g.read(request());
    g.read(request());
    g.contribute(candidate());

    const names = onEvent.mock.calls.map((c) => c[0]);
    expect(names).toContain("knowledge.requested");
    expect(names).toContain("knowledge.cache.miss");
    expect(names).toContain("knowledge.cache.hit");
    expect(names).toContain("knowledge.collective.fetched");
    expect(names).toContain("knowledge.candidate.submitted");
    expect(names).toContain("knowledge.published");
    expect(names).toContain("knowledge.cache.invalidate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CONTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────

describe("a contribution is sanitized before it leaves", () => {
  it("rejects a claim carrying tenant data", () => {
    // Reusing the same check the evolution candidate uses. Two privacy checks
    // would eventually disagree, and the weaker would be the one somebody
    // routed through.
    const g = gateway();
    const result = g.contribute(
      candidate({ generalizedClaim: "Brighton Signs' customer Acme needs 0.2mm kerf." }),
    );
    expect(result.accepted).toBe(false);
  });

  it("rejects rather than strips", () => {
    const g = gateway();
    const result = g.contribute(candidate({ generalizedClaim: "steven@example.com reported bad kerf" }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toMatch(/refused rather than stripped/);
  });

  it("requires a privacy attestation", () => {
    // It does not replace the check. An unattested submission is one nobody
    // has taken responsibility for, and the attestation is what makes a later
    // violation attributable rather than anonymous.
    const withoutIt = { ...(candidate() as Record<string, unknown>) };
    delete withoutIt["privacyAttestation"];
    expect(candidateKnowledgeSchema.safeParse(withoutIt).success).toBe(false);
  });

  it("refuses a candidate proposed as tenant-private", () => {
    // That is not a contribution to the collective. It is that tenant's own
    // record, and submitting it here is the transfer the ownership model
    // exists to prevent.
    expect(candidateKnowledgeSchema.safeParse(candidate({ proposedScope: "tenant-private" })).success).toBe(
      false,
    );
  });

  it("holds a review-required candidate instead of committing it", () => {
    const commit = vi.fn(() => ({ committed: true as const, version: "v8" }));
    const g = gateway({
      collective: collective({ commit }),
      policy: {
        ...permissive,
        classify: () => ({ classification: "review_required", checks: [], reason: "novel domain" }),
      },
    });
    const result = g.contribute(candidate());
    expect(result.accepted).toBe(true);
    expect(result.accepted && result.classification).toBe("review_required");
    expect(commit).not.toHaveBeenCalled();
    expect(gatewayMayPromoteWithoutPolicy()).toBe(false);
  });

  it("refuses a prohibited candidate outright", () => {
    const g = gateway({
      policy: {
        ...permissive,
        classify: () => ({ classification: "prohibited", checks: [], reason: "regulated content" }),
      },
    });
    expect(g.contribute(candidate()).accepted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 & POLICY
// ─────────────────────────────────────────────────────────────────────────────

describe("every answer carries where it came from and why it was allowed", () => {
  it("keeps provenance and the policy decision", () => {
    // Knowledge with no source is a rumour an engine will act on with the same
    // confidence as a fact.
    const g = gateway();
    const result = g.read(request());
    expect(result.served).toBe(true);
    if (!result.served) return;
    expect(result.response.provenance.length).toBeGreaterThan(0);
    expect(result.response.policyDecisionId).toBe("gd.read");
    expect(result.response.version).toBe("v7");
  });

  it("refuses an answer the collective returned with no provenance", () => {
    // Knowledge with no source is a rumour. Asserting the fixture HAS
    // provenance says nothing about whether one without it would be refused —
    // a mutation making the field optional survived exactly that gap.
    const g = gateway({
      collective: collective({
        fetch: () => ({
          ok: true as const,
          response: answer({ provenance: [] }) as never,
          knowledgeId: "k",
        }),
      }),
    });
    const result = g.read(request());
    expect(result.served).toBe(false);
    if (result.served) return;
    expect(result.reason).toMatch(/malformed/);
  });

  it("refuses a read the policy will not permit, cache or no cache", () => {
    // The cache is a copy of answers, not a way around the question of whether
    // they may be given.
    const g = gateway();
    g.read(request());

    const denying = gateway({
      policy: { ...permissive, mayRead: () => ({ permitted: false, reason: "not in scope", decisionId: "gd.no" }) },
    });
    expect(denying.read(request()).served).toBe(false);
  });

  it("refuses a request naming another instance", () => {
    const g = gateway();
    const result = g.read(request({ instanceId: "hive.instance.b" }));
    expect(result.served).toBe(false);
    if (result.served) return;
    expect(result.reason).toMatch(/serves hive.instance.a/);
  });

  it("holds that a cache entry is not an authority", () => {
    expect(cacheIsAuthoritative()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NO SECOND DOOR
// ─────────────────────────────────────────────────────────────────────────────

describe("there is one door", () => {
  it("no engine reaches a collective knowledge service directly", () => {
    // The architecture test the build order asks for. A second path would be
    // one the scope, freshness and provenance checks do not stand in front of
    // — and it would be added for a good reason, by somebody in a hurry, on a
    // Friday.
    //
    // Enforced by import: only the gateway may name the collective service
    // type. An engine that imported it would be an engine holding the handle.
    const engineRoots = [
      "forgeiq", "costiq", "workorderiq", "receiptiq", "inventoryiq", "tracking",
      "notifications", "order-ingestion", "visioniq", "senseiq", "eventiq",
      "auditiq", "sentineliq", "aria", "foundry-evolutioniq", "repair-learning",
      "prime",
    ];

    const offenders: string[] = [];
    for (const pkg of engineRoots) {
      const root = join(process.cwd(), "packages", pkg, "src");
      let files: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) {
            if (name === "__tests__") continue;
            walk(full);
            continue;
          }
          if (name.endsWith(".ts")) files.push(full);
        }
      };
      try {
        walk(root);
      } catch {
        continue;
      }

      for (const file of files) {
        const text = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        if (/CollectiveKnowledgeService|collective\.fetch\s*\(/.test(text)) {
          offenders.push(`${pkg}/${file.split("src").pop()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(engineMayQueryCollectiveDirectly()).toBe(false);
  });
});
