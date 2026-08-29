// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { diagnose, type Diagnosis, type DiagnoseInput } from "./diagnosis.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Diagnostic Bot (directive §11).
//
// V1 authority: READ evidence, READ authorized contracts, READ authorized
// architecture docs, READ relevant prior cases, ANALYZE, PROPOSE diagnosis.
//
// It must NOT: modify production, deploy changes, expand permissions, alter
// Sentinel, alter Governance.
//
// THE PROHIBITIONS ARE ENFORCED BY ABSENCE, NOT BY REFUSAL
//
// There is no `modify`, no `deploy`, no `grant`. Not methods that throw —
// methods that do not exist. A bot with a `deploy()` that refuses is one
// `if (force)` away from deploying, and the person who adds that branch will
// have a good reason at the time.
//
// Foundry Charter §18: "Foundry may design authority but may not grant it to
// itself." A diagnostic worker that can widen its own read scope has granted
// itself authority, so the scope is fixed at construction and the bot cannot
// change it.
// ─────────────────────────────────────────────────────────────────────────────

/** What this bot is allowed to read. Fixed at construction. */
export interface DiagnosticScope {
  /** Evidence for these runs only. */
  readonly runIds: readonly string[];
  /** Tenants whose evidence may be read. */
  readonly tenants: readonly string[];
  readonly mayReadContracts: boolean;
  readonly mayReadArchitectureDocs: boolean;
  readonly mayReadPriorCases: boolean;
}

export type ScopeCheck = { readonly within: true } | { readonly within: false; readonly reason: string };

export interface DiagnosticBot {
  readonly botId: string;
  readonly scope: DiagnosticScope;

  /**
   * Proposes a diagnosis. PROPOSES — the word is the authority.
   *
   * Refuses when the input reaches outside the bot's scope, rather than
   * quietly diagnosing from whatever it was handed.
   */
  proposeDiagnosis(
    input: DiagnoseInput & { runId: string; tenant: string },
  ): { proposed: true; diagnosis: Diagnosis } | { proposed: false; reason: string };

  /** Whether a read would be within scope. Exposed so callers can check first. */
  mayRead(input: { runId?: string; tenant?: string; resource?: keyof DiagnosticScope }): ScopeCheck;
}

export function createDiagnosticBot(input: {
  botId: string;
  scope: DiagnosticScope;
  /** Every proposal is announced. §16 audit: material actions are identified. */
  onProposal?: (diagnosis: Diagnosis, botId: string) => void;
}): DiagnosticBot {
  // Copied and frozen. A caller holding a mutable reference to the scope could
  // widen it after construction, which is the self-granting §18 forbids.
  const scope: DiagnosticScope = Object.freeze({
    runIds: Object.freeze([...input.scope.runIds]),
    tenants: Object.freeze([...input.scope.tenants]),
    mayReadContracts: input.scope.mayReadContracts,
    mayReadArchitectureDocs: input.scope.mayReadArchitectureDocs,
    mayReadPriorCases: input.scope.mayReadPriorCases,
  });

  const mayRead: DiagnosticBot["mayRead"] = (query) => {
    if (query.runId !== undefined && !scope.runIds.includes(query.runId)) {
      return {
        within: false,
        reason: `Run ${query.runId} is outside this bot's scope. A diagnostic worker does not widen its own reach.`,
      };
    }
    if (query.tenant !== undefined && !scope.tenants.includes(query.tenant)) {
      return {
        within: false,
        reason: `Tenant ${query.tenant} is outside this bot's scope. Reading another tenant's evidence to explain this one is a boundary crossing, whatever the motive.`,
      };
    }
    if (query.resource !== undefined && scope[query.resource] !== true) {
      return { within: false, reason: `This bot may not read ${String(query.resource)}.` };
    }
    return { within: true };
  };

  return {
    botId: input.botId,
    scope,
    mayRead,

    proposeDiagnosis(request) {
      const runCheck = mayRead({ runId: request.runId });
      if (!runCheck.within) return { proposed: false, reason: runCheck.reason };

      const tenantCheck = mayRead({ tenant: request.tenant });
      if (!tenantCheck.within) return { proposed: false, reason: tenantCheck.reason };

      // Evidence from outside the scoped tenant must not enter the analysis
      // even when the request itself is in scope — a mixed-tenant evidence set
      // is how cross-tenant inference happens without anybody intending it.
      const foreign = request.evidence.filter((e) => {
        const tenant = e.facts.tenantId;
        return typeof tenant === "string" && !scope.tenants.includes(tenant);
      });
      if (foreign.length > 0) {
        return {
          proposed: false,
          reason: `${foreign.length} evidence record(s) belong to tenants outside this bot's scope. Refusing rather than diagnosing across a tenant boundary.`,
        };
      }

      const diagnosis = diagnose(request);
      input.onProposal?.(diagnosis, input.botId);
      return { proposed: true, diagnosis };
    },
  };
}

/**
 * Charter §18: "Foundry may design authority but may not grant it to itself."
 *
 * Always false, like `absorbsAuthorityFrom` in Sentinel and
 * `healthGrantsAuthority` in Foundation. A diagnostic bot that has correctly
 * identified a problem has demonstrated competence, which is not authority —
 * and the inference from one to the other is the most sympathetic-sounding way
 * a repair system acquires powers nobody granted it.
 */
export function diagnosisGrantsRepairAuthority(_diagnosis: Diagnosis): false {
  return false;
}
