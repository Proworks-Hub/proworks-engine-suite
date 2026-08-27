// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Who this data belongs to.
//
// Three engines grew three words for adjacent ideas — ForgeIQ persists `orgId`,
// CostIQ passes `tenantId`, ReceiptIQ carries an opaque `ownerRef` — and the
// one package that could reconcile them said nothing at all. This file is that
// reconciliation.
//
// The rule it encodes is the one that must not bend: **tenancy never touches
// canonical knowledge.** A shared fact about a product, a merchant or a price
// belongs to nobody. The moment a canonical record can name its contributor,
// the shared-knowledge layer has quietly become a shared-DATA layer, which is
// the single failure the whole design exists to prevent.
//
// ReceiptIQ enforced that at runtime first. This file adds the type-level half,
// so the mistake fails to compile rather than failing on a good day in a test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every persisted record carries one of these. There is no default: a record
 * whose ownership was never decided is a record that eventually leaks.
 *
 * - `canonical`      — shared knowledge. Identifies a product, a merchant or a
 *                      price; identifies no person, business or device.
 * - `host-private`   — belongs to one host application. Family Table's receipts
 *                      are invisible to ProWorks and the reverse.
 * - `tenant-private` — belongs to one tenant within a host: one household, one
 *                      shop. Invisible to that host's other tenants.
 */
export const ownershipClassSchema = z.enum(["canonical", "host-private", "tenant-private"]);
export type OwnershipClass = z.infer<typeof ownershipClassSchema>;

/**
 * Who is asking, resolved by the host and trusted by the engine.
 *
 * Engines do not authenticate. A host establishes identity and hands this down
 * already verified — which is why `organizationId` is required: an engine that
 * accepts an optional tenant has no way to tell "not applicable" from
 * "somebody forgot", and one of those two is a data leak.
 */
export const tenantContextSchema = z
  .object({
    /** The business. Required — the unit that owns private data. */
    organizationId: z.string().min(1),
    /** A site or shop within the business, when the host distinguishes them. */
    shopId: z.string().min(1).optional(),
    /** Who is acting. Absent for system-initiated work. */
    userId: z.string().min(1).optional(),
    /** Host-resolved authorization. Engines read these; they never grant them. */
    roles: z.array(z.string()).default([]),
  })
  .strict();
export type TenantContext = z.infer<typeof tenantContextSchema>;

/** Field names that must never appear on a canonical record. */
export const IDENTITY_FIELD_WORDS: ReadonlySet<string> = new Set([
  "household", "user", "member", "person", "family", "account", "device",
  "email", "phone", "address", "postcode", "zip", "latitude", "longitude",
  "ip", "owner", "tenant", "uid", "ssn", "organization", "shop",
]);

/** Exact names that identify even though their words look innocuous. */
const IDENTITY_FIELD_NAMES: ReadonlySet<string> = new Set([
  "createdby", "submittedby", "capturedby", "authuid", "sub",
]);

/** Splits `householdId`, `household_id` and `HOUSEHOLD-ID` into comparable words. */
function fieldWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Refuses an object that carries anything capable of identifying who produced
 * it. Descends into nested objects and arrays, because the realistic failure is
 * a host attaching `{ meta: { organizationId } }` and nobody noticing until the
 * shared database already holds a year of it.
 *
 * Matched as whole words rather than substrings. A guard that rejects
 * `ownership` for containing `owner` gets switched off, which is worse than no
 * guard at all.
 *
 * Throws rather than returning false: this is a boundary violation, not a
 * validation failure, and a caller who could ignore the result would.
 */
export function assertNoIdentityFields(value: unknown, path = "record"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNoIdentityFields(entry, `${path}[${i}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const words = fieldWords(key);
    const offending = words.find((w) => IDENTITY_FIELD_WORDS.has(w));
    if (offending || IDENTITY_FIELD_NAMES.has(words.join(""))) {
      throw new Error(
        `Canonical records must not identify anyone. Found "${key}" at ${path}. ` +
          `If this is a private record, classify it as host-private or tenant-private instead.`,
      );
    }
    assertNoIdentityFields(entry, `${path}.${key}`);
  }
}

/**
 * The type-level half of the same rule.
 *
 * `Canonical<T>` marks a shape as shared knowledge and makes the tenancy fields
 * impossible to set — assigning one is a compile error, not a runtime surprise.
 * Use it on anything that crosses into a shared store.
 *
 *   type SharedPrice = Canonical<{ itemKey: string; cents: number }>;
 *   const bad: SharedPrice = { itemKey: "x", cents: 1, organizationId: "o" };
 *   //                                                 ^ does not compile
 */
export type Canonical<T> = T & {
  ownership: "canonical";
  organizationId?: never;
  shopId?: never;
  userId?: never;
  tenantId?: never;
  ownerRef?: never;
};

/** Marks a shape as belonging to one host application. */
export type HostPrivate<T> = T & { ownership: "host-private"; ownerRef: string };

/** Marks a shape as belonging to one tenant within a host. */
export type TenantPrivate<T> = T & { ownership: "tenant-private"; ownerRef: string };

/**
 * Derives the opaque owner reference a private record carries.
 *
 * Engines deliberately never see a TenantContext on stored records — they carry
 * this string instead, which they treat as meaningless. That is what lets one
 * engine serve two applications without either becoming able to interpret, and
 * therefore enumerate, the other's records.
 *
 * The shape is stable and greppable so an operator can still trace a record
 * back through a host that holds the mapping.
 */
export function ownerRefFor(context: TenantContext): string {
  return context.shopId
    ? `org:${context.organizationId}/shop:${context.shopId}`
    : `org:${context.organizationId}`;
}
