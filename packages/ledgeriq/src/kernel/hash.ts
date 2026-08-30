// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic content hashing for identity — pure, dependency-free.
//
// FNV-1a over a canonical JSON rendering. This is an IDENTITY hash (replay
// detection, deterministic EntryId), not a security primitive: tamper evidence
// is `auditiq`'s SHA-256 chain, not this. Kept free of node:crypto so the
// kernel stays importable anywhere (G-5 purity: no I/O, no platform surface).
// ─────────────────────────────────────────────────────────────────────────────

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** JSON with object keys sorted at every depth, so the same value always renders identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Deterministic EntryId from (bookId, idempotencyKey) — replay detection is a point lookup. */
export function deterministicEntryId(bookId: string, idempotencyKey: string): string {
  return `je_${fnv1a64(canonicalJson([bookId, idempotencyKey]))}`;
}
