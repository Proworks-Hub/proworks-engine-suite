// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHIELD_LADDER,
  disruptionOf,
  grantExpandsConstitutionalAuthority,
  grantPermits,
  externalSecurityGrantSchema,
  securityHandshakeSchema,
  shieldActsWithoutGrant,
  stricterOf,
  type ExternalSecurityGrant,
} from "@proworks-hub/contracts";
import {
  createInMemoryShieldStore,
  createSecurityCore,
  createSentinelShield,
  performExternalAction,
  shieldIsASecondSecurityEngine,
  type BoundaryObservation,
  type CryptoProvider,
  type ExternalSecurityProvider,
  type ShieldPolicy,
} from "@proworks-hub/platform-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// SENTINEL SHIELD — the eight acceptance tests the directive names:
//
//   1. A compromised host credential cannot exceed its grant.
//   2. A compromised host cannot pivot into another instance through an
//      unrelated Instance Link.
//   3. Revoking a grant immediately prevents further external actions.
//   4. The Shield cannot call an external action that is not explicitly
//      granted.
//   5. A stricter healthcare profile causes stronger rules than a public
//      website profile.
//   6. The handshake shares no tenant payload and rejects unhealthy peers.
//   7. Every response is auditable: actor, rule, evidence, action, authority.
//   8. Raw incident logs are not promoted to collective knowledge.
//
// THE TEMPTATION THIS BOUNDARY EXISTS TO REFUSE: the Hive can see suspicious
// traffic and the host has a WAF, so why not block? Because that is an
// autonomous system taking enforcement action inside somebody else's
// infrastructure on its own reading of the evidence, and the first false
// positive is their storefront going down because a machine decided.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = "hive.ksix";
const OTHER = "hive.proworks";
let clock = Date.parse("2026-08-30T12:00:00.000Z");
const now = () => new Date(clock);

beforeEach(() => {
  clock = Date.parse("2026-08-30T12:00:00.000Z");
});

const crypto: CryptoProvider = {
  profile: {
    profileVersion: "crypto.v1",
    signatureAlgorithm: "ed25519",
    transportRequirement: "mtls",
    endToEndPayloadEncryption: false,
    requiresHardwareAttestation: false,
    maxCredentialLifetimeSeconds: 3600,
  },
  issueKey: (id) => ({ keyRef: `key:${id.workloadId}` }),
  verify: () => ({ valid: true, reason: "ok" }),
};

const securityCore = () => createSecurityCore({ instanceId: INSTANCE, crypto, now });

const policy = (over: Partial<ShieldPolicy> = {}): ShieldPolicy => ({
  hiveResponse: (o) => {
    const worst = Math.max(0, ...o.signals.map((s) => s.severity));
    if (worst >= 0.9) return { response: "quarantine", reason: "severe anomaly" };
    if (worst >= 0.6) return { response: "block", reason: "significant anomaly" };
    if (worst >= 0.3) return { response: "throttle", reason: "elevated rate" };
    return { response: "observe", reason: "within normal range" };
  },
  ...over,
});

const shield = (over: Record<string, unknown> = {}) =>
  createSentinelShield({
    instanceId: INSTANCE,
    securityCore: securityCore(),
    policy: policy(),
    now,
    ...over,
  });

const observation = (over: Partial<BoundaryObservation> = {}): BoundaryObservation => ({
  boundary: "host_to_instance",
  subjectId: "connector.website",
  resource: "waf://ksixdesigns.com",
  signals: [{ signal: "request_rate", severity: 0.4, evidenceRef: "tel:rate-1" }],
  observedAt: "2026-08-30T12:00:00.000Z",
  ...over,
});

const grant = (over: Record<string, unknown> = {}) => ({
  grantId: "grant.ksix.website",
  hostSystemId: "host.ksixdesigns",
  hiveInstanceId: INSTANCE,
  allowedSignals: ["request_rate", "auth_anomaly"],
  allowedActions: ["block_ip"],
  resourceScopes: ["waf://ksixdesigns.com"],
  purpose: "protect the storefront from credential stuffing",
  securityProviderRefs: ["provider.cloudwaf"],
  issuedBy: "host-admin@ksixdesigns.example",
  approvedAt: "2026-08-01T00:00:00.000Z",
  revocationEndpoint: "https://ksixdesigns.example/hive/revoke",
  policyVersion: "host.v1",
  auditDestination: "siem://ksixdesigns",
  ...over,
});

const provider = (over: Partial<ExternalSecurityProvider> = {}): ExternalSecurityProvider => ({
  providerId: "provider.cloudwaf",
  perform: () => ({ performed: true, reason: "rule applied" }),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 & 3. JURISDICTION
// ─────────────────────────────────────────────────────────────────────────────

describe("the Hive does not act inside somebody else's system uninvited", () => {
  it("performs nothing without a grant", () => {
    // Absent is the default, not a setting somebody has to choose.
    const result = performExternalAction({
      grant: null,
      provider: provider(),
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      hiveInstanceId: INSTANCE,
      reason: "credential stuffing",
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(result.performed).toBe(false);
    expect(result.reason).toMatch(/absent is the default, not a setting/);
    expect(shieldActsWithoutGrant()).toBe(false);
  });

  it("performs a granted action", () => {
    const perform = vi.fn(() => ({ performed: true, reason: "rule applied" }));
    const result = performExternalAction({
      grant: externalSecurityGrantSchema.parse(grant()),
      provider: provider({ perform }),
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      hiveInstanceId: INSTANCE,
      reason: "credential stuffing",
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(result.performed).toBe(true);
    expect(perform).toHaveBeenCalledOnce();
  });

  it("refuses an action the grant does not name", () => {
    // A host authorizes specific actions, not a category of helpfulness.
    const result = performExternalAction({
      grant: externalSecurityGrantSchema.parse(grant()),
      provider: provider(),
      action: "revoke_host_session",
      resource: "waf://ksixdesigns.com",
      hiveInstanceId: INSTANCE,
      reason: "r",
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(result.performed).toBe(false);
    expect(result.reason).toMatch(/not a category of helpfulness/);
  });

  it("refuses a resource the grant does not cover", () => {
    const result = performExternalAction({
      grant: externalSecurityGrantSchema.parse(grant()),
      provider: provider(),
      action: "block_ip",
      resource: "waf://someone-elses-site.com",
      hiveInstanceId: INSTANCE,
      reason: "r",
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(result.performed).toBe(false);
  });

  it("stops immediately on revocation, through the shield's own store", () => {
    // Exercised through `performExternal` rather than by handing a revoked
    // grant object to the helper. A mutation found why that matters: with the
    // grant passed in, `acceptGrant` and `revokeGrant` were writing to a map
    // nothing read, so revocation was effective only for callers who happened
    // to re-read the grant themselves.
    const s = shield({ providers: [provider()] });
    s.acceptGrant(grant());

    const before = s.performExternal({
      grantId: "grant.ksix.website",
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      reason: "credential stuffing",
    });
    expect(before.performed).toBe(true);

    expect(s.revokeGrant("grant.ksix.website", "contract ended").revoked).toBe(true);

    const after = s.performExternal({
      grantId: "grant.ksix.website",
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      reason: "credential stuffing",
    });
    expect(after.performed).toBe(false);
    expect(after.reason).toMatch(/contract ended/);
  });

  it("refuses an expired grant, separately from a revoked one", () => {
    // An expiry that nobody enforces makes every grant permanent. Tested
    // without a revocation so the expiry check is the only thing that can
    // refuse it.
    const verdict = grantPermits({
      grant: externalSecurityGrantSchema.parse({
        ...grant(),
        expiresAt: "2026-08-01T00:00:00.000Z",
      }),
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      hiveInstanceId: INSTANCE,
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/expired at/);
  });

  it("permits an unexpired grant, so the expiry check is not vacuous", () => {
    expect(
      grantPermits({
        grant: externalSecurityGrantSchema.parse({
          ...grant(),
          expiresAt: "2027-01-01T00:00:00.000Z",
        }),
        action: "block_ip",
        resource: "waf://ksixdesigns.com",
        hiveInstanceId: INSTANCE,
        now: "2026-08-30T12:00:00.000Z",
      }).permitted,
    ).toBe(true);
  });

  it("refuses a grant this shield never accepted", () => {
    const s = shield({ providers: [provider()] });
    expect(
      s.performExternal({
        grantId: "grant.never-seen",
        action: "block_ip",
        resource: "waf://ksixdesigns.com",
        reason: "r",
      }).performed,
    ).toBe(false);
  });

  it("says revoked rather than expired when it was withdrawn", () => {
    // Revocation is checked before expiry so a withdrawal is not reported as a
    // lapse — they call for different responses from the host.
    const verdict = grantPermits({
      grant: externalSecurityGrantSchema.parse({
        ...grant(),
        expiresAt: "2026-01-01T00:00:00.000Z",
        revokedAt: "2026-02-01T00:00:00.000Z",
        revocationReason: "withdrawn by the host",
      }),
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      hiveInstanceId: INSTANCE,
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(verdict.reason).toMatch(/withdrawn by the host/);
  });

  it("requires a revocation endpoint on every grant", () => {
    // A grant somebody cannot withdraw is not a grant, it is a transfer.
    const without = { ...grant() } as Record<string, unknown>;
    delete without["revocationEndpoint"];
    expect(externalSecurityGrantSchema.safeParse(without).success).toBe(false);
  });

  it("refuses a grant issued to a different instance", () => {
    const s = shield();
    const result = s.acceptGrant(grant({ hiveInstanceId: OTHER }));
    expect(result.accepted).toBe(false);
  });

  it("does not let a host's grant widen constitutional authority", () => {
    // A host cannot authorize bypassing Governance or widening a tenant
    // boundary; those are not theirs to give. The grant shape has no field
    // that could express it.
    const parsed = externalSecurityGrantSchema.parse(grant());
    const asText = JSON.stringify(parsed);
    for (const forbidden of ["bypassGovernance", "tenantOverride", "constitutional"]) {
      expect(asText).not.toContain(forbidden);
    }
    expect(grantExpandsConstitutionalAuthority()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. STRICTER WINS
// ─────────────────────────────────────────────────────────────────────────────

describe("two policies compose to the stricter one", () => {
  it("orders the ladder from gentlest to most disruptive", () => {
    expect(SHIELD_LADDER[0]).toBe("observe");
    expect(SHIELD_LADDER.at(-1)).toBe("escalate");
    expect(disruptionOf("observe")).toBeLessThan(disruptionOf("block"));
    expect(disruptionOf("block")).toBeLessThan(disruptionOf("quarantine"));
  });

  it("puts escalate above quarantine", () => {
    // Involving a person is the most disruptive thing available and also the
    // safest. A composition treating it as weaker would silently prefer
    // machine action over judgement.
    expect(stricterOf("quarantine", "escalate")).toBe("escalate");
  });

  it("takes the host's response when it is stricter", () => {
    // A healthcare host demanding quarantine where the Hive would only
    // throttle.
    const s = shield({
      policy: policy({
        hostResponse: () => ({ response: "quarantine", reason: "regulated data path" }),
      }),
    });
    const decision = s.evaluate(observation());
    expect(decision.response).toBe("quarantine");
    expect(decision.source).toBe("host");
  });

  it("takes the Hive's response when it is stricter", () => {
    const s = shield({
      policy: policy({ hostResponse: () => ({ response: "observe", reason: "host is relaxed" }) }),
    });
    const decision = s.evaluate(
      observation({ signals: [{ signal: "auth_anomaly", severity: 0.95, evidenceRef: "e" }] }),
    );
    expect(decision.response).toBe("quarantine");
    expect(decision.source).toBe("hive");
  });

  it("does not treat an absent host opinion as permission", () => {
    // A host that has expressed no opinion is not a host saying "allow", which
    // is why the policy returns null rather than the gentlest rung.
    //
    // The `source` is what distinguishes the two: with no host policy the
    // decision is the Hive's alone, and defaulting the absent opinion to
    // `observe` would report it as agreement between two parties when only one
    // spoke. A mutation doing exactly that survived until this assertion.
    const s = shield();
    const benign = s.evaluate(
      observation({ signals: [{ signal: "request_rate", severity: 0.1, evidenceRef: "e" }] }),
    );
    expect(benign.response).toBe("observe");
    expect(benign.source).toBe("hive");

    const serious = s.evaluate(
      observation({ signals: [{ signal: "auth_anomaly", severity: 0.7, evidenceRef: "e" }] }),
    );
    expect(serious.response).toBe("block");
    expect(serious.source).toBe("hive");
  });

  it("gives a public site a gentler outcome than a regulated one, from the same signal", () => {
    const signals = [{ signal: "request_rate", severity: 0.4, evidenceRef: "e" }];
    const publicSite = shield().evaluate(observation({ signals }));
    const regulated = shield({
      policy: policy({
        hostResponse: () => ({ response: "block", reason: "regulated profile" }),
      }),
    }).evaluate(observation({ signals }));

    expect(publicSite.response).toBe("throttle");
    expect(regulated.response).toBe("block");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 2. COMPROMISE AND PIVOT
// ─────────────────────────────────────────────────────────────────────────────

describe("a compromised host stays one compromised host", () => {
  it("quarantines through Security Core rather than on its own", () => {
    // The Shield is the thing that noticed, not the authority. Containment
    // goes through the core, which requires a named authorizer.
    const core = securityCore();
    const s = createSentinelShield({ instanceId: INSTANCE, securityCore: core, policy: policy(), now });

    const decision = s.evaluate(
      observation({ signals: [{ signal: "auth_anomaly", severity: 0.95, evidenceRef: "e" }] }),
    );
    expect(decision.response).toBe("quarantine");
    expect(decision.applied.containment).toBe("revoke_access");
    expect(core.contained()).toHaveLength(1);
  });

  it("maps the boundary to the right containment", () => {
    // An interconnect problem isolates the integration; a collective one
    // restricts data movement. Using one primitive everywhere would make every
    // incident look the same to whoever reads the audit later.
    const core = securityCore();
    const s = createSentinelShield({ instanceId: INSTANCE, securityCore: core, policy: policy(), now });
    const severe = [{ signal: "route_probing", severity: 0.95, evidenceRef: "e" }];

    s.evaluate(observation({ boundary: "instance_to_instance", signals: severe }));
    s.evaluate(observation({ boundary: "instance_to_collective", signals: severe }));

    expect(core.contained().map((c) => c.primitive)).toEqual([
      "isolate_integration",
      "restrict_data_movement",
    ]);
  });

  it("holds no identity or key material of its own", () => {
    // The directive's own instruction: an adapter over Security Core, not a
    // second identity or enforcement stack.
    const s = shield();
    for (const forbidden of ["issue", "revoke", "verifyFor", "credentialsFor", "assess"]) {
      expect(Object.keys(s)).not.toContain(forbidden);
    }
    expect(shieldIsASecondSecurityEngine()).toBe(false);
  });

  it("cannot pivot into another instance through an unrelated link", () => {
    // A grant names ONE hive instance. A host compromised at KSix holds
    // nothing that names ProWorks, and `grantPermits` refuses on the instance
    // before it looks at anything else.
    const verdict = grantPermits({
      grant: externalSecurityGrantSchema.parse(grant()),
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      hiveInstanceId: OTHER,
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/is not permission to another/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE HANDSHAKE
// ─────────────────────────────────────────────────────────────────────────────

describe("the handshake exchanges trust metadata and nothing else", () => {
  it("has no field that could carry a payload", () => {
    // A handshake carrying tenant data would be a transfer happening before
    // the checks that decide whether a transfer may happen.
    const h = shield().handshake();
    for (const forbidden of ["payload", "data", "body", "tenant", "records"]) {
      expect(Object.keys(h)).not.toContain(forbidden);
    }
    expect(securityHandshakeSchema.safeParse({ ...h, payload: { x: 1 } }).success).toBe(false);
  });

  it("rejects a peer whose certificate is revoked", () => {
    const s = shield();
    const result = s.acceptPeer({ ...s.handshake(), certificateHealth: "revoked" }, false);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/certificate is revoked/);
  });

  it("rejects a peer whose link is not active", () => {
    const s = shield();
    expect(s.acceptPeer({ ...s.handshake(), linkStatus: "suspended" }, false).accepted).toBe(false);
  });

  it("rejects a peer whose security core is unavailable", () => {
    // A peer that cannot enforce its own side of the boundary is a peer
    // accepting from nothing.
    const s = shield();
    expect(s.acceptPeer({ ...s.handshake(), securityCoreHealth: "unavailable" }, false).accepted).toBe(
      false,
    );
  });

  it("rejects an unattested peer when policy requires attestation", () => {
    const s = shield();
    const relaxed = s.acceptPeer({ ...s.handshake(), attestationState: "not_required" }, false);
    const strict = s.acceptPeer({ ...s.handshake(), attestationState: "not_required" }, true);
    expect(relaxed.accepted).toBe(true);
    expect(strict.accepted).toBe(false);
  });

  it("accepts a healthy attested peer, so the refusals are not vacuous", () => {
    const s = shield();
    expect(s.acceptPeer({ ...s.handshake(), attestationState: "attested" }, true).accepted).toBe(true);
  });

  it("reports its own degradation honestly", () => {
    const core = securityCore();
    const s = createSentinelShield({ instanceId: INSTANCE, securityCore: core, policy: policy(), now });
    expect(s.handshake().sentinelHealth).toBe("healthy");

    core.contain({
      primitive: "quarantine_engine",
      subjectId: "x",
      reason: "r",
      authorizedBy: "sentinel",
      authorizationRef: "gd.1",
    });
    expect(s.handshake().sentinelHealth).toBe("degraded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 & 8. AUDIT AND LEARNING
// ─────────────────────────────────────────────────────────────────────────────

describe("every response is explicable afterwards", () => {
  it("records actor, rule, evidence, action and authority", () => {
    const s = shield();
    s.evaluate(
      observation({ signals: [{ signal: "auth_anomaly", severity: 0.95, evidenceRef: "tel:auth-7" }] }),
    );
    const [entry] = s.audit();
    expect(entry?.subjectId).toBe("connector.website");
    expect(entry?.reason).toMatch(/severe anomaly/);
    expect(entry?.evidenceRefs).toEqual(["tel:auth-7"]);
    expect(entry?.response).toBe("quarantine");
    expect(entry?.authorityRef).toBeTruthy();
  });

  it("records observations that changed nothing", () => {
    // A boundary that only logged the interesting decisions could not answer
    // "was this being watched at all".
    const s = shield();
    s.evaluate(observation({ signals: [{ signal: "request_rate", severity: 0.1, evidenceRef: "e" }] }));
    expect(s.audit()).toHaveLength(1);
    expect(s.audit()[0]?.response).toBe("observe");
  });

  it("takes no action when escalating", () => {
    // An escalation is a package for a person. Acting and escalating at once
    // would make the human decision retrospective.
    const onEscalation = vi.fn();
    const core = securityCore();
    const s = createSentinelShield({
      instanceId: INSTANCE,
      securityCore: core,
      policy: policy({ hiveResponse: () => ({ response: "escalate", reason: "needs a person" }) }),
      now,
      onEscalation,
    });
    const decision = s.evaluate(observation());
    expect(decision.applied.escalated).toBe(true);
    expect(decision.applied.containment).toBeUndefined();
    expect(core.contained()).toHaveLength(0);
    expect(onEscalation).toHaveBeenCalledOnce();
  });

  it("keeps raw evidence out of the audit, carrying references instead", () => {
    // Raw incident logs stay local. What the audit holds is a locator, which
    // is what makes it safe to escalate or share later.
    const s = shield();
    s.evaluate(
      observation({
        signals: [{ signal: "payload_deviation", severity: 0.7, evidenceRef: "tel:req-9" }],
      }),
    );
    const asText = JSON.stringify(s.audit());
    expect(asText).toContain("tel:req-9");
    expect(asText).not.toMatch(/password|cardNumber|ssn/i);
  });
});

describe("a restart does not restore what a host withdrew", () => {
  it("keeps a revoked grant revoked", () => {
    // The fourth time the durability guard has found this hole. A host that
    // withdrew the Hive's permission to touch their WAF must not find it
    // restored because a process came back up.
    const store = createInMemoryShieldStore();
    const before = shield({ store, providers: [provider()] });
    before.acceptGrant(grant());
    before.revokeGrant("grant.ksix.website", "contract ended");

    const after = shield({ store, providers: [provider()] });
    const result = after.performExternal({
      grantId: "grant.ksix.website",
      action: "block_ip",
      resource: "waf://ksixdesigns.com",
      reason: "r",
    });
    expect(result.performed).toBe(false);
    expect(result.reason).toMatch(/contract ended/);
  });

  it("keeps the audit trail", () => {
    // A security response nobody can explain afterwards is indistinguishable
    // from one nobody authorized.
    const store = createInMemoryShieldStore();
    shield({ store }).evaluate(observation());
    expect(shield({ store }).audit()).toHaveLength(1);
  });

  it("says which kind of store is bound", () => {
    expect(shield().durability()).toBe("in-memory");
  });
});
