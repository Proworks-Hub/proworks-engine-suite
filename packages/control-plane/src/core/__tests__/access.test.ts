// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DANGEROUS_OPERATIONS,
  ELEVATION_WINDOW_MS,
  ENGINE_CONSOLE_ROLES,
  EngineConsoleAccessError,
  DangerousOperationRefused,
  authorizeDangerousOperation,
  can,
  engineConsoleGrantSchema,
  requirePermission,
  resolveEngineConsoleAccess,
  type EngineConsoleGrant,
} from "../access.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const recently = new Date(NOW - 60_000).toISOString();

const grant = (over: Partial<EngineConsoleGrant> = {}): EngineConsoleGrant => ({
  subjectId: "steven",
  role: "owner",
  grantedBy: "bootstrap",
  grantedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("the boundary between owning a shop and administering the engines", () => {
  it("grants nothing to somebody who is not on the list", () => {
    // The whole control. A person with every tenant permission in existence,
    // owner of the largest shop on the platform, is not in `grants` — so there
    // is nothing to resolve and the console does not exist for them.
    expect(resolveEngineConsoleAccess([grant()], "some-shop-owner", NOW)).toBeNull();
  });

  it("has no way to be told about a tenant at all", () => {
    // A source-level guard, because this is the rule most likely to be undone
    // by a well-meaning convenience helper six months from now. The host's
    // platform guard already reads `role === "owner"` against a SHOP role,
    // which is how every shop owner became a platform admin. Engine access must
    // have no such seam, and the way to guarantee that is for this module to
    // have nowhere to put one.
    const source = readFileSync(
      join(fileURLToPath(new URL(".", import.meta.url)), "..", "access.ts"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");

    for (const forbidden of [
      "TenantContext",
      "organizationId",
      "shopId",
      "ownerRef",
      "capabilit",
      "subscription",
      "@proworks-hub/contracts",
    ]) {
      expect(code, `access.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("refuses a grant that carries a tenant, rather than ignoring it", () => {
    // `.strict()`, so an integration that tries to scope console access to an
    // organization fails at the boundary instead of silently having no effect.
    expect(() =>
      engineConsoleGrantSchema.parse({ ...grant(), organizationId: "org-1" }),
    ).toThrow();
  });

  it("treats an expired grant as no grant", () => {
    const expired = grant({ expiresAt: new Date(NOW - 1).toISOString() });
    expect(resolveEngineConsoleAccess([expired], "steven", NOW)).toBeNull();
  });

  it("treats an unparseable expiry as expired", () => {
    // The other way round turns a typo into an indefinite grant, and nobody
    // reviewing the list would see anything wrong.
    const broken = grant({ expiresAt: "next tuesday" });
    expect(resolveEngineConsoleAccess([broken], "steven", NOW)).toBeNull();
  });

  it("resolves a live grant, carrying who issued it", () => {
    const access = resolveEngineConsoleAccess([grant()], "steven", NOW);
    expect(access?.role).toBe("owner");
    expect(access?.grantedBy).toBe("bootstrap");
  });
});

describe("what each console role may do", () => {
  const accessFor = (role: EngineConsoleGrant["role"]) =>
    resolveEngineConsoleAccess([grant({ role })], "steven", NOW);

  it("gives the owner everything, including granting access", () => {
    expect(can(accessFor("owner"), "engine.access.manage")).toBe(true);
    expect(can(accessFor("owner"), "engine.data.clear")).toBe(true);
  });

  it("lets an engineer debug and test in a sandbox, but not against production", () => {
    const engineer = accessFor("engineer");
    expect(can(engineer, "engine.diagnostics.view")).toBe(true);
    expect(can(engineer, "engine.test.sandbox")).toBe(true);
    expect(can(engineer, "engine.test.production")).toBe(false);
    expect(can(engineer, "engine.config.edit.development")).toBe(true);
    expect(can(engineer, "engine.config.edit.production")).toBe(false);
  });

  it("does not let an engineer delete production data or grant access", () => {
    expect(can(accessFor("engineer"), "engine.data.clear")).toBe(false);
    expect(can(accessFor("engineer"), "engine.access.manage")).toBe(false);
  });

  it("gives operations safe controls and no configuration authorship", () => {
    const ops = accessFor("operations");
    expect(can(ops, "engine.operate")).toBe(true);
    expect(can(ops, "engine.config.view")).toBe(true);
    expect(can(ops, "engine.config.edit.development")).toBe(false);
    expect(can(ops, "engine.disable")).toBe(false);
  });

  it("keeps support read-only, and out of the intelligence data", () => {
    const support = accessFor("support");
    expect(can(support, "engine.diagnostics.view")).toBe(true);
    expect(can(support, "engine.operate")).toBe(false);
    // What one shop's corrections taught an engine is not support's to browse
    // while answering a ticket for a different shop.
    expect(can(support, "engine.intelligence.view")).toBe(false);
  });

  it("keeps the auditor to history, with no live surface", () => {
    const auditor = accessFor("auditor");
    expect(can(auditor, "engine.audit.view")).toBe(true);
    expect(can(auditor, "engine.operate")).toBe(false);
    expect(can(auditor, "engine.diagnostics.view")).toBe(false);
    expect(can(auditor, "engine.test.sandbox")).toBe(false);
  });

  it("gives only the owner the four irreversible permissions", () => {
    // Named individually rather than counted, so adding a permission to a role
    // has to be a deliberate edit here too.
    for (const permission of [
      "engine.data.clear",
      "engine.migration.run",
      "engine.rollback",
      "engine.intelligence.promote",
    ] as const) {
      const holders = (Object.keys(ENGINE_CONSOLE_ROLES) as (keyof typeof ENGINE_CONSOLE_ROLES)[])
        .filter((role) => ENGINE_CONSOLE_ROLES[role].includes(permission));
      expect(holders, permission).toEqual(["owner"]);
    }
  });

  it("throws with the permission named, so a refusal is explicable", () => {
    expect(() => requirePermission(accessFor("support"), "engine.disable")).toThrow(
      EngineConsoleAccessError,
    );
    try {
      requirePermission(accessFor("support"), "engine.disable");
    } catch (error) {
      expect((error as EngineConsoleAccessError).message).toContain("engine.disable");
      expect((error as EngineConsoleAccessError).held).toBe("support");
    }
  });

  it("refuses everything when there is no access at all", () => {
    expect(can(null, "engine.view")).toBe(false);
    expect(() => requirePermission(null, "engine.view")).toThrow(EngineConsoleAccessError);
  });
});

describe("dangerous operations", () => {
  const owner = resolveEngineConsoleAccess([grant()], "steven", NOW);

  const request = (over: Record<string, unknown> = {}) => ({
    access: owner,
    operation: "engine.data.clear" as const,
    target: { type: "engine", id: "visioniq" },
    reason: "Clearing the failed prep queue after the 2026-08-26 incident.",
    confirmedTarget: "visioniq",
    elevatedAt: recently,
    now: NOW,
    ...over,
  });

  it("returns the audit record as the result, so it cannot be skipped", () => {
    // The caller cannot perform the operation without holding the thing that
    // has to be written down. A separate `audit()` call is one somebody forgets
    // in the error path, which is the path that matters.
    const record = authorizeDangerousOperation(request());
    expect(record).toMatchObject({
      operation: "engine.data.clear",
      actor: "steven",
      role: "owner",
      target: { type: "engine", id: "visioniq" },
      elevated: true,
    });
    expect(record.occurredAt).toBe(new Date(NOW).toISOString());
    expect(record.reason).toContain("2026-08-26");
  });

  it("refuses without the permission, whatever else is correct", () => {
    const engineer = resolveEngineConsoleAccess([grant({ role: "engineer" })], "steven", NOW);
    expect(() => authorizeDangerousOperation(request({ access: engineer }))).toThrow(
      EngineConsoleAccessError,
    );
  });

  it("refuses a reason nobody could act on", () => {
    // A reason field that accepts "x" is decoration. This one is read months
    // later by somebody asking why production changed.
    for (const reason of ["", "   ", "fix", "asdf"]) {
      expect(() => authorizeDangerousOperation(request({ reason })), reason).toThrow(
        DangerousOperationRefused,
      );
    }
  });

  it("refuses until the operator types the target's name", () => {
    expect(() => authorizeDangerousOperation(request({ confirmedTarget: "forgeiq" }))).toThrow(
      /Type "visioniq" to confirm/,
    );
    expect(() => authorizeDangerousOperation(request({ confirmedTarget: undefined }))).toThrow(
      DangerousOperationRefused,
    );
  });

  it("refuses a stale re-authentication", () => {
    const stale = new Date(NOW - ELEVATION_WINDOW_MS - 1000).toISOString();
    expect(() => authorizeDangerousOperation(request({ elevatedAt: stale }))).toThrow(/Re-authentication/);
    expect(() => authorizeDangerousOperation(request({ elevatedAt: undefined }))).toThrow(/Re-authentication/);
  });

  it("refuses a re-authentication timestamped in the future", () => {
    // Otherwise a clock skew, or a client that sends its own timestamp, buys
    // an indefinite elevation.
    const ahead = new Date(NOW + 60_000).toISOString();
    expect(() => authorizeDangerousOperation(request({ elevatedAt: ahead }))).toThrow(/Re-authentication/);
  });

  it("lets access be revoked fast, and still records it", () => {
    // The one destructive-sounding operation that must not be hard: during an
    // incident, locking somebody out quickly matters more than being certain.
    const record = authorizeDangerousOperation(
      request({
        operation: "engine.access.revoke",
        target: { type: "subject", id: "former-contractor" },
        confirmedTarget: undefined,
        elevatedAt: undefined,
        reason: "Contractor engagement ended on 2026-08-26.",
      }),
    );
    expect(record.elevated).toBe(false);
    expect(record.actor).toBe("steven");
  });

  it("names a permission for every dangerous operation", () => {
    // A dangerous operation with no permission would authorize by default.
    for (const [operation, spec] of Object.entries(DANGEROUS_OPERATIONS)) {
      expect(spec.permission, operation).toBeTruthy();
      expect(spec.summary.length, operation).toBeGreaterThan(10);
    }
  });

  it("requires re-authentication for everything that destroys or reaches production", () => {
    for (const operation of [
      "engine.data.clear",
      "engine.migration.run",
      "engine.rollback",
      "engine.config.publish.production",
      "engine.test.against.production",
      "engine.disable",
    ] as const) {
      expect(DANGEROUS_OPERATIONS[operation].requiresReauthentication, operation).toBe(true);
    }
  });

  it("carries before and after into the record when they are supplied", () => {
    const record = authorizeDangerousOperation(
      request({
        operation: "engine.routing.change",
        confirmedTarget: undefined,
        before: { route: "forgeiq" },
        after: { route: "forgeiq-canary" },
      }),
    );
    expect(record.before).toEqual({ route: "forgeiq" });
    expect(record.after).toEqual({ route: "forgeiq-canary" });
  });
});
