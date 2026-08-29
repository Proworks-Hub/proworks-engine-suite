// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  AuthorizationError,
  isPermitted,
  principalSchema,
  requirePermission,
  type AuthorityEnvelope,
  type Governance,
  type GovernanceDecision,
  type InstanceIdentity,
  type PermissionFinding,
  type PermissionGrant,
  type Principal,
  type RequestContext,
  type RiskClass,
  type TrustState,
} from "@proworks-hub/contracts";

import { createPrincipalAuthorizer, defaultResolvePrincipal } from "./principalAuthorizer.js";

// ─────────────────────────────────────────────────────────────────────────────
// A Hive instance admitting a request.
//
// Phase 1 built the identity boundary and nothing bound it, which made it a
// model rather than a boundary. This is the binding, at the lowest seam that
// exists rather than in a host: a request arrives, and what leaves is either a
// refusal or an `authorizationRef` — the thing Prime's Nexus already requires
// and which, until now, nothing in the suite produced.
//
//   REQUEST → PRINCIPAL → INSTANCE → TRUST → GRANT EVIDENCE
//           → Authorizer seam → GOVERNANCE → authorizationRef
//
// WHY THE REF IS A GOVERNANCE DECISION ID
//
// The single most important line in this file is that `authorizationRef` is
// `decision.decisionId` and is reachable no other way. Not a token this module
// mints, not a hash of the evidence, not a boolean promoted to a string. A
// caller holding a ref is holding the identifier of a decision Governance
// actually made, so "evidence does not authorize" is enforced by there being
// no path from evidence to a ref.
//
// TWO GATES, BOTH REQUIRED, NEITHER SUFFICIENT
//
// Grant evidence is checked AND Governance is asked. Not one or the other:
//
//   Evidence only would make this an authorizer, which is the collapse the
//   whole architecture is built to prevent.
//
//   Governance only would make the grant model decorative — a permissive
//   policy would admit a principal holding nothing, and the identity boundary
//   would be a thing we describe rather than a thing that runs.
//
// So identity narrows and Governance decides. A request must survive both.
// That is what "strengthen Governance, do not replace it" means when written
// as control flow.
//
// WHAT THIS IS NOT
//
// Not a second Authorizer: it CALLS `requirePermission` against a
// `createPrincipalAuthorizer`, both of which already existed. Not a second
// Governance: it calls the `Governance` port and reads the answer. It adds no
// enforcement mechanism — it sequences the ones already here and refuses to
// let the sequence be skipped.
//
// ONE INSTANCE, NOT THE ONLY INSTANCE
//
// `instance` is a construction parameter, never a default and never read from
// the request. Two admissions in one process are two instances, and a
// principal admitted by one is refused by the other on the instance boundary
// alone. That is deliberate groundwork: when instance A eventually hands work
// to instance B, B admits A as a principal through this same path rather than
// trusting it for being adjacent.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a refusal happened. Kept because each stage has a different fix. */
export type AdmissionStage =
  /** The admission request itself was not well formed. */
  | "request"
  /** No principal could be built from the request. */
  | "principal"
  /** A principal exists but its trust does not permit work. */
  | "trust"
  /** Trust is fine; no applicable grant. */
  | "evidence"
  /** Evidence is fine; Governance refused. */
  | "governance"
  /** Governance itself could not be reached. */
  | "governance-unavailable";

export type AdmissionResult =
  | {
      readonly admitted: true;
      /**
       * The Governance decision that permitted this. Hand it to Prime.
       *
       * Present ONLY on this branch, so a refusal has no ref to read off.
       */
      readonly authorizationRef: string;
      readonly principal: Principal;
      /** What the identity boundary found. Evidence, and labelled as such. */
      readonly evidence: PermissionFinding;
      readonly decision: GovernanceDecision;
    }
  | {
      readonly admitted: false;
      readonly stage: AdmissionStage;
      readonly reason: string;
      /** Present when Governance was reached and refused. */
      readonly decision?: GovernanceDecision;
      readonly principal?: Principal;
    };

export interface InstanceAdmissionOptions {
  /** Which Hive instance this IS. Never defaulted, never read from a request. */
  readonly instance: InstanceIdentity;

  /**
   * The authority. REQUIRED, with no default of any kind.
   *
   * Not defaulted even to deny-all: a host that forgot to bind Governance
   * would then get a working-looking gate that refuses everything, and would
   * debug its policy rather than its wiring. `createDenyAllGovernance` exists
   * and a host that wants it can say so.
   */
  readonly governance: Governance;

  readonly grantsFor: (
    principal: Principal,
  ) => readonly PermissionGrant[] | Promise<readonly PermissionGrant[]>;

  /** Defaults to `unknown`, which refuses. See `principalAuthorizer`. */
  readonly trustFor?: (context: RequestContext) => TrustState;

  readonly resolvePrincipal?: (
    context: RequestContext,
    instance: InstanceIdentity,
    trust: TrustState,
  ) => Principal | null;

  readonly now?: () => Date;
  /** Every admission and every refusal, so the gate is observable. */
  readonly onAdmission?: (result: AdmissionResult, request: AdmissionRequest) => void;
}

export interface AdmissionRequest {
  readonly context: RequestContext;
  /** The action being requested. Becomes both the permission and the envelope's action. */
  readonly action: string;
  /** What it acts on. */
  readonly resource: { readonly type: string; readonly id: string };
  /**
   * Why. Purpose-bound authority is constitutional (§1.7), and the Governance
   * envelope requires it — access for one purpose does not authorize another.
   */
  readonly purpose: string;
  readonly riskClass?: RiskClass;
}

export interface InstanceAdmission {
  /** Which instance this gate admits to. For an operator asking what is bound. */
  readonly instance: InstanceIdentity;
  admit(request: AdmissionRequest): Promise<AdmissionResult>;
}

export function createInstanceAdmission(options: InstanceAdmissionOptions): InstanceAdmission {
  const now = options.now ?? (() => new Date());
  const resolve = options.resolvePrincipal ?? defaultResolvePrincipal;
  const trustOf = options.trustFor ?? (() => "unknown" as const);

  /**
   * The existing seam, built per admission around an ALREADY-resolved
   * principal.
   *
   * Not resolved twice. A gate that resolved once for its own staging and let
   * the authorizer resolve again would have two identities per request, from a
   * host-supplied function nothing requires to be pure — and the two could
   * disagree, with the checks landing on one and the audit naming the other.
   * Resolving once and handing the result down is the only arrangement where
   * "the principal that was checked" is a single thing.
   */
  const seamFor = (principal: Principal, capture: (f: PermissionFinding) => void) =>
    createPrincipalAuthorizer({
      instance: options.instance,
      grantsFor: options.grantsFor,
      resolvePrincipal: () => principal,
      onFinding: (event) => capture(event.finding),
      now,
    });

  return {
    instance: options.instance,

    async admit(request) {
      const { context, action, resource, purpose } = request;
      const finish = (result: AdmissionResult): AdmissionResult => {
        options.onAdmission?.(result, request);
        return result;
      };

      // ── 0. The request itself ───────────────────────────────────────────
      //
      // Added because a mutation survived: replacing `resource.type` with
      // `resource.type ?? "*"` changed nothing any test could see. The types
      // say `resource.type` is a string, so the fallback looked unreachable —
      // but this is a host-facing entry point, and TypeScript is not present
      // at the call site of a JavaScript host, a JSON body, or a test double.
      //
      // Today a missing `type` fails closed by ACCIDENT: it becomes an
      // undefined resource that matches no grant. Failing closed by accident
      // is one refactor away from failing open, and the refactor that does it
      // is the innocuous-looking `?? "*"` above. So the request is checked,
      // and the widest possible resource is never something a caller reaches
      // by omitting a field.
      const malformed = [
        ["action", action],
        ["resource.type", resource?.type],
        ["resource.id", resource?.id],
        ["purpose", purpose],
      ].find(([, value]) => typeof value !== "string" || value.length === 0);

      if (malformed) {
        return finish({
          admitted: false,
          stage: "request",
          reason:
            `The admission request is missing "${malformed[0]}". An unnamed action, resource or purpose ` +
            "cannot be authorized, and must never be widened into a match.",
        });
      }

      // ── 1. WHO ──────────────────────────────────────────────────────────
      //
      // Resolved before anything else, and separately from the authorizer's
      // own resolution, so a refusal here can say "principal" rather than
      // being reported as a missing grant. A resolver that throws is a
      // resolver failure, not an anonymous caller: both refuse, and only the
      // reason distinguishes an outage from a denial.
      let principal: Principal | null;
      try {
        principal = resolve(context, options.instance, trustOf(context));
      } catch (cause) {
        return finish({
          admitted: false,
          stage: "principal",
          reason: `Principal resolution failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }. A resolver that threw has not established an identity, and an unestablished identity is not an anonymous one.`,
        });
      }

      if (!principal) {
        return finish({
          admitted: false,
          stage: "principal",
          reason: `No principal could be resolved for "${context.identity.subject}" (${context.identity.kind}). Missing identity is not anonymous access.`,
        });
      }

      // A host-supplied resolver is host code, and a malformed principal must
      // not reach the evaluator on the strength of a type annotation. Parsed
      // here so an identity missing its instance, its mission, or its engine
      // version is refused as malformed rather than evaluated with a hole in
      // it — the hole would otherwise be discovered by whichever check
      // dereferenced it first, and the others would have already passed.
      const validated = principalSchema.safeParse(principal);
      if (!validated.success) {
        return finish({
          admitted: false,
          stage: "principal",
          reason: `The resolved principal is malformed: ${JSON.stringify(
            validated.error.flatten(),
          )}. A principal that does not parse has not been identified.`,
        });
      }
      principal = validated.data;

      // ── The instance boundary, checked here rather than only in the grant ─
      //
      // Found by the adoption test, and it is the reason that test exists.
      // `evaluatePermission` compares the principal's instance to the
      // request's — but on the default path the resolver STAMPS the gate's own
      // instance onto the principal, so that comparison was the gate checking
      // itself against itself. A check that cannot fail is not a check, and it
      // was passing.
      //
      // The real question is whether the identity a resolver returned belongs
      // to THIS instance. A registry-backed resolver knows the answer and can
      // hand back a principal registered elsewhere; this refuses it.
      //
      // Cross-instance admission is deliberately not carved out here. When
      // instance A hands work to instance B, B will admit A as a
      // `hive-instance` principal through an explicit path built for it — an
      // exemption added now, before that path exists, would be an unused hole
      // that nothing tests.
      if (principal.instance.globalInstanceId !== options.instance.globalInstanceId) {
        return finish({
          admitted: false,
          stage: "principal",
          reason:
            `Principal ${principal.principalId} is registered to instance ` +
            `${principal.instance.globalInstanceId} and this is ${options.instance.globalInstanceId}. ` +
            "A principal trusted in one instance is not trusted in another; same architecture is not same instance.",
        });
      }

      // ── 2. GRANT EVIDENCE, through the seam that already exists ─────────
      //
      // `requirePermission` throws; that is its documented shape and the
      // reason it was chosen over a boolean — a caller that can ignore the
      // answer eventually does. Caught here and converted into a stage, which
      // is a refusal becoming more specific, never a refusal becoming an
      // allow. The `catch` below cannot reach the permitted branch: it
      // returns, and the only `admitted: true` in this function is after
      // Governance.
      //
      // Trust is checked INSIDE `evaluatePermission`, before grants, so a
      // revoked principal refuses here with a trust reason rather than
      // needing a second gate that could disagree with the first.
      let lastFinding: PermissionFinding | null = null;
      const authorizer = seamFor(principal, (f) => {
        lastFinding = f;
      });
      try {
        await requirePermission(authorizer, context, action, {
          type: resource.type,
          id: resource.id,
        });
      } catch (cause) {
        const finding = lastFinding as PermissionFinding | null;
        const reason = finding?.reason ?? (cause instanceof Error ? cause.message : String(cause));
        // Trust refusals come back from the same call as grant refusals. They
        // are reported apart because "you are not trusted" and "you hold no
        // grant" send somebody to different places.
        const trustRefused =
          cause instanceof AuthorizationError &&
          /is (revoked|restricted|unknown|watched)/.test(reason);
        return finish({
          admitted: false,
          stage: trustRefused ? "trust" : "evidence",
          reason,
          principal,
        });
      }

      const evidence: PermissionFinding = lastFinding ?? {
        held: true,
        reason: "The authorizer permitted the action without reporting a finding.",
        grantId: null,
      };

      // ── 3. AUTHORITY ────────────────────────────────────────────────────
      //
      // Evidence in hand and still not authorized. The envelope carries the
      // evidence in `claims`, which is the field named so misuse reads
      // wrongly — Governance may weigh it and is never bound by it.
      const envelope: AuthorityEnvelope = {
        requestId: context.requestId,
        actorId: principal.principalId,
        tenant: context.tenant,
        purpose,
        requestedAction: action,
        targetResource: `${resource.type}:${resource.id}`,
        delegationChain: [],
        riskClass: request.riskClass ?? "routine",
        claims: {
          roles: context.identity.roles,
          // The grant that matched, offered as a claim rather than as a
          // permission. A decision that reads this is reading evidence.
          assertedCapabilities: evidence.grantId ? [`grant:${evidence.grantId}`] : [],
          issuer: `hive-instance:${options.instance.globalInstanceId}`,
          ...(context.identity.expiresAt ? { expiresAt: context.identity.expiresAt } : {}),
        },
        trace: context.trace,
        issuedAt: now().toISOString(),
      };

      let decision: GovernanceDecision;
      try {
        decision = await options.governance.authorize(envelope);
      } catch (cause) {
        // Governance unreachable is not Governance permitting. The distinction
        // matters operationally — this is somebody's outage — and it must not
        // matter to the outcome.
        return finish({
          admitted: false,
          stage: "governance-unavailable",
          reason: `Governance could not be reached: ${
            cause instanceof Error ? cause.message : String(cause)
          }. Uncertainty does not create authority.`,
          principal,
        });
      }

      if (!isPermitted(decision)) {
        return finish({
          admitted: false,
          stage: "governance",
          reason: decision.reason,
          decision,
          principal,
        });
      }

      // A permitted decision with no id cannot be referenced, and an
      // unreferenceable authorization is one no audit can follow back. Refused
      // rather than substituted with something generated here, which would be
      // this module minting the ref it is supposed to only carry.
      if (!decision.decisionId) {
        return finish({
          admitted: false,
          stage: "governance",
          reason:
            "Governance permitted the action but issued no decisionId, so there is nothing to reference. " +
            "Minting one here would make this module the source of an authority it did not decide.",
          decision,
          principal,
        });
      }

      return finish({
        admitted: true,
        authorizationRef: decision.decisionId,
        principal,
        evidence,
        decision,
      });
    },
  };
}

/**
 * Whether grant evidence, on its own, admits a request.
 *
 * Always false. The fifteenth of these, and the one placed at the seam where
 * the collapse would actually occur: not in a type, but in a control flow that
 * returned early once the evidence looked good.
 */
export function evidenceAdmitsWithoutGovernance(): false {
  return false;
}

/**
 * Whether a principal trusted in one instance is trusted in another.
 *
 * Always false. Stated now, while there is one instance and the question looks
 * theoretical, because it stops being theoretical the first time two of these
 * gates exist in one process.
 */
export function trustCrossesInstances(): false {
  return false;
}
