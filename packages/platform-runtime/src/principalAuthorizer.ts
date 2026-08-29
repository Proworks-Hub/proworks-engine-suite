// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  evaluatePermission,
  type Authorizer,
  type InstanceIdentity,
  type PermissionFinding,
  type PermissionGrant,
  type Principal,
  type RequestContext,
  type TrustState,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Binding the identity plane to the `Authorizer` port that already exists.
//
// Written because the rest of Phase 1 would otherwise be a field declared,
// stored, and never read — the defect shape this repository has now found
// seven times (`terminationConditions`, the absent idempotency key,
// `crossTenantLearningApproved`, `AWAITING_HUMAN_AUTHORIZATION` with no exit,
// `decisionResultSchema.trace`, the unbound `SentinelWatch` port, the
// unlistened `onPromotion` hooks). A principal model nothing consults would be
// the eighth.
//
// It does NOT introduce a new authorization system. `Authorizer` is the host's
// existing policy port and `requirePermission` is the existing enforcement
// point; this is one implementation of that port, which a host may bind or
// not. Governance remains the only thing that authorizes — a `true` from here
// says a grant was found, which is evidence.
//
// WHY SO MUCH MUST BE SUPPLIED BY THE HOST
//
// Three things this needs are absent from `RequestContext`, and every one of
// them is absent for a reason that makes inventing it worse than refusing:
//
//   INSTANCE IDENTITY — the request does not carry it, and it must not: a
//   caller that names its own instance names its own boundary. The host knows
//   which instance it is.
//
//   TRUST STATE — `identityClaims` has no trust field, so the default here is
//   `unknown`, and unknown denies. That makes a trust source a wiring decision
//   somebody has to make rather than a default that quietly reads as trusted.
//
//   PRINCIPAL KIND — see `defaultResolvePrincipal`.
// ─────────────────────────────────────────────────────────────────────────────

export interface PrincipalAuthorizerOptions {
  /** Which Hive instance this host IS. Never read from the request. */
  readonly instance: InstanceIdentity;

  /** The grants a principal holds. Never supplied by the principal itself. */
  readonly grantsFor: (
    principal: Principal,
  ) => readonly PermissionGrant[] | Promise<readonly PermissionGrant[]>;

  /**
   * How trusted this caller is.
   *
   * Defaults to `unknown`, which denies. A host with no trust source should
   * discover that at wiring time rather than by having everything treated as
   * trusted for a year.
   */
  readonly trustFor?: (context: RequestContext) => TrustState;

  /**
   * How a request becomes a principal. See `defaultResolvePrincipal` for what
   * the default can and cannot do.
   */
  readonly resolvePrincipal?: (
    context: RequestContext,
    instance: InstanceIdentity,
    trust: TrustState,
  ) => Principal | null;

  /**
   * Every finding, allowed and denied.
   *
   * Both, on purpose. A hook that fires only on denial cannot answer "was this
   * check even running", and a check nobody can prove ran is a check.
   */
  readonly onFinding?: (event: {
    readonly finding: PermissionFinding;
    readonly permission: string;
    readonly subject: string;
  }) => void;

  readonly now?: () => Date;
}

/**
 * The default request-to-principal mapping.
 *
 * Handles `user` and refuses everything else, which is deliberate and is the
 * most important decision in this file.
 *
 * An engine principal needs `engineVersion`. An agent needs `missionId` and a
 * parent engine. A connector needs its provider. `RequestContext` carries none
 * of them — so a default that mapped `service` onto some principal shape would
 * have to invent the missing identifier, and an invented identifier is worse
 * than a refusal: it produces a principal that passes checks while naming
 * nothing real, and the checks then attest to it.
 *
 * A host that authenticates engines or agents knows those values and supplies
 * its own resolver. Until it does, this denies and says which field was
 * missing.
 */
export function defaultResolvePrincipal(
  context: RequestContext,
  instance: InstanceIdentity,
  trust: TrustState,
): Principal | null {
  if (context.identity.kind !== "user") return null;

  return {
    kind: "human",
    principalId: context.identity.subject,
    instance,
    tenant: context.tenant,
    roles: context.identity.roles,
    // `identityClaims` does not record how strongly the caller authenticated,
    // so this is the weakest true statement rather than a flattering guess.
    authStrength: "password",
    trustState: trust,
    trustScore: null,
    ...(context.identity.expiresAt ? { expiresAt: context.identity.expiresAt } : {}),
  };
}

/**
 * An `Authorizer` backed by principals, trust and grants.
 *
 * Never throws. `requirePermission` is what throws, and it is the only place
 * that should — an authorizer that threw would make an unreachable grant store
 * indistinguishable from a denial, and one of those two is an outage.
 */
export function createPrincipalAuthorizer(options: PrincipalAuthorizerOptions): Authorizer {
  const now = options.now ?? (() => new Date());
  const resolve = options.resolvePrincipal ?? defaultResolvePrincipal;
  const trustOf = options.trustFor ?? (() => "unknown" as const);

  const report = (finding: PermissionFinding, permission: string, subject: string): boolean => {
    options.onFinding?.({ finding, permission, subject });
    return finding.held;
  };

  return {
    async can(context, permission, resource) {
      const subject = context.identity.subject;
      const principal = resolve(context, options.instance, trustOf(context));

      if (!principal) {
        return report(
          {
            held: false,
            reason:
              `No principal could be built for a "${context.identity.kind}" caller. ` +
              `Engine, agent and connector identities need fields the request does not carry ` +
              `(version, mission, provider), and inventing one would produce a principal that ` +
              `passes checks while naming nothing real. Bind resolvePrincipal.`,
            grantId: null,
          },
          permission,
          subject,
        );
      }

      let grants: readonly PermissionGrant[];
      try {
        grants = await options.grantsFor(principal);
      } catch (cause) {
        // A grant store that failed is not a principal that holds nothing.
        // Both deny — but only one of them is somebody's outage, and the
        // reason is the only place that distinction survives.
        return report(
          {
            held: false,
            reason: `Grants for ${principal.principalId} could not be read: ${
              cause instanceof Error ? cause.message : String(cause)
            }. A failed lookup is not an empty one.`,
            grantId: null,
          },
          permission,
          subject,
        );
      }

      const finding = evaluatePermission({
        principal,
        request: {
          // The port's `permission` is the action; `resource.type` is what it
          // acts on. A permission with no resource is not a permission over
          // everything — it is scoped to the permission string itself.
          resource: resource?.type ?? permission,
          action: permission,
          ...(context.tenant.organizationId ? { tenantId: context.tenant.organizationId } : {}),
          globalInstanceId: options.instance.globalInstanceId,
          at: now().toISOString(),
        },
        grants,
      });

      return report(finding, permission, subject);
    },
  };
}
