// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  createDenyAllGovernance,
  permissionGrantSchema,
  requestContextSchema,
  type Governance,
  type InstanceIdentity,
  type PermissionGrant,
  type Principal,
  type RequestContext,
} from "@proworks-hub/contracts";
import { createGovernanceEngine } from "@proworks-hub/governance-engine";
import {
  createInstanceAdmission,
  evidenceAdmitsWithoutGovernance,
  trustCrossesInstances,
  type AdmissionResult,
} from "@proworks-hub/platform-runtime";
import { createInMemoryWorkflowStateStore, createPrime } from "@proworks-hub/prime";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1B — the identity boundary, proven through a real runtime path.
//
// Phase 1 proved the rule refuses correctly in isolation. That is not the same
// claim as "the boundary runs", and the gap between those two is where the
// seven declared-but-unread fields in this repository lived.
//
// So this file drives the whole chain with nothing stubbed in the middle:
//
//   RequestContext            the boundary shape hosts already build
//     → principal resolution  one resolution, validated
//     → instance identity     the host's, never the request's
//     → trust resolution      unknown unless a source says otherwise
//     → grant evidence        evaluatePermission
//     → Authorizer seam       requirePermission, which throws
//     → Governance            a REAL policy engine, not an allow-all
//     → authorizationRef      the decision id, obtainable no other way
//     → Prime                 runner + Nexus + a bound engine port
//     → the engine runs       an actual effect, asserted
//
// The Governance below is `createGovernanceEngine` with a written policy. An
// allow-all would have made every denial test pass for the wrong reason, and
// the valid path prove nothing about whether Governance was consulted at all.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE_A: InstanceIdentity = {
  globalInstanceId: "hive.ksix.us-east",
  trustAnchorId: "anchor.ksix",
  provisional: false,
};
const INSTANCE_B: InstanceIdentity = {
  globalInstanceId: "hive.proworks.us-east",
  trustAnchorId: "anchor.proworks",
  provisional: false,
};

const NOW = new Date("2026-08-29T12:00:00.000Z");

/** A real policy. Narrow on every dimension the schema offers. */
function governance(): Governance {
  return createGovernanceEngine({
    now: () => NOW,
    policy: {
      policyId: "policy.ksix.intake",
      version: "1",
      protections: [],
      grants: [
        {
          grantId: "policy.workorder.create",
          reason: "The shop owner may open work orders for their own shop.",
          actors: ["user.steven"],
          actions: ["work_order.create"],
          tenants: ["ksix"],
          purposes: ["customer_order_intake"],
          maxRiskClass: "routine",
          conditions: [],
        },
      ],
    },
  });
}

const context = (over: Record<string, unknown> = {}): RequestContext =>
  requestContextSchema.parse({
    requestId: "req.1",
    tenant: { organizationId: "ksix", roles: ["owner"] },
    identity: {
      subject: "user.steven",
      kind: "user",
      roles: ["owner"],
      assertedCapabilities: [],
    },
    trace: { correlationId: "corr.1" },
    receivedAt: NOW.toISOString(),
    ...over,
  });

const grant = (over: Partial<PermissionGrant> = {}): PermissionGrant =>
  permissionGrantSchema.parse({
    grantId: "grant.workorder.create",
    principalId: "user.steven",
    principalKind: "human",
    resource: "work_order",
    action: "work_order.create",
    tenantId: "ksix",
    ...over,
  });

/**
 * The policy Prime's runner is held to, which is NOT the one above.
 *
 * Discovered by this test failing: admission authorizes the REQUEST, and then
 * Prime asks Governance again about the STEP, under its own envelope — actor
 * `worker-a`, purpose "Run step create of intake". Two different questions,
 * both legitimately Governance's, and the first answer does not settle the
 * second.
 *
 * That is worth stating plainly because it is the strongest evidence in this
 * file that admission did not replace Governance: holding a valid
 * `authorizationRef` was not sufficient to make the engine run.
 */
function stepGovernance(): Governance {
  return createGovernanceEngine({
    now: () => NOW,
    policy: {
      policyId: "policy.ksix.execution",
      version: "1",
      protections: [],
      grants: [
        {
          grantId: "policy.worker.run-step",
          reason: "This worker process may execute authorized intake steps.",
          actors: ["worker-a"],
          actions: ["work_order.create"],
          tenants: ["ksix"],
          // The runner's purpose names the step and the workflow, so it is not
          // a fixed string a policy can enumerate. Widened here and nowhere
          // else, with the widening written down rather than inferred.
          purposes: ["*"],
          maxRiskClass: "routine",
          conditions: [],
        },
      ],
    },
  });
}

/** The gate under test, wired the way a Hive instance would wire it. */
function admission(over: Record<string, unknown> = {}) {
  return createInstanceAdmission({
    instance: INSTANCE_A,
    governance: governance(),
    grantsFor: () => [grant()],
    trustFor: () => "trusted",
    now: () => NOW,
    ...over,
  });
}

const request = (over: Record<string, unknown> = {}) => ({
  context: context(),
  action: "work_order.create",
  resource: { type: "work_order", id: "wo.1" },
  purpose: "customer_order_intake",
  ...over,
});

const refusal = (r: AdmissionResult) => {
  if (r.admitted) throw new Error("expected a refusal, and the request was admitted");
  return r;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE VALID PATH — first, so every denial below means something
// ─────────────────────────────────────────────────────────────────────────────

describe("a correctly identified principal reaches the authorized operation", () => {
  it("runs the whole chain and the engine actually performs the work", async () => {
    // The proof the directive asks for, end to end and with nothing faked in
    // the middle. If this fails, the identity system is restrictive rather
    // than usable, and a boundary nobody can pass is not a boundary — it is
    // an outage with a policy file.
    const performed = vi.fn(() => ({ kind: "completed" as const, output: { workOrderId: "wo.1" } }));

    const gate = admission();
    const admitted = await gate.admit(request());

    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;

    // The ref is Governance's decision id. Not minted here, not derived from
    // the evidence — the identifier of a decision that was actually made.
    expect(admitted.authorizationRef).toBe(admitted.decision.decisionId);
    expect(admitted.decision.decision).toBe("PERMITTED");
    expect(admitted.evidence.grantId).toBe("grant.workorder.create");
    expect(admitted.principal.kind).toBe("human");

    // Now the authorized action, through Prime's real runner and Nexus, with a
    // real engine port bound to the capability.
    const prime = createPrime({
      engines: [{ capability: "work_order.create", perform: performed }],
      governance: stepGovernance(),
      continuity: createInMemoryWorkflowStateStore(),
      instanceId: "worker-a",
    });

    expect(prime.runner).not.toBeNull();
    const result = await prime.runner!.start({
      definition: {
        workflowType: "intake",
        steps: [
          {
            stepId: "create",
            requiresAuthorization: true,
            routeTo: "work_order.create",
          },
        ],
      },
      tenant: { organizationId: "ksix", roles: ["owner"] },
      trace: { correlationId: "corr.1" },
      context: { authorizationRef: admitted.authorizationRef },
    });

    expect(performed).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
  });

  it("a valid authorizationRef is still not sufficient — Prime asks again", async () => {
    // The same admitted request, the same real ref, and a Prime whose
    // Governance will not stand behind the step. Nothing runs.
    //
    // This is the clearest statement available that the identity boundary
    // strengthens Governance rather than standing in for it: the ref proves a
    // decision was made about the REQUEST, and the STEP is a separate question
    // that Governance answers separately.
    const performed = vi.fn(() => ({ kind: "completed" as const }));
    const admitted = await admission().admit(request());
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;

    const prime = createPrime({
      engines: [{ capability: "work_order.create", perform: performed }],
      governance: createDenyAllGovernance("this worker may not run intake steps"),
      continuity: createInMemoryWorkflowStateStore(),
      instanceId: "worker-a",
    });

    const result = await prime.runner!.start({
      definition: {
        workflowType: "intake",
        steps: [{ stepId: "create", requiresAuthorization: true, routeTo: "work_order.create" }],
      },
      tenant: { organizationId: "ksix", roles: ["owner"] },
      trace: { correlationId: "corr.1" },
      context: { authorizationRef: admitted.authorizationRef },
    });

    expect(performed).not.toHaveBeenCalled();
    expect(result.status).not.toBe("completed");
  });

  it("hands Prime a reference it refuses to invent", async () => {
    // The structural claim, asserted rather than described: there is no field
    // on a refusal from which a caller could read a ref. `authorizationRef`
    // exists only on the admitted branch.
    const refused = refusal(await admission({ trustFor: () => "revoked" }).admit(request()));
    expect("authorizationRef" in refused).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAIL CLOSED — every listed way the wiring can be incomplete or wrong
// ─────────────────────────────────────────────────────────────────────────────

describe("incomplete identity wiring cannot become authorization", () => {
  it("missing principal — an unidentifiable caller is refused, not anonymous", async () => {
    const r = refusal(
      await admission().admit(
        request({
          context: context({
            identity: { subject: "svc", kind: "service", roles: [], assertedCapabilities: [] },
          }),
        }),
      ),
    );
    expect(r.stage).toBe("principal");
    expect(r.reason).toMatch(/Missing identity is not anonymous access/);
  });

  it("unresolved principal — a resolver returning null refuses", async () => {
    const r = refusal(await admission({ resolvePrincipal: () => null }).admit(request()));
    expect(r.stage).toBe("principal");
  });

  it("resolver failure — a thrower is an outage, not an anonymous caller", async () => {
    // Both refuse. Only one is somebody's pager, and the reason is where that
    // distinction survives.
    const r = refusal(
      await admission({
        resolvePrincipal: () => {
          throw new Error("identity service unreachable");
        },
      }).admit(request()),
    );
    expect(r.stage).toBe("principal");
    expect(r.reason).toMatch(/identity service unreachable/);
    expect(r.reason).toMatch(/unestablished identity is not an anonymous one/);
  });

  it("malformed identity — a principal that does not parse has not identified anybody", async () => {
    // A host-supplied resolver is host code. Without this, an engine principal
    // missing its version would be evaluated with a hole in it, and whichever
    // check dereferenced the hole first would report the failure — after the
    // others had already passed.
    const r = refusal(
      await admission({
        resolvePrincipal: () =>
          ({
            kind: "engine",
            principalId: "workorderiq",
            instance: INSTANCE_A,
            trustState: "trusted",
          }) as unknown as Principal,
      }).admit(request()),
    );
    expect(r.stage).toBe("principal");
    expect(r.reason).toMatch(/malformed/);
  });

  it("missing trust resolver — unwired trust denies", async () => {
    // No `trustFor`. The default is `unknown`, and unknown is not trusted.
    const gate = createInstanceAdmission({
      instance: INSTANCE_A,
      governance: governance(),
      grantsFor: () => [grant()],
      now: () => NOW,
    });
    const r = refusal(await gate.admit(request()));
    expect(r.stage).toBe("trust");
  });

  it("unknown trust — explicitly unknown denies for the same reason", async () => {
    const r = refusal(await admission({ trustFor: () => "unknown" }).admit(request()));
    expect(r.stage).toBe("trust");
  });

  it("revoked trust — a valid grant does not survive revocation", async () => {
    const r = refusal(await admission({ trustFor: () => "revoked" }).admit(request()));
    expect(r.stage).toBe("trust");
    expect(r.reason).toMatch(/revoked/);
  });

  it("insufficient grant — trusted and granted nothing", async () => {
    const r = refusal(await admission({ grantsFor: () => [] }).admit(request()));
    expect(r.stage).toBe("evidence");
  });

  it("wrong principal kind — an engine may not use a human's grant", async () => {
    const r = refusal(
      await admission({
        resolvePrincipal: () => ({
          kind: "engine" as const,
          principalId: "user.steven",
          engineVersion: "0.19.0",
          instance: INSTANCE_A,
          trustState: "trusted" as const,
          trustScore: null,
        }),
      }).admit(request()),
    );
    expect(r.stage).toBe("evidence");
  });

  it("wrong principal id — a grant belongs to whom it names", async () => {
    const r = refusal(
      await admission({ grantsFor: () => [grant({ principalId: "user.someone-else" })] }).admit(
        request(),
      ),
    );
    expect(r.stage).toBe("evidence");
  });

  it("wrong Hive instance — an identity registered elsewhere is refused", async () => {
    // The instance boundary, made non-vacuous. This test is why the gate has
    // an explicit instance check at all: the default resolver STAMPS the
    // gate's own instance onto the principal, so the comparison inside
    // `evaluatePermission` was the gate checking itself against itself, and it
    // passed for a principal that should have been refused.
    //
    // A registry-backed resolver is the case that matters — a host that knows
    // this identity belongs to instance A, presenting it to instance B.
    const registryResolver = (): Principal => ({
      kind: "human",
      principalId: "user.steven",
      instance: INSTANCE_A,
      tenant: { organizationId: "ksix", roles: ["owner"] },
      roles: ["owner"],
      authStrength: "password",
      trustState: "trusted",
      trustScore: null,
    });

    const a = admission({ resolvePrincipal: registryResolver });
    const b = admission({ instance: INSTANCE_B, resolvePrincipal: registryResolver });

    // Non-vacuity: the same resolver, the same request, admitted by A.
    expect((await a.admit(request())).admitted).toBe(true);

    const r = refusal(await b.admit(request()));
    expect(r.stage).toBe("principal");
    expect(r.reason).toMatch(/trusted in one instance is not trusted in another/);
    expect(trustCrossesInstances()).toBe(false);
  });

  it("scopes a grant to the instance that issued it", async () => {
    // The second, independent half. Even a locally-registered principal cannot
    // spend a grant issued somewhere else — which is what stops instance
    // isolation resting entirely on how a host wrote its resolver.
    const r = refusal(
      await admission({
        grantsFor: () => [grant({ globalInstanceId: INSTANCE_B.globalInstanceId })],
      }).admit(request()),
    );
    expect(r.stage).toBe("evidence");
  });

  it("keeps tenant and instance as separate concepts", async () => {
    // They map closely in today's deployments and must not be collapsed. The
    // instance refusal must not read as a tenant problem — that sends somebody
    // to fix a tenant assignment that is correct.
    const b = admission({
      instance: INSTANCE_B,
      resolvePrincipal: (): Principal => ({
        kind: "human",
        principalId: "user.steven",
        instance: INSTANCE_A,
        tenant: { organizationId: "ksix", roles: ["owner"] },
        roles: ["owner"],
        authStrength: "password",
        trustState: "trusted",
        trustScore: null,
      }),
    });
    const r = refusal(await b.admit(request()));
    expect(r.reason).toMatch(/instance/);
    expect(r.reason).not.toMatch(/tenant/i);
  });

  it("wrong tenant — knowing another org's id is not authority over it", async () => {
    const r = refusal(
      await admission().admit(
        request({
          context: context({ tenant: { organizationId: "competitor", roles: ["owner"] } }),
        }),
      ),
    );
    expect(r.stage).toBe("evidence");
    // Refused because the grant names `ksix` and this request names
    // `competitor`. Worth being exact about WHERE that boundary lives: the
    // default resolver takes the principal's tenant from `RequestContext`,
    // which the host has already verified, so principal and request agree by
    // construction and the grant is what refuses. A resolver that assigned
    // tenancy independently would additionally be caught by the
    // principal-versus-request comparison inside `evaluatePermission`.
    expect(r.reason).toMatch(/No live grant/);
  });

  it("wrong resource — a grant over work orders is not a grant over invoices", async () => {
    const r = refusal(
      await admission().admit(request({ resource: { type: "invoice", id: "inv.1" } })),
    );
    expect(r.stage).toBe("evidence");
  });

  it("wrong action — a grant to create is not a grant to delete", async () => {
    const r = refusal(await admission().admit(request({ action: "work_order.delete" })));
    expect(r.stage).toBe("evidence");
  });

  it("wrong mission — elevation does not carry between missions", async () => {
    const r = refusal(
      await admission({ grantsFor: () => [grant({ missionId: "mission.42" })] }).admit(
        request({ context: context({ missionId: "mission.43" }) }),
      ),
    );
    expect(r.stage).toBe("evidence");
  });

  it("mission omitted — a mission-scoped grant is inert on a request naming none", async () => {
    // The quiet case, and the one that matters most: if absent meant "any",
    // the cleanest route around a mission restriction would be leaving the
    // field out.
    const r = refusal(
      await admission({ grantsFor: () => [grant({ missionId: "mission.42" })] }).admit(request()),
    );
    expect(r.stage).toBe("evidence");
  });

  it("mission matched — the elevation works when it applies", async () => {
    // Non-vacuity for the two above. Without this, a mission check that
    // refused everything would pass both.
    const r = await admission({ grantsFor: () => [grant({ missionId: "mission.42" })] }).admit(
      request({ context: context({ missionId: "mission.42" }) }),
    );
    expect(r.admitted).toBe(true);
  });

  it("expired grant — and separately, expired identity", async () => {
    const expiredGrant = refusal(
      await admission({
        grantsFor: () => [
          grant({ expiresAt: "2026-08-29T11:00:00.000Z" }),
        ],
      }).admit(request()),
    );
    expect(expiredGrant.stage).toBe("evidence");

    const expiredIdentity = refusal(
      await admission().admit(
        request({
          context: context({
            identity: {
              subject: "user.steven",
              kind: "user",
              roles: ["owner"],
              assertedCapabilities: [],
              expiresAt: "2026-08-29T11:00:00.000Z",
            },
          }),
        }),
      ),
    );
    expect(expiredIdentity.stage).toBe("evidence");
  });

  it("revoked grant — withdrawal takes effect", async () => {
    const r = refusal(
      await admission({
        grantsFor: () => [grant({ revokedAt: "2026-08-01T00:00:00.000Z" })],
      }).admit(request()),
    );
    expect(r.stage).toBe("evidence");
  });

  it("malformed request — an unnamed action, resource or purpose is refused", async () => {
    // Found by a surviving mutation, not by review. `resource.type ?? "*"`
    // changed no test result, because the types say it cannot be missing — and
    // this is a host-facing entry point where the types are not present.
    //
    // Each field checked separately, because "the request was malformed" that
    // cannot say which field is a message nobody can act on.
    for (const bad of [
      { action: "" },
      { resource: { type: "", id: "wo.1" } },
      { resource: { type: "work_order", id: "" } },
      { resource: {} as { type: string; id: string } },
      { purpose: "" },
    ]) {
      const r = refusal(await admission().admit(request(bad)));
      expect(r.stage).toBe("request");
    }
  });

  it("never widens a missing resource into a wildcard", async () => {
    // The specific mutant. A caller that omits the resource must not thereby
    // request every resource — which is what makes the laziest call site the
    // most powerful one.
    const r = refusal(
      await admission({
        grantsFor: () => [grant({ resource: "*", action: "*" })],
      }).admit(request({ resource: {} as { type: string; id: string } })),
    );
    expect(r.stage).toBe("request");
    expect(r.reason).toMatch(/never be widened into a match/);
  });

  it("grant store unreachable — a failed lookup is not an empty one", async () => {
    const r = refusal(
      await admission({
        grantsFor: () => {
          throw new Error("grant store down");
        },
      }).admit(request()),
    );
    expect(r.stage).toBe("evidence");
    expect(r.reason).toMatch(/A failed lookup is not an empty one/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GOVERNANCE REMAINS THE AUTHORITY
// ─────────────────────────────────────────────────────────────────────────────

describe("evidence does not authorize", () => {
  it("refuses a perfectly evidenced request that Governance denies", async () => {
    // The heart of Phase 1B. Trust is fine, the grant applies, the principal
    // is exactly right — and Governance says no, so nothing happens. If this
    // ever passes, the identity model has quietly become the authorizer.
    const r = refusal(
      await admission({ governance: createDenyAllGovernance("this actor may not create") }).admit(
        request(),
      ),
    );
    expect(r.stage).toBe("governance");
    expect(r.reason).toMatch(/may not create/);
    expect(evidenceAdmitsWithoutGovernance()).toBe(false);
  });

  it("refuses on purpose alone, with identity untouched", async () => {
    // Purpose-bound authority, §1.7. The policy grants this actor this action
    // on this tenant — for one purpose. Same identity, same grant, different
    // reason for being there, and Governance refuses. The identity boundary
    // cannot express this and is not supposed to.
    const r = refusal(await admission().admit(request({ purpose: "competitor_research" })));
    expect(r.stage).toBe("governance");
  });

  it("refuses on risk class, which identity also cannot express", async () => {
    const r = refusal(await admission().admit(request({ riskClass: "critical" })));
    expect(r.stage).toBe("governance");
  });

  it("passes the evidence to Governance as a CLAIM, never as a permission", async () => {
    // The grant reaches Governance in `claims.assertedCapabilities` — the
    // field named so that misuse reads wrongly. Governance may weigh it and is
    // never bound by it.
    const seen: unknown[] = [];
    const spy: Governance = {
      async authorize(envelope) {
        seen.push(envelope.claims);
        return {
          decision: "PERMITTED",
          reason: "ok",
          conditions: [],
          decisionId: "gd.spy",
          decidedAt: NOW.toISOString(),
        };
      },
    };
    const r = await admission({ governance: spy }).admit(request());
    expect(r.admitted).toBe(true);
    expect(seen[0]).toMatchObject({
      assertedCapabilities: ["grant:grant.workorder.create"],
      issuer: "hive-instance:hive.ksix.us-east",
    });
  });

  it("refuses when Governance is unreachable — uncertainty creates no authority", async () => {
    const r = refusal(
      await admission({
        governance: {
          authorize: () => Promise.reject(new Error("governance timeout")),
        } as Governance,
      }).admit(request()),
    );
    expect(r.stage).toBe("governance-unavailable");
    expect(r.reason).toMatch(/Uncertainty does not create authority/);
  });

  it("refuses a permitted decision that carries no id to reference", async () => {
    // An authorization nothing can name is one no audit can follow back.
    // Minting a substitute here would make this module the source of an
    // authority it did not decide.
    const r = refusal(
      await admission({
        governance: {
          async authorize() {
            return {
              decision: "PERMITTED" as const,
              reason: "ok",
              conditions: [],
              decidedAt: NOW.toISOString(),
            };
          },
        },
      }).admit(request()),
    );
    expect(r.stage).toBe("governance");
    expect(r.reason).toMatch(/Minting one here/);
  });

  it("treats the not-yet outcomes as refusals, not as success", async () => {
    // REQUIRES_HUMAN_APPROVAL is the one most likely to be mistaken for a
    // pass, because it is not a denial. It is also not permission.
    for (const decision of [
      "REQUIRES_HUMAN_APPROVAL",
      "REQUIRES_ADDITIONAL_AUTHORITY",
      "REQUIRES_CONSTITUTIONAL_DELIBERATION",
      "DENIED",
      "PROHIBITED",
    ] as const) {
      const r = refusal(
        await admission({
          governance: {
            async authorize() {
              return {
                decision,
                reason: `answered ${decision}`,
                conditions: [],
                decisionId: "gd.x",
                decidedAt: NOW.toISOString(),
              };
            },
          },
        }).admit(request()),
      );
      expect(r.stage).toBe("governance");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OBSERVABILITY
// ─────────────────────────────────────────────────────────────────────────────

describe("the gate is observable", () => {
  it("reports admissions and refusals alike", async () => {
    const onAdmission = vi.fn();
    await admission({ onAdmission }).admit(request());
    await admission({ onAdmission, trustFor: () => "revoked" }).admit(request());
    expect(onAdmission).toHaveBeenCalledTimes(2);
    expect(onAdmission.mock.calls[0]?.[0]?.admitted).toBe(true);
    expect(onAdmission.mock.calls[1]?.[0]?.stage).toBe("trust");
  });

  it("names the stage on every refusal, because each has a different fix", async () => {
    const stages = new Set<string>();
    for (const gate of [
      admission({ resolvePrincipal: () => null }),
      admission({ trustFor: () => "revoked" }),
      admission({ grantsFor: () => [] }),
      admission({ governance: createDenyAllGovernance("no") }),
    ]) {
      stages.add(refusal(await gate.admit(request())).stage);
    }
    expect(stages).toEqual(new Set(["principal", "trust", "evidence", "governance"]));
  });
});
