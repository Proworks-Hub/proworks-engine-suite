// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Where the engine keeps small preferences.
//
// Three extracted modules persisted things directly to `localStorage`:
// operator recipe variants, the manual QA checklist, and studio settings. Each
// reached for the global, which a portable engine cannot do — a licensee
// running VisionIQ in a Node service has no `localStorage`, and the suite's
// portability guard rejects ambient I/O by name. It caught all three.
//
// One port rather than three. They persist the same KIND of thing — small
// per-operator preferences — so a host wires storage once and every module that
// needs it is served. Three separate ports would mean a host could wire two of
// them and silently lose the third.
//
// UNWIRED IS NOT AN ERROR. Nothing here is required for preparation to work:
// without a store, preferences last the session and everything else behaves
// identically. That is already what happened outside a browser before
// extraction, so no existing path regressed. It fails quiet rather than closed,
// because a shop losing a checklist tick is not a shop that should stop
// working.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The slice of Web Storage the engine uses.
 *
 * `localStorage` satisfies this structurally, so a browser host wires it in one
 * line: `setVisionStorage(window.localStorage)`.
 */
export interface VisionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let store: VisionStorage | null = null;

/** Wires persistence. `null` detaches it, and preferences become per-session. */
export function setVisionStorage(next: VisionStorage | null): void {
  store = next;
}

/** The wired store, or `null`. Callers must handle `null` — see the header. */
export function getVisionStorage(): VisionStorage | null {
  return store;
}

/**
 * Reads and parses a stored JSON value.
 *
 * Returns the fallback on absent, unparseable, or throwing storage. This is
 * user-writable state: a browser extension, a half-finished migration or a
 * hand-edited devtools value all land here, and a crash on read would lock
 * somebody out of a working screen over a stale preference.
 */
export function readJson<T>(key: string, fallback: T): T {
  const current = store;
  if (!current) return fallback;
  try {
    const raw = current.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Writes a JSON value, ignoring a full quota. Returns whether it persisted. */
export function writeJson(key: string, value: unknown): boolean {
  const current = store;
  if (!current) return false;
  try {
    current.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // A full quota must not take a shop floor down mid-job.
    return false;
  }
}

/** Removes a key, if there is anywhere to remove it from. */
export function removeKey(key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // Same reasoning as writeJson.
  }
}
