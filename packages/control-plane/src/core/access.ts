// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Who may open the engine console.
//
// THIS FILE DELIBERATELY CANNOT SEE A TENANT.
//
// There is no import of TenantContext, no capability lookup, no organization
// id, and no function anywhere below that turns a shop role into console
// access. That absence is the security control — not a comment asking people to
// be careful, but a module that has nothing to be careless with.
//
// The reason is concrete rather than theoretical. The host's existing platform
// guard reads:
//
//     isPlatformAdmin = role === "owner" || permissions.includes("platform.read")
//
// where `role` is the caller's role in THEIR OWN SHOP. Every shop owner on the
// platform therefore satisfies it. Whatever that means for platform
// administration, engine administration must not inherit it — and the only
// dependable way to guarantee that is for engine access to be a separate list
// of named people that nothing else can write to.
//
// Three layers, three authorities:
//
//   Customer / shop administration — the tenant's own roles. Their shop.
//   Platform administration        — tenant support and platform operations.
//   Engine administration          — THIS. Named internal engineers, nothing else.
//
// A subject holds engine console access because somebody explicitly granted it,
// recorded who did so and when. Not because of what they bought, not because of
// what they own, not because of a role that happens to be spelt "owner".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the console can do. A closed set: a permission that is not here
 * cannot be requested, so a new panel cannot quietly ship ungated.
 */
export const engineConsolePermissionSchema = z.enum([
  /** See that an engine exists, its status, its headline metrics. */
  "engine.view",
  /** Errors, stack references, retry state, failing correlation ids. */
  "engine.diagnostics.view",
  "engine.events.view",
  "engine.performance.view",
  "engine.versions.view",
  "engine.audit.view",
  /** Read configuration. Separate from changing it, on purpose. */
  "engine.config.view",
  "engine.config.edit.development",
  /** Changing what production actually runs on. Dangerous. */
  "engine.config.edit.production",
  /** Send controlled input through an engine, in a sandbox. */
  "engine.test.sandbox",
  /** Send controlled input through PRODUCTION. Dangerous. */
  "engine.test.production",
  /** Safe operational controls: retry a failed job, drain a queue. */
  "engine.operate",
  /** What an engine has learned, and from whom. */
  "engine.intelligence.view",
  /** Move one tenant's learned knowledge into the global set. Dangerous. */
  "engine.intelligence.promote",
  /** Model providers, token usage, spend. */
  "engine.ai.view",
  /** Change which provider or model an engine uses. Dangerous. */
  "engine.ai.configure",
  /** Turn an engine off. Dangerous. */
  "engine.disable",
  /** Change how Prime routes. Dangerous. */
  "engine.routing.change",
  /** Delete operational data. Dangerous. */
  "engine.data.clear",
  "engine.migration.run",
  "engine.rollback",
  /** Grant or revoke console access. Dangerous, and the root of the rest. */
  "engine.access.manage",
]);
export type EngineConsolePermission = z.infer<typeof engineConsolePermissionSchema>;

const P = engineConsolePermissionSchema.enum;

export const engineConsoleRoleSchema = z.enum([
  "owner",
  "engineer",
  "operations",
  "support",
  "auditor",
]);
export type EngineConsoleRole = z.infer<typeof engineConsoleRoleSchema>;

const READ_ONLY: readonly EngineConsolePermission[] = [
  P["engine.view"],
  P["engine.events.view"],
  P["engine.performance.view"],
  P["engine.versions.view"],
];

/**
 * What each role may do.
 *
 * Written out per role rather than layered, so reading one line answers the
 * question. An inheritance chain is shorter to write and much easier to widen
 * by accident — adding a permission to `support` because it belonged on
 * `engineer` is a mistake nobody sees in a diff.
 */
export const ENGINE_CONSOLE_ROLES: Readonly<
  Record<EngineConsoleRole, readonly EngineConsolePermission[]>
> = {
  /** Everything, including the ability to grant everything. One or two people. */
  owner: engineConsolePermissionSchema.options,

  /** Builds and debugs the engines. Not trusted with production data deletion. */
  engineer: [
    ...READ_ONLY,
    P["engine.diagnostics.view"],
    P["engine.config.view"],
    P["engine.config.edit.development"],
    P["engine.test.sandbox"],
    P["engine.operate"],
    P["engine.intelligence.view"],
    P["engine.ai.view"],
    P["engine.audit.view"],
  ],

  /** Keeps it running. Safe controls only; no configuration authorship. */
  operations: [
    ...READ_ONLY,
    P["engine.diagnostics.view"],
    P["engine.config.view"],
    P["engine.operate"],
    P["engine.ai.view"],
  ],

  /**
   * Investigating a tenant's problem. Read-only, and no intelligence access —
   * a support question is answered from diagnostics, and what one shop's
   * corrections taught an engine is not support's to browse.
   */
  support: [...READ_ONLY, P["engine.diagnostics.view"]],

  /** History, and nothing live. */
  auditor: [
    P["engine.view"],
    P["engine.events.view"],
    P["engine.versions.view"],
    P["engine.audit.view"],
    P["engine.config.view"],
  ],
};

// ── Grants ───────────────────────────────────────────────────────────────────

/**
 * One named internal person's console access.
 *
 * Note what is NOT here: no organizationId, no shopId, no capability list, no
 * subscription tier. There is nowhere to put one, so no code path can come to
 * depend on one.
 *
 * `grantedBy` is required. An access record that cannot say who created it is
 * one nobody can review, and access lists are reviewed by asking "why does this
 * person have this?"
 */
export const engineConsoleGrantSchema = z
  .object({
    /** The internal identity. Whatever the host's directory calls a person. */
    subjectId: z.string().min(1),
    role: engineConsoleRoleSchema,
    grantedBy: z.string().min(1),
    grantedAt: z.string().min(1),
    /**
     * When it lapses. Optional, and worth setting for contractors and for
     * anyone granted `owner` temporarily.
     */
    expiresAt: z.string().min(1).optional(),
    /** Why this person has this. Read during access review. */
    reason: z.string().min(1).optional(),
  })
  .strict();
export type EngineConsoleGrant = z.infer<typeof engineConsoleGrantSchema>;

export interface EngineConsoleAccess {
  readonly subjectId: string;
  readonly role: EngineConsoleRole;
  readonly permissions: ReadonlySet<EngineConsolePermission>;
  readonly grantedBy: string;
  readonly expiresAt?: string;
}

/**
 * Resolves a subject's access from the grant list, or nothing.
 *
 * Returns `null` rather than an empty access object. An empty set of
 * permissions still reads as "logged into the console", and the console should
 * not exist at all for someone with no grant — §1: never exposed through normal
 * navigation.
 *
 * An expired grant is no grant. Checked here rather than at each call site,
 * because the call site that forgets is the one that matters.
 */
export function resolveEngineConsoleAccess(
  grants: readonly EngineConsoleGrant[],
  subjectId: string,
  now: number,
): EngineConsoleAccess | null {
  const grant = grants.find((g) => g.subjectId === subjectId);
  if (!grant) return null;

  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    // An unparseable expiry is treated as expired. The alternative — ignoring
    // it and granting access — turns a typo into an indefinite grant.
    if (Number.isNaN(expiry) || expiry <= now) return null;
  }

  return {
    subjectId: grant.subjectId,
    role: grant.role,
    permissions: new Set(ENGINE_CONSOLE_ROLES[grant.role]),
    grantedBy: grant.grantedBy,
    expiresAt: grant.expiresAt,
  };
}

export class EngineConsoleAccessError extends Error {
  readonly required: EngineConsolePermission;
  readonly held: EngineConsoleRole | null;

  constructor(required: EngineConsolePermission, held: EngineConsoleRole | null) {
    super(
      held
        ? `Engine console permission "${required}" is required; the ${held} role does not hold it.`
        : `Engine console permission "${required}" is required; the caller has no engine console grant.`,
    );
    this.name = "EngineConsoleAccessError";
    this.required = required;
    this.held = held;
  }
}

export function can(
  access: EngineConsoleAccess | null,
  permission: EngineConsolePermission,
): boolean {
  return access?.permissions.has(permission) ?? false;
}

export function requirePermission(
  access: EngineConsoleAccess | null,
  permission: EngineConsolePermission,
): asserts access is EngineConsoleAccess {
  if (!can(access, permission)) {
    throw new EngineConsoleAccessError(permission, access?.role ?? null);
  }
}

// ── Dangerous operations ─────────────────────────────────────────────────────

export const dangerousOperationSchema = z.enum([
  "engine.disable",
  "engine.routing.change",
  "engine.config.publish.production",
  "engine.data.clear",
  "engine.migration.run",
  "engine.rollback",
  "engine.intelligence.promote.global",
  "engine.ai.provider.change",
  "engine.test.against.production",
  "engine.access.grant",
  "engine.access.revoke",
]);
export type DangerousOperation = z.infer<typeof dangerousOperationSchema>;

export interface DangerousOperationSpec {
  readonly operation: DangerousOperation;
  readonly permission: EngineConsolePermission;
  /** What an operator is about to do, in the confirmation dialog. */
  readonly summary: string;
  /**
   * Whether a fresh authentication is required within the elevation window.
   *
   * Reserved for operations that destroy something or change what production
   * runs. Requiring it everywhere teaches people to type their password
   * without reading, which removes the protection from the cases that needed it.
   */
  readonly requiresReauthentication: boolean;
  /** Whether the operator must type the target's name to proceed. */
  readonly requiresTargetConfirmation: boolean;
}

export const DANGEROUS_OPERATIONS: Readonly<
  Record<DangerousOperation, DangerousOperationSpec>
> = {
  "engine.disable": {
    operation: "engine.disable",
    permission: P["engine.disable"],
    summary: "Stop an engine from accepting work.",
    requiresReauthentication: true,
    requiresTargetConfirmation: true,
  },
  "engine.routing.change": {
    operation: "engine.routing.change",
    permission: P["engine.routing.change"],
    summary: "Change how Prime routes work between engines.",
    requiresReauthentication: true,
    requiresTargetConfirmation: false,
  },
  "engine.config.publish.production": {
    operation: "engine.config.publish.production",
    permission: P["engine.config.edit.production"],
    summary: "Publish configuration to production.",
    requiresReauthentication: true,
    requiresTargetConfirmation: false,
  },
  "engine.data.clear": {
    operation: "engine.data.clear",
    permission: P["engine.data.clear"],
    summary: "Permanently delete operational data.",
    requiresReauthentication: true,
    requiresTargetConfirmation: true,
  },
  "engine.migration.run": {
    operation: "engine.migration.run",
    permission: P["engine.migration.run"],
    summary: "Run a data migration.",
    requiresReauthentication: true,
    requiresTargetConfirmation: true,
  },
  "engine.rollback": {
    operation: "engine.rollback",
    permission: P["engine.rollback"],
    summary: "Roll an engine back to a previous version.",
    requiresReauthentication: true,
    requiresTargetConfirmation: false,
  },
  "engine.intelligence.promote.global": {
    operation: "engine.intelligence.promote.global",
    permission: P["engine.intelligence.promote"],
    summary: "Promote learned knowledge from one tenant into the global set.",
    requiresReauthentication: true,
    requiresTargetConfirmation: false,
  },
  "engine.ai.provider.change": {
    operation: "engine.ai.provider.change",
    permission: P["engine.ai.configure"],
    summary: "Change which model or provider an engine uses.",
    requiresReauthentication: true,
    requiresTargetConfirmation: false,
  },
  "engine.test.against.production": {
    operation: "engine.test.against.production",
    permission: P["engine.test.production"],
    summary: "Send test input through the production engine.",
    requiresReauthentication: true,
    requiresTargetConfirmation: true,
  },
  "engine.access.grant": {
    operation: "engine.access.grant",
    permission: P["engine.access.manage"],
    summary: "Grant a person engine console access.",
    requiresReauthentication: true,
    requiresTargetConfirmation: false,
  },
  "engine.access.revoke": {
    operation: "engine.access.revoke",
    permission: P["engine.access.manage"],
    summary: "Revoke a person's engine console access.",
    // Revoking access is the one destructive-sounding operation that should
    // never be hard: during an incident, locking someone out fast matters more
    // than being sure. It is still audited.
    requiresReauthentication: false,
    requiresTargetConfirmation: false,
  },
};

/** Shortest reason that is actually a reason. "x" and "asdf" are not. */
export const MIN_REASON_LENGTH = 10;

/** How long a re-authentication counts for. */
export const ELEVATION_WINDOW_MS = 5 * 60 * 1000;

export interface DangerousOperationRequest {
  access: EngineConsoleAccess | null;
  operation: DangerousOperation;
  /** What is being acted on: an engine id, a config key, a subject id. */
  target: { type: string; id: string };
  /** Free text from the operator, recorded permanently. */
  reason: string;
  /** What the operator typed to confirm, when the spec demands it. */
  confirmedTarget?: string;
  /** ISO timestamp of the operator's last re-authentication, if any. */
  elevatedAt?: string;
  now: number;
  /** Values changing, for the audit trail. Never secrets. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export class DangerousOperationRefused extends Error {
  readonly operation: DangerousOperation;
  readonly cause_: "permission" | "reason" | "confirmation" | "elevation";

  constructor(operation: DangerousOperation, cause: DangerousOperationRefused["cause_"], message: string) {
    super(message);
    this.name = "DangerousOperationRefused";
    this.operation = operation;
    this.cause_ = cause;
  }
}

/**
 * The record a dangerous operation leaves behind.
 *
 * Shaped to drop straight into the shared `AuditEntry` a host persists — the
 * console does not own a second audit system, it produces entries for the one
 * that exists.
 */
export interface DangerousOperationRecord {
  readonly operation: DangerousOperation;
  readonly actor: string;
  readonly role: EngineConsoleRole;
  readonly target: { type: string; id: string };
  readonly reason: string;
  readonly occurredAt: string;
  readonly elevated: boolean;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
}

/**
 * Checks everything that must be true before a dangerous operation runs, and
 * returns the record of it having been allowed.
 *
 * One function rather than four checks at each call site, because the call site
 * that skips one is the call site that deletes something. The audit record is
 * the RETURN VALUE for the same reason: a caller cannot perform the operation
 * without holding the thing that must be written down.
 *
 * It does not perform the operation and never will. This package observes the
 * engines; the host that owns the data does the deleting.
 */
export function authorizeDangerousOperation(
  request: DangerousOperationRequest,
): DangerousOperationRecord {
  const spec = DANGEROUS_OPERATIONS[request.operation];
  if (!spec) {
    throw new DangerousOperationRefused(
      request.operation,
      "permission",
      `Unknown operation "${request.operation}".`,
    );
  }

  if (!can(request.access, spec.permission)) {
    throw new EngineConsoleAccessError(spec.permission, request.access?.role ?? null);
  }
  const access = request.access as EngineConsoleAccess;

  if (request.reason.trim().length < MIN_REASON_LENGTH) {
    throw new DangerousOperationRefused(
      request.operation,
      "reason",
      `A reason of at least ${MIN_REASON_LENGTH} characters is required. This is read months later by someone asking why production changed.`,
    );
  }

  if (spec.requiresTargetConfirmation && request.confirmedTarget !== request.target.id) {
    throw new DangerousOperationRefused(
      request.operation,
      "confirmation",
      `Type "${request.target.id}" to confirm. ${spec.summary}`,
    );
  }

  let elevated = false;
  if (spec.requiresReauthentication) {
    const elevatedAt = request.elevatedAt ? Date.parse(request.elevatedAt) : Number.NaN;
    if (Number.isNaN(elevatedAt) || request.now - elevatedAt > ELEVATION_WINDOW_MS || elevatedAt > request.now) {
      throw new DangerousOperationRefused(
        request.operation,
        "elevation",
        `Re-authentication is required within ${ELEVATION_WINDOW_MS / 60000} minutes of this operation.`,
      );
    }
    elevated = true;
  }

  return {
    operation: request.operation,
    actor: access.subjectId,
    role: access.role,
    target: request.target,
    reason: request.reason.trim(),
    occurredAt: new Date(request.now).toISOString(),
    elevated,
    before: request.before,
    after: request.after,
  };
}
