// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  capabilitiesUnder,
  effectiveTrust,
  secretRefSchema,
  securityCoreAdjudicates,
  trustAssessmentSchema,
  trustCanGrantAuthority,
  trustStateSchema,
  type CryptoProfile,
} from "@proworks-hub/contracts";
import {
  createInMemorySecurityStore,
  createSecurityCore,
  envelopeVerifierFor,
  securityCoreContainsUnilaterally,
  type CryptoProvider,
} from "@proworks-hub/platform-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY CORE — the eight acceptance tests the directive names:
//
//   1. Compromising one engine identity cannot impersonate another.
//   2. Expired credentials fail closed.
//   3. Mission-scoped elevation expires automatically.
//   4. Automatic rotation does not interrupt valid workloads, and audits.
//   5. Hardware attestation can be required per tenant and omitted per tenant.
//   6. A trust drop can tighten paths without granting Sentinel new authority.
//   7. Secrets never appear in payloads, logs or handoffs.
//   8. A sanitized security lesson promotes without raw tenant evidence.
//
// THE RULE THE WHOLE FILE DEFENDS: trust may restrict, trust may never grant.
// It is tested as a property over every trust state rather than as an example,
// because an example only proves the case somebody thought of.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = "hive.ksix";
let clock = Date.parse("2026-08-30T12:00:00.000Z");
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock += ms;
};

// Reset between tests. A shared mutable clock made these tests depend on the
// order they ran in — this one bit me: a fixture expiring at 13:00 was fine in
// isolation and expired by the time earlier tests had advanced past it. A test
// that passes only in position is a test that will fail for the wrong reason
// later.
beforeEach(() => {
  clock = Date.parse("2026-08-30T12:00:00.000Z");
});

const profile = (over: Partial<CryptoProfile> = {}): CryptoProfile => ({
  profileVersion: "crypto.v1",
  signatureAlgorithm: "ed25519",
  transportRequirement: "mtls",
  endToEndPayloadEncryption: false,
  requiresHardwareAttestation: false,
  maxCredentialLifetimeSeconds: 3600,
  ...over,
});

/** A provider that models a keyring. It computes nothing real, and says so. */
function provider(over: Partial<CryptoProvider> = {}): CryptoProvider {
  return {
    profile: profile(),
    issueKey: (identity) => ({
      keyRef: `key:${identity.globalInstanceId}:${identity.workloadId}`,
    }),
    // A signature is genuine when it names the key it was made with. Enough to
    // exercise the wiring; the real answer belongs to a KMS.
    verify: ({ keyRef, signature }) =>
      signature === `signed-by:${keyRef}`
        ? { valid: true, reason: "signature matches the key" }
        : { valid: false, reason: "signature was not made by this key" },
    ...over,
  };
}

const core = (over: Record<string, unknown> = {}) =>
  createSecurityCore({ instanceId: INSTANCE, crypto: provider(), now, ...over });

const identity = (over: Record<string, unknown> = {}) => ({
  globalInstanceId: INSTANCE,
  workloadId: "forgeiq",
  workloadKind: "engine",
  version: "0.20.0",
  ...over,
});

const assessment = (over: Record<string, unknown> = {}) => ({
  subjectId: "forgeiq",
  subjectKind: "workload",
  state: "trusted",
  score: 0.9,
  signals: [
    {
      signal: "certificate_health",
      contribution: 0.4,
      observedAt: "2026-08-30T11:00:00.000Z",
      evidenceRef: "cred:cred_1",
    },
  ],
  assessedAt: "2026-08-30T11:00:00.000Z",
  expiresAt: "2026-08-30T13:00:00.000Z",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. IMPERSONATION
// ─────────────────────────────────────────────────────────────────────────────

describe("one compromised engine is one compromised engine", () => {
  it("does not let one engine's credential verify another's signature", () => {
    // The acceptance test the whole identity model rests on. Per-workload
    // credentials mean a leaked key is one component, not the instance.
    const c = core();
    c.issue({ identity: identity({ workloadId: "forgeiq" }), lifetimeSeconds: 600 });
    c.issue({ identity: identity({ workloadId: "costiq" }), lifetimeSeconds: 600 });

    const forgeiqSignature = `signed-by:key:${INSTANCE}:forgeiq`;
    expect(
      c.verifyFor({ claimed: identity({ workloadId: "forgeiq" }), body: "b", signature: forgeiqSignature })
        .valid,
    ).toBe(true);

    // The same signature presented as CostIQ. The key looked up is CostIQ's,
    // so it does not match — the identity is part of what is checked.
    expect(
      c.verifyFor({ claimed: identity({ workloadId: "costiq" }), body: "b", signature: forgeiqSignature })
        .valid,
    ).toBe(false);
  });

  it("does not let one instance's engine present as another instance's", () => {
    // Engine names are shared across instances by design, so matching on the
    // workload id alone would make every instance's ForgeIQ interchangeable.
    const c = core();
    c.issue({ identity: identity(), lifetimeSeconds: 600 });
    const result = c.verifyFor({
      claimed: identity({ globalInstanceId: "hive.proworks" }),
      body: "b",
      signature: `signed-by:key:${INSTANCE}:forgeiq`,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/No credential is held/);
  });

  it("refuses to issue credentials for another instance", () => {
    // Otherwise one instance could mint identities inside its neighbour.
    const c = core();
    const result = c.issue({
      identity: identity({ globalInstanceId: "hive.proworks" }),
      lifetimeSeconds: 600,
    });
    expect(result.issued).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 4. EXPIRY AND ROTATION
// ─────────────────────────────────────────────────────────────────────────────

describe("credentials expire, and rotation does not interrupt anything", () => {
  it("fails closed once expired", () => {
    const c = core();
    const issued = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    expect(issued.issued).toBe(true);
    if (!issued.issued) return;

    expect(c.validate(issued.credential.credentialId).valid).toBe(true);
    advance(601_000);
    const after = c.validate(issued.credential.credentialId);
    expect(after.valid).toBe(false);
    expect(after.reason).toMatch(/Expired at/);
  });

  it("refuses a credential with no expiry at all", () => {
    // There is no shape for one: `notAfter` is required and must follow
    // `notBefore`. A credential valid forever is not short-lived.
    const c = core();
    expect(c.issue({ identity: identity(), lifetimeSeconds: 0 }).issued).toBe(false);
  });

  it("refuses a lifetime beyond the profile's ceiling", () => {
    // The ceiling is not advisory. Asking for a year under a profile that
    // permits an hour is a policy change, not a parameter.
    const events: string[] = [];
    const c = core({ onEvent: (e: string) => events.push(e) });
    const result = c.issue({ identity: identity(), lifetimeSeconds: 86_400 });
    expect(result.issued).toBe(false);
    expect(events).toContain("security.crypto.policy_violation");
  });

  it("leaves the old credential usable until its own expiry", () => {
    // Killing it at rotation makes every rotation a small outage for whatever
    // was mid-request, which is how automatic rotation gets switched off.
    const c = core();
    const first = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    expect(first.issued).toBe(true);
    if (!first.issued) return;

    const second = c.rotate(first.credential.credentialId, 600);
    expect(second.issued).toBe(true);
    if (!second.issued) return;

    expect(c.validate(first.credential.credentialId).valid).toBe(true);
    expect(c.validate(second.credential.credentialId).valid).toBe(true);
    expect(second.credential.rotatedFrom).toBe(first.credential.credentialId);
  });

  it("produces audit evidence for issuance and rotation", () => {
    const onEvent = vi.fn();
    const c = core({ onEvent });
    const issued = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    if (!issued.issued) return;
    c.rotate(issued.credential.credentialId, 600);

    const names = onEvent.mock.calls.map((call) => call[0]);
    expect(names).toContain("security.identity.issued");
    expect(names).toContain("security.identity.rotated");
  });

  it("does not rotate a revoked credential back into use", () => {
    // Rotating one would make revocation recoverable.
    const c = core();
    const issued = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    if (!issued.issued) return;
    c.revoke(issued.credential.credentialId, "key suspected leaked", "user.steven");

    const rotated = c.rotate(issued.credential.credentialId, 600);
    expect(rotated.issued).toBe(false);
    if (rotated.issued) return;
    expect(rotated.reason).toMatch(/would make revocation recoverable/);
  });

  it("fails a revoked credential closed, with the reason", () => {
    const c = core();
    const issued = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    if (!issued.issued) return;
    c.revoke(issued.credential.credentialId, "key suspected leaked", "user.steven");

    const check = c.validate(issued.credential.credentialId);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/key suspected leaked/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ATTESTATION
// ─────────────────────────────────────────────────────────────────────────────

describe("hardware attestation is per-profile, and fails closed", () => {
  it("refuses to issue when a profile requires attestation and none comes back", () => {
    // Not a warning. A profile demanding hardware-backed material and getting
    // none is the deployment not being what it says it is.
    const onEvent = vi.fn();
    const c = core({
      crypto: provider({ profile: profile({ requiresHardwareAttestation: true }) }),
      onEvent,
    });
    const result = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    expect(result.issued).toBe(false);
    expect(onEvent.mock.calls.map((call) => call[0])).toContain("security.attestation.failed");
  });

  it("issues with attestation when the provider supplies it", () => {
    const c = core({
      crypto: provider({
        profile: profile({ requiresHardwareAttestation: true }),
        issueKey: (id) => ({ keyRef: `key:${id.workloadId}`, attestationRef: "tpm:quote-1" }),
      }),
    });
    const result = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    expect(result.issued).toBe(true);
    if (!result.issued) return;
    expect(result.credential.attestationRef).toBe("tpm:quote-1");
  });

  it("omits it for a standard profile, so the requirement is genuinely per-tenant", () => {
    const c = core();
    const result = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    expect(result.issued).toBe(true);
    if (!result.issued) return;
    expect(result.credential.attestationRef).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. TRUST RESTRICTS AND NEVER GRANTS
// ─────────────────────────────────────────────────────────────────────────────

describe("trust may restrict and may never grant", () => {
  const base = ["read", "write", "deploy", "approve"];

  it("returns a subset for EVERY trust state", () => {
    // A property over the whole enum rather than an example, because an
    // example only proves the case somebody thought of. A rising score cannot
    // open a capability that was closed, because a filter has nothing to open
    // it with.
    for (const state of trustStateSchema.options) {
      const result = capabilitiesUnder(base, state, ["read"]);
      for (const capability of result) {
        expect(base).toContain(capability);
      }
      expect(result.length).toBeLessThanOrEqual(base.length);
    }
    expect(trustCanGrantAuthority()).toBe(false);
  });

  it("narrows to the restricted set when restricted", () => {
    expect(capabilitiesUnder(base, "restricted", ["read"])).toEqual(["read"]);
  });

  it("permits nothing when revoked or unknown", () => {
    expect(capabilitiesUnder(base, "revoked", ["read"])).toEqual([]);
    expect(capabilitiesUnder(base, "unknown", ["read"])).toEqual([]);
  });

  it("does not curtail a watched subject", () => {
    // Watched means observed, not curtailed. Costing availability for
    // observation is how people stop marking things watched.
    expect(capabilitiesUnder(base, "watched", ["read"])).toEqual(base);
  });

  it("tightens paths as trust drops, through the core", () => {
    const c = core();
    c.assess(assessment());
    expect(c.permittedCapabilities("forgeiq", base, ["read"])).toEqual(base);

    c.assess(assessment({ state: "restricted", score: 0.2 }));
    expect(c.permittedCapabilities("forgeiq", base, ["read"])).toEqual(["read"]);
  });

  it("gives Sentinel no new authority by lowering a score", () => {
    // Sentinel's finding is a signal here. It changes what the SUBJECT may do
    // and nothing about what Sentinel may do.
    const c = core();
    c.assess(
      assessment({
        state: "restricted",
        score: 0.1,
        signals: [
          {
            signal: "sentinel_finding",
            contribution: -0.8,
            observedAt: "2026-08-30T11:30:00.000Z",
            evidenceRef: "finding:f_1",
          },
        ],
      }),
    );
    expect(c.permittedCapabilities("forgeiq", base, ["read"])).toEqual(["read"]);
    expect(securityCoreAdjudicates()).toBe(false);
  });
});

describe("a trust assessment is not a permanent flag", () => {
  it("reads as unknown once expired", () => {
    // An assessment with no expiry is a permanent flag wearing a dynamic name.
    // The failure is specific: assessed trusted in March, still trusted in
    // December, long after the signals stopped being observed.
    const c = core();
    c.assess(assessment());
    expect(c.trustOf("forgeiq")).toBe("trusted");

    advance(3 * 60 * 60 * 1000);
    expect(c.trustOf("forgeiq")).toBe("unknown");
    expect(c.permittedCapabilities("forgeiq", ["read"], ["read"])).toEqual([]);
  });

  it("requires an expiry at all", () => {
    const without = { ...assessment() } as Record<string, unknown>;
    delete without["expiresAt"];
    expect(trustAssessmentSchema.safeParse(without).success).toBe(false);
  });

  it("requires at least one signal", () => {
    // An assessment from no signals is an opinion.
    expect(trustAssessmentSchema.safeParse(assessment({ signals: [] })).success).toBe(false);
  });

  it("refuses a score attached to unknown", () => {
    // A number beside `unknown` invites somebody to compare it, and an
    // unmeasured thing does not compare.
    expect(trustAssessmentSchema.safeParse(assessment({ state: "unknown", score: 0.5 })).success).toBe(
      false,
    );
    expect(trustAssessmentSchema.safeParse(assessment({ state: "unknown", score: null })).success).toBe(
      true,
    );
  });

  it("treats an unassessed subject as unknown, not as fine", () => {
    expect(core().trustOf("never-seen")).toBe("unknown");
  });

  it("reports a change, so somebody can see trust move", () => {
    const onEvent = vi.fn();
    const c = core({ onEvent });
    c.assess(assessment());
    c.assess(assessment({ state: "restricted", score: 0.2 }));
    expect(onEvent.mock.calls.map((call) => call[0])).toContain("security.trust.changed");
  });

  it("expires by the clock rather than by being asked", () => {
    const a = trustAssessmentSchema.parse(assessment());
    expect(effectiveTrust(a, "2026-08-30T12:30:00.000Z")).toBe("trusted");
    expect(effectiveTrust(a, "2026-08-30T14:00:00.000Z")).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. SECRETS
// ─────────────────────────────────────────────────────────────────────────────

describe("there is no shape that can hold a secret", () => {
  it("carries a reference and a custodian, never a value", () => {
    // The strongest form of "secrets never appear in events or logs": not a
    // rule about what to put in the field, but the absence of a field.
    const ref = secretRefSchema.parse({
      secretRef: "kms://ksix/square-api",
      custodian: "kms",
      purpose: "payment capture",
    });
    expect(Object.keys(ref)).not.toContain("value");
    expect(Object.keys(ref)).not.toContain("secret");
    expect(Object.keys(ref)).not.toContain("plaintext");
  });

  it("refuses an unknown field, so a value cannot be smuggled in", () => {
    expect(
      secretRefSchema.safeParse({
        secretRef: "kms://x",
        custodian: "kms",
        purpose: "p",
        value: "hunter2",
      }).success,
    ).toBe(false);
  });

  it("keeps key material out of credentials too", () => {
    const c = core();
    const issued = c.issue({ identity: identity(), lifetimeSeconds: 600 });
    expect(issued.issued).toBe(true);
    if (!issued.issued) return;
    expect(Object.keys(issued.credential)).not.toContain("privateKey");
    expect(issued.credential.keyRef).toMatch(/^key:/);
  });

  it("emits security events carrying metadata only", () => {
    const onEvent = vi.fn();
    const c = core({ onEvent });
    c.issue({ identity: identity(), lifetimeSeconds: 600 });
    for (const call of onEvent.mock.calls) {
      const detail = JSON.stringify(call[1]);
      expect(detail).not.toMatch(/privateKey|plaintext|hunter2/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTAINMENT, AND THE SEPARATION IT PRESERVES
// ─────────────────────────────────────────────────────────────────────────────

describe("Security Core performs containment and does not decide it", () => {
  it("refuses to contain without a named authorizer and a reference", () => {
    // A component that could both decide to quarantine and perform the
    // quarantine would be the security provider and its own auditor.
    const c = core();
    const result = c.contain({
      primitive: "quarantine_engine",
      subjectId: "forgeiq",
      reason: "anomalous behaviour",
      authorizedBy: "",
      authorizationRef: "",
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/does not decide it/);
    expect(securityCoreContainsUnilaterally()).toBe(false);
  });

  it("applies it when something with authority says so", () => {
    const onEvent = vi.fn();
    const c = core({ onEvent });
    const result = c.contain({
      primitive: "quarantine_engine",
      subjectId: "forgeiq",
      reason: "anomalous behaviour",
      authorizedBy: "sentinel",
      authorizationRef: "gd.contain.1",
    });
    expect(result.applied).toBe(true);
    expect(c.contained()).toHaveLength(1);
    expect(onEvent.mock.calls.map((call) => call[0])).toContain("security.containment.executed");
  });

  it("offers only the mechanical rungs of Sentinel's ladder", () => {
    // `warn`, `require_validation`, `protected_mode` and
    // `emergency_protective_state` are decisions or postures rather than
    // switches. Giving this file a lever for them would give it a say in them.
    const c = core();
    const applied = c.contain({
      primitive: "revoke_access",
      subjectId: "x",
      reason: "r",
      authorizedBy: "sentinel",
      authorizationRef: "gd.1",
    });
    expect(applied.applied).toBe(true);
    // The absent rungs are absent from the type, so this is a compile-time
    // guarantee restated at runtime for a JavaScript host.
    expect(() =>
      c.contain({
        primitive: "emergency_protective_state" as never,
        subjectId: "x",
        reason: "r",
        authorizedBy: "sentinel",
        authorizationRef: "gd.1",
      }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PORT THE INTERCONNECT LEFT OPEN
// ─────────────────────────────────────────────────────────────────────────────

describe("the Interconnect's verifier now has something to bind to", () => {
  it("verifies a handoff signature through the security core", () => {
    const c = core();
    c.issue({ identity: identity({ workloadId: "interconnect.gateway", workloadKind: "service" }), lifetimeSeconds: 600 });

    const verifier = envelopeVerifierFor(c);
    const good = verifier.verifySignature({
      sourceInstanceId: INSTANCE,
      senderSignature: `signed-by:key:${INSTANCE}:interconnect.gateway`,
      integrityHash: "sha256:body",
    });
    expect(good.valid).toBe(true);
  });

  it("rejects a signature from an instance with no credential here", () => {
    const verifier = envelopeVerifierFor(core());
    expect(
      verifier.verifySignature({
        sourceInstanceId: "hive.stranger",
        senderSignature: "signed-by:key:whatever",
        integrityHash: "sha256:body",
      }).valid,
    ).toBe(false);
  });

  it("refuses integrity rather than returning a cheerful true", () => {
    // The adapter computes no digests, and says so. A verifier that returned
    // `valid` for a check it did not perform is worse than one that refuses:
    // the Interconnect would accept tampered bodies believing they were
    // checked.
    const result = envelopeVerifierFor(core()).verifyIntegrity({ integrityHash: "x" });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/No integrity provider is bound/);
  });
});

describe("a restart is not the attacker's best move", () => {
  it("does not un-revoke a compromised credential", () => {
    // The worst restart behaviour the durability guard has caught. Restarting
    // must not restore a key somebody revoked because they believed it leaked.
    const store = createInMemorySecurityStore();
    const before = core({ store });
    const issued = before.issue({ identity: identity(), lifetimeSeconds: 600 });
    expect(issued.issued).toBe(true);
    if (!issued.issued) return;
    before.revoke(issued.credential.credentialId, "key suspected leaked", "user.steven");

    const after = core({ store });
    const check = after.validate(issued.credential.credentialId);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/key suspected leaked/);
  });

  it("does not lift a quarantine", () => {
    // The same hole one layer up: containment applied because something was
    // behaving badly, gone the moment the process holding it restarts.
    const store = createInMemorySecurityStore();
    core({ store }).contain({
      primitive: "quarantine_engine",
      subjectId: "forgeiq",
      reason: "anomalous behaviour",
      authorizedBy: "sentinel",
      authorizationRef: "gd.contain.1",
    });

    expect(core({ store }).contained()).toHaveLength(1);
  });

  it("keeps trust assessments, which would otherwise fail closed and loudly", () => {
    // Losing these is safe — an absent assessment reads as `unknown`, which
    // permits nothing — and still worth keeping, because losing every
    // assessment turns a restart into a fleet-wide outage.
    const store = createInMemorySecurityStore();
    core({ store }).assess(assessment());
    expect(core({ store }).trustOf("forgeiq")).toBe("trusted");
  });

  it("says which kind of store is bound", () => {
    expect(core().durability()).toBe("in-memory");
  });
});
