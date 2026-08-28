// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { parseEngineManifest, type EngineManifest } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// The list of things the console knows about.
//
// Built from manifests, tolerant of the ones it cannot read. A registry that
// throws when one manifest is malformed takes the whole dashboard down with it,
// which is precisely backwards: the reason to open the console is that
// something is wrong.
//
// So a bad manifest becomes a `problem` the console can display, and the other
// eight engines still render.
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryProblem {
  /** The id if it could be read, otherwise the position in the input. */
  readonly at: string;
  readonly error: string;
}

export interface EngineRegistry {
  /** Engines, in the order given. Array order is display order — no sort field to drift. */
  readonly engines: readonly EngineManifest[];
  /** Platform services: tracking, notifications, the bus. Counted separately, always. */
  readonly services: readonly EngineManifest[];
  readonly all: readonly EngineManifest[];
  get(id: string): EngineManifest | undefined;
  /** Manifests that could not be read, and why. Shown, not swallowed. */
  readonly problems: readonly RegistryProblem[];
  /** Fields dropped because a manifest came from a newer build, by engine id. */
  readonly droppedFields: Readonly<Record<string, readonly string[]>>;
}

export function createEngineRegistry(inputs: readonly unknown[]): EngineRegistry {
  const byId = new Map<string, EngineManifest>();
  const ordered: EngineManifest[] = [];
  const problems: RegistryProblem[] = [];
  const droppedFields: Record<string, readonly string[]> = {};

  inputs.forEach((input, index) => {
    const parsed = parseEngineManifest(input);
    if (!parsed.ok) {
      const id =
        input && typeof input === "object" && typeof (input as { id?: unknown }).id === "string"
          ? (input as { id: string }).id
          : `#${index}`;
      problems.push({ at: id, error: parsed.error });
      return;
    }

    const manifest = parsed.manifest;
    if (byId.has(manifest.id)) {
      // Keep the first. Two manifests claiming one id means telemetry from that
      // engine would light up whichever the loop reached first, which is a
      // coin toss dressed as a dashboard.
      problems.push({
        at: manifest.id,
        error: `Duplicate engine id "${manifest.id}"; the later manifest was ignored.`,
      });
      return;
    }

    byId.set(manifest.id, manifest);
    ordered.push(manifest);
    if (parsed.droppedFields.length > 0) droppedFields[manifest.id] = parsed.droppedFields;
  });

  return {
    engines: ordered.filter((m) => m.kind === "engine"),
    services: ordered.filter((m) => m.kind === "service"),
    all: ordered,
    get: (id) => byId.get(id),
    problems,
    droppedFields,
  };
}

/** Whether an engine's manifest says it supports a panel. Drives the tab strip. */
export function supportsPanel(manifest: EngineManifest, panel: string): boolean {
  return (manifest.supportedAdminPanels as readonly string[]).includes(panel);
}
