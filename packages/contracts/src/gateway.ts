// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// The boundary a request crosses on its way in.
//
// This is the CONTRACT for a gateway, not a gateway. The engines are libraries
// consumed in-process today; an HTTP tier serving no caller would be weight
// without benefit. What matters now is that the shape is fixed, so a gateway
// can be added later without an engine changing.
//
// The rule that makes it worth having: **a request is not trusted until it has
// been through here.** Everything downstream reads a RequestContext and treats
// its tenant and claims as already verified — which is only safe if exactly one
// place does the verifying.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who the caller is, as established by whatever authenticated them.
 *
 * Engines never authenticate. They receive this and believe it, which is why
 * the boundary that produces it is the security-critical part of the system.
 */
export const identityClaimsSchema = z
  .object({
    /** Stable identifier for the human or service. */
    subject: z.string().min(1),
    kind: z.enum(["user", "service", "api-key", "anonymous"]),
    /** Coarse role names. Evidence for Governance, never a decision. */
    roles: z.array(z.string()).default([]),
    /**
     * What the caller CLAIMS it may do. Renamed from `permissions` (DEC-017).
     *
     * EVIDENCE, NOT AUTHORITY. The old name invited the collapse the
     * Constitution forbids in §1.9 — "Capability does not imply permission" —
     * because a downstream engine reading a field called `permissions` will
     * eventually treat it as one. Nothing consumed it, so the rename is clean
     * rather than staged.
     *
     * Only a `GovernanceDecision` authorizes. These claims may inform that
     * decision and can never substitute for it.
     */
    assertedCapabilities: z.array(z.string()).default([]),
    /** When these stop being believable. */
    expiresAt: z.string().optional(),
  })
  .strict();
export type IdentityClaims = z.infer<typeof identityClaimsSchema>;

export const requestContextSchema = z
  .object({
    requestId: z.string().min(1),
    /** Verified at the boundary. Never taken from a client-supplied field. */
    tenant: tenantContextSchema,
    identity: identityClaimsSchema,
    trace: traceContextSchema,
    /** Which API version the caller asked for. */
    apiVersion: z.string().default("v1"),
    receivedAt: z.string().min(1),
    /** For rate limiting and audit. Never used as identity. */
    clientIp: z.string().optional(),
    userAgent: z.string().optional(),
  })
  .strict();
export type RequestContext = z.infer<typeof requestContextSchema>;

/**
 * Raised when a caller is authenticated but not allowed.
 *
 * Distinct from a generic error because the correct response differs: this is
 * a 403 and a permanent failure, and retrying it will never help.
 */
export class AuthorizationError extends Error {
  readonly transient = false as const;
  constructor(
    readonly permission: string,
    readonly subject: string,
  ) {
    super(`"${subject}" lacks the "${permission}" permission`);
    this.name = "AuthorizationError";
  }
}

/**
 * Decides whether a caller may do something.
 *
 * A port so a host owns its own policy — ProWorks has shop roles, Family Table
 * has household adults and children, and neither belongs in an engine.
 */
export interface Authorizer {
  can(context: RequestContext, permission: string, resource?: { type: string; id: string }): boolean | Promise<boolean>;
}

/**
 * Throws unless the caller holds the permission.
 *
 * Deliberately a throw rather than a boolean. A caller that can ignore the
 * answer will eventually ignore it, and the failure mode is silent data access
 * across a tenant boundary.
 */
export async function requirePermission(
  authorizer: Authorizer,
  context: RequestContext,
  permission: string,
  resource?: { type: string; id: string },
): Promise<void> {
  const allowed = await authorizer.can(context, permission, resource);
  if (!allowed) throw new AuthorizationError(permission, context.identity.subject);
}

// ── Rate limiting ────────────────────────────────────────────────────────────

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** When the window resets, so a caller can be told rather than guess. */
  resetAt: string;
  /** Present when refused — how long to wait, which a 429 should carry. */
  retryAfterMs?: number;
}

export interface RateLimitRule {
  /** What is being limited: a user, an organization, an API key, an endpoint. */
  scope: string;
  limit: number;
  windowMs: number;
}

/**
 * A port, so limits are enforced at the boundary rather than scattered through
 * domain code. An engine that knows about rate limits has taken on a concern
 * that belongs to whoever is exposed to the internet.
 */
export interface RateLimiter {
  check(key: string, rule: RateLimitRule): RateLimitDecision | Promise<RateLimitDecision>;
  reset(key: string): void | Promise<void>;
}

/** Builds the key a limit is counted against, so scoping is consistent. */
export function rateLimitKey(
  scope: "organization" | "user" | "api-key" | "endpoint",
  context: RequestContext,
  endpoint?: string,
): string {
  switch (scope) {
    case "organization":
      return `org:${context.tenant.organizationId}`;
    case "user":
      return `user:${context.identity.subject}`;
    case "api-key":
      return `key:${context.identity.subject}`;
    case "endpoint":
      return `endpoint:${endpoint ?? "unknown"}:${context.tenant.organizationId}`;
  }
}
