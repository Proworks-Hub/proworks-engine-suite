// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  isPermitted,
  type AuthorityEnvelope,
  type Governance,
  type GovernanceDecision,
  type RequestContext,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// What every Core coordinator does identically.
//
// Extracted after the second one. Finance Core proved the shape; Operations
// Core would have copied it, and six more Cores after that. Eight
// implementations of "call a specialist with a timeout and report a partial
// answer" is precisely the failure this codebase warns about elsewhere — five
// adapters each retrying differently is how behaviour becomes
// implementation-dependent.
//
// Generic over the capability type, so each Core keeps its own closed
// vocabulary. `FinanceCapability` and `OperationsCapability` stay distinct
// enums; only the machinery is shared.
//
// This package is PLATFORM tier: Cores may depend on it, it depends on nothing
// but contracts, and it knows about no domain whatsoever.
// ─────────────────────────────────────────────────────────────────────────────

export interface CoreRequest<TCapability extends string, TInput = unknown> {
  readonly capability: TCapability;
  readonly input: TInput;
  /** Established by Prime, enriched by the Core, consumed by the specialist. */
  readonly context: RequestContext;
  readonly correlationId: string;
  /** What caused this. One trace, many causes. */
  readonly causationId?: string;
}

export interface CoreAnswer<TCapability extends string, TOutput = unknown> {
  readonly capability: TCapability;
  readonly output: TOutput;
  readonly servedBy: string;
  readonly latencyMs: number;
}

export type CoreFailure = "no_specialist" | "timeout" | "specialist_error" | "not_permitted";

export interface CoreRefusal<TCapability extends string> {
  readonly capability: TCapability;
  readonly failure: CoreFailure;
  readonly reason: string;
  readonly specialist?: string;
}

export type CoreOutcome<TCapability extends string, TOutput = unknown> =
  | { ok: true; answer: CoreAnswer<TCapability, TOutput> }
  | { ok: false; refusal: CoreRefusal<TCapability> };

/**
 * A specialist, as any Core sees one.
 *
 * Deliberately narrow. A Core knows that something claims a capability and can
 * be asked — never the engine's shape, options or internals. That is what makes
 * a specialist replaceable by another honouring the same contract.
 */
export interface Specialist<TCapability extends string> {
  readonly id: string;
  readonly capabilities: readonly TCapability[];
  /** Lower is preferred when two claim one capability. */
  readonly preference?: number;
  handle(request: CoreRequest<TCapability>): Promise<unknown>;
  /** Absent means the Core cannot know whether it is well. Not the same as unwell. */
  health?(): Promise<{ healthy: boolean; detail: string }>;
}

export interface SpecialistRegistry<TCapability extends string> {
  register(specialist: Specialist<TCapability>): void;
  resolve(capability: TCapability): Specialist<TCapability> | undefined;
  candidates(capability: TCapability): Specialist<TCapability>[];
  /** What this Core can answer. DERIVED from registrations, never declared. */
  capabilities(): TCapability[];
  registered(): Specialist<TCapability>[];
}

export function createSpecialistRegistry<TCapability extends string>(
  specialists: readonly Specialist<TCapability>[] = [],
): SpecialistRegistry<TCapability> {
  const byId = new Map<string, Specialist<TCapability>>();
  for (const specialist of specialists) byId.set(specialist.id, specialist);

  const registry: SpecialistRegistry<TCapability> = {
    register(specialist) {
      // By id, so a host re-registering after a reconnect does not end up with
      // two copies, one of them dead.
      byId.set(specialist.id, specialist);
    },

    candidates(capability) {
      return [...byId.values()]
        .filter((specialist) => specialist.capabilities.includes(capability))
        .sort((a, b) => (a.preference ?? 100) - (b.preference ?? 100) || a.id.localeCompare(b.id));
    },

    resolve(capability) {
      return registry.candidates(capability)[0];
    },

    capabilities() {
      // A Core that DECLARED its capabilities would keep claiming to answer
      // questions after the specialist that answered them was removed.
      const all = new Set<TCapability>();
      for (const specialist of byId.values()) {
        for (const capability of specialist.capabilities) all.add(capability);
      }
      return [...all].sort();
    },

    registered() {
      return [...byId.values()];
    },
  };

  return registry;
}

export interface CoordinatorOptions<TCapability extends string> {
  /** The domain this Core owns. Reported in status. */
  core: string;
  registry: SpecialistRegistry<TCapability>;
  /**
   * Decides whether the caller may use the capability. REQUIRED.
   *
   * Constitution §1.9: "Capability does not imply permission." Before this
   * existed, resolving a capability WAS authorizing it — being able to reach a
   * Core meant being allowed to use it, and the only gate was a bearer token at
   * the router.
   *
   * Required rather than optional, because the identical mistake was already
   * made once in this codebase: eight services took an optional
   * `PermissionService` and treated its absence as permission. An optional
   * authorizer is an authorizer somebody forgets, and the forgetting is
   * invisible — every call site still reads as guarded.
   *
   * Pass `createDenyAllGovernance()` to deny everything explicitly. There is no
   * way to express "no governance" other than saying so.
   */
  governance: Governance;
  /**
   * Builds the authority question for a request.
   *
   * The host supplies this because only the host knows what its actions mean:
   * purpose, target and risk are domain facts, not coordinator facts.
   */
  authorityFor(request: CoreRequest<TCapability>): AuthorityEnvelope;
  /** Per-specialist ceiling. A hung specialist must not hold Prime open. */
  timeoutMs?: number;
  allowFallback?: boolean;
  now?: () => number;
  onAttempt?(event: {
    core: string;
    capability: TCapability;
    specialist: string;
    outcome: "success" | "failure" | "denied";
    failure?: CoreFailure;
    /** Present when Governance refused. Denials must be observable. */
    decision?: GovernanceDecision;
    latencyMs: number;
    correlationId: string;
  }): void;
}

/**
 * Builds an authority question from a request, when a host has nothing more
 * specific to say.
 *
 * `purpose` becomes `capability:<name>`, which is honest rather than
 * decorative: the caller's purpose genuinely is to invoke that capability. A
 * host that knows a richer purpose — "quote a customer", "close the month" —
 * should supply its own builder, because purpose-bound authority (Constitution
 * §1.7) is only as meaningful as the purpose stated.
 */
export function defaultAuthorityFor<TCapability extends string>(
  request: CoreRequest<TCapability>,
): AuthorityEnvelope {
  const context = request.context as RequestContext | undefined;

  // Fail closed, and say what is missing. A context with no identity has no
  // actor, and an authority question with no actor cannot be answered -- the
  // raw TypeError this replaces said "cannot read properties of undefined",
  // which tells an operator nothing about why nothing was authorized.
  if (!context?.identity?.subject || !context.tenant) {
    throw new Error(
      "Cannot build an authority envelope: the request context carries no identity or no tenant. " +
        "Nothing is authorized without an actor and a tenant.",
    );
  }

  return {
    requestId: context.requestId,
    actorId: context.identity.subject,
    tenant: context.tenant,
    purpose: `capability:${request.capability}`,
    requestedAction: request.capability,
    delegationChain: [],
    riskClass: "routine",
    claims: {
      roles: context.identity.roles,
      // Carried as CLAIMS, never as authority. Governance may consider them.
      assertedCapabilities: context.identity.assertedCapabilities,
    },
    trace: context.trace,
    issuedAt: context.receivedAt,
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    // Cleared here, or a slow-but-successful call leaves a timer holding the
    // process open for its full duration.
    if (timer) clearTimeout(timer);
  }
}

export interface Coordinator<TCapability extends string> {
  ask<TOutput = unknown>(
    request: CoreRequest<TCapability>,
  ): Promise<CoreOutcome<TCapability, TOutput>>;
  /** Everything that worked, beside everything that did not. */
  askAll(requests: readonly CoreRequest<TCapability>[]): Promise<{
    answers: CoreAnswer<TCapability>[];
    refusals: CoreRefusal<TCapability>[];
    complete: boolean;
  }>;
  status(): Promise<{
    core: string;
    capabilities: TCapability[];
    specialists: { id: string; healthy: boolean | null; detail: string }[];
  }>;
}

export function createCoordinator<TCapability extends string>(
  options: CoordinatorOptions<TCapability>,
): Coordinator<TCapability> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  const attempt = async (
    specialist: Specialist<TCapability>,
    request: CoreRequest<TCapability>,
  ): Promise<CoreOutcome<TCapability>> => {
    const started = now();
    try {
      const output = await withTimeout(specialist.handle(request), timeoutMs);
      const latencyMs = now() - started;

      options.onAttempt?.({
        core: options.core, capability: request.capability, specialist: specialist.id,
        outcome: "success", latencyMs, correlationId: request.correlationId,
      });

      return {
        ok: true,
        answer: { capability: request.capability, output, servedBy: specialist.id, latencyMs },
      };
    } catch (cause) {
      const latencyMs = now() - started;
      const timedOut = cause instanceof Error && cause.message === "timeout";
      const failure: CoreFailure = timedOut ? "timeout" : "specialist_error";

      options.onAttempt?.({
        core: options.core, capability: request.capability, specialist: specialist.id,
        outcome: "failure", failure, latencyMs, correlationId: request.correlationId,
      });

      return {
        ok: false,
        refusal: {
          capability: request.capability,
          failure,
          specialist: specialist.id,
          reason: timedOut
            ? `${specialist.id} did not answer within ${timeoutMs}ms.`
            : `${specialist.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      };
    }
  };

  const coordinator: Coordinator<TCapability> = {
    async ask<TOutput>(request: CoreRequest<TCapability>) {
      // ── Governance decides BEFORE the registry is consulted ──────────────
      //
      // Ordered this way deliberately. Resolving first and authorizing second
      // would leak which capabilities exist to a caller who may not use them,
      // and invites a later refactor to drop the second step. Asking first also
      // means an unauthorized caller learns nothing about the installation.
      let decision: GovernanceDecision;
      try {
        // Envelope construction is inside the try on purpose: a request that
        // cannot even be described as an authority question must be refused,
        // not thrown out of the coordinator.
        decision = await options.governance.authorize(options.authorityFor(request));
      } catch (cause) {
        // Governance failing is not permission. Fail closed, and say which of
        // the two happened -- "Governance is down" and "you may not" need
        // different responses from an operator.
        return {
          ok: false as const,
          refusal: {
            capability: request.capability,
            failure: "not_permitted" as const,
            reason: `Governance could not decide, so nothing is authorized: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          },
        };
      }

      if (!isPermitted(decision)) {
        options.onAttempt?.({
          core: options.core,
          capability: request.capability,
          specialist: "<governance>",
          outcome: "denied",
          failure: "not_permitted",
          decision,
          latencyMs: 0,
          correlationId: request.correlationId,
        });

        return {
          ok: false as const,
          refusal: {
            capability: request.capability,
            failure: "not_permitted" as const,
            reason: decision.reason,
          },
        };
      }

      const candidates = options.registry.candidates(request.capability);

      if (candidates.length === 0) {
        // A statement about this installation, not an error. A host with no
        // BudgetIQ genuinely cannot forecast, and saying so beats a stack trace.
        return {
          ok: false as const,
          refusal: {
            capability: request.capability,
            failure: "no_specialist" as const,
            reason: `No registered specialist answers "${request.capability}" in this installation.`,
          },
        };
      }

      const usable = options.allowFallback ? candidates : candidates.slice(0, 1);
      let last: CoreOutcome<TCapability> | undefined;

      for (const specialist of usable) {
        const outcome = await attempt(specialist, request);
        if (outcome.ok) return outcome as CoreOutcome<TCapability, TOutput>;
        last = outcome;
      }

      return last as CoreOutcome<TCapability, TOutput>;
    },

    async askAll(requests) {
      const answers: CoreAnswer<TCapability>[] = [];
      const refusals: CoreRefusal<TCapability>[] = [];

      // Sequential. Firing several concurrent requests at one tenant's data is
      // how a coordinator becomes the cause of the timeouts it then reports.
      for (const request of requests) {
        const outcome = await coordinator.ask(request);
        if (outcome.ok) answers.push(outcome.answer);
        else refusals.push(outcome.refusal);
      }

      return { answers, refusals, complete: refusals.length === 0 };
    },

    async status() {
      const specialists = await Promise.all(
        options.registry.registered().map(async (specialist) => {
          if (!specialist.health) {
            // Null, not false. A specialist that does not report health has not
            // said it is unwell, and rendering it red would fill a console with
            // alarm for engines that are fine.
            return { id: specialist.id, healthy: null, detail: "Does not report health." };
          }
          try {
            const health = await withTimeout(specialist.health(), timeoutMs);
            return { id: specialist.id, healthy: health.healthy, detail: health.detail };
          } catch {
            return { id: specialist.id, healthy: false, detail: "Health check did not answer." };
          }
        }),
      );

      return { core: options.core, capabilities: options.registry.capabilities(), specialists };
    },
  };

  return coordinator;
}

/**
 * Builds a request with its correlation attached.
 *
 * One place, so a coordinator never receives a request without a correlation
 * id — and such a request is invisible in every trace afterwards.
 */
export function coreRequest<TCapability extends string, TInput>(input: {
  capability: TCapability;
  input: TInput;
  context: RequestContext;
  correlationId: string;
  causationId?: string;
}): CoreRequest<TCapability, TInput> {
  return {
    capability: input.capability,
    input: input.input,
    context: input.context,
    correlationId: input.correlationId,
    ...(input.causationId ? { causationId: input.causationId } : {}),
  };
}
