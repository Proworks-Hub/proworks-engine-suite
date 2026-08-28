// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Where things are.
//
// The naming is deliberately neutral. `area` rather than `station`, `zone`
// rather than `shop floor` — a house has to work in this model as literally as
// a factory does, and the moment the core says "station" every Family Table
// screen is translating manufacturing vocabulary for a kitchen.
//
// Applications name their own levels. ProWorks calls an area a station; a home
// calls it a corner of the garage. SenseIQ holds the shape.
//
// One customer is not one building. Multiple sites, multiple buildings and
// several floors are the ordinary case, not an enterprise upgrade, so the model
// starts that way rather than acquiring it later as a migration.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The levels, ordered from largest to smallest.
 *
 * Ordered because containment is checked against this: a floor cannot contain a
 * building. Encoding the order once stops every consumer inventing its own
 * idea of what may nest inside what.
 */
export const SPACE_LEVELS = ["site", "building", "floor", "zone", "area"] as const;
export const spaceLevelSchema = z.enum(SPACE_LEVELS);
export type SpaceLevel = z.infer<typeof spaceLevelSchema>;

export const physicalSpaceSchema = z
  .object({
    spaceId: z.string().min(1),
    name: z.string().min(1),
    level: spaceLevelSchema,
    /** Absent only for a site, which is the root. */
    parentId: z.string().min(1).optional(),
    /**
     * Geometry, when something has captured it.
     *
     * Optional and opaque at this level: a scan produces one, manual setup does
     * not, and a space with no geometry is completely usable. Making it
     * required would mean no space exists until somebody walks the building.
     */
    geometry: z.record(z.string(), z.unknown()).optional(),
    /** Set when the space was proposed by a scan rather than typed by a person. */
    proposed: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((space) => space.level === "site" ? space.parentId === undefined : space.parentId !== undefined, {
    message: "Only a site has no parent; everything else must say what contains it.",
    path: ["parentId"],
  });
export type PhysicalSpace = z.infer<typeof physicalSpaceSchema>;

export type SpaceProblem =
  | { kind: "missing_parent"; spaceId: string; parentId: string }
  | { kind: "bad_containment"; spaceId: string; detail: string }
  | { kind: "cycle"; spaceId: string };

/**
 * Checks a set of spaces holds together.
 *
 * Returns problems rather than throwing, because the realistic caller is a
 * setup screen showing somebody what to fix — and because a scan proposing a
 * slightly wrong hierarchy is normal input, not an exception.
 *
 * Skipping levels is ALLOWED. A small shop is a site with areas in it and no
 * floors, and requiring the full ladder would make the common case fill in two
 * levels of fiction.
 */
export function validateSpaces(spaces: readonly PhysicalSpace[]): SpaceProblem[] {
  const byId = new Map(spaces.map((space) => [space.spaceId, space]));
  const problems: SpaceProblem[] = [];
  const rank = (level: SpaceLevel) => SPACE_LEVELS.indexOf(level);

  for (const space of spaces) {
    if (!space.parentId) continue;

    const parent = byId.get(space.parentId);
    if (!parent) {
      problems.push({ kind: "missing_parent", spaceId: space.spaceId, parentId: space.parentId });
      continue;
    }

    if (rank(parent.level) >= rank(space.level)) {
      problems.push({
        kind: "bad_containment",
        spaceId: space.spaceId,
        detail: `A ${space.level} cannot sit inside a ${parent.level}.`,
      });
    }
  }

  // Walked per node with a visited set rather than a global colouring, so a
  // cycle is reported against every space caught in it — which is what somebody
  // fixing it needs to see.
  for (const space of spaces) {
    const seen = new Set<string>([space.spaceId]);
    let current = space.parentId;
    while (current) {
      if (seen.has(current)) {
        problems.push({ kind: "cycle", spaceId: space.spaceId });
        break;
      }
      seen.add(current);
      current = byId.get(current)?.parentId;
    }
  }

  return problems;
}

/** The chain from a space up to its site, nearest first. */
export function ancestorsOf(spaceId: string, spaces: readonly PhysicalSpace[]): PhysicalSpace[] {
  const byId = new Map(spaces.map((space) => [space.spaceId, space]));
  const chain: PhysicalSpace[] = [];
  const seen = new Set<string>();

  let current = byId.get(spaceId)?.parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) break;
    chain.push(parent);
    current = parent.parentId;
  }
  return chain;
}

/**
 * A readable path: "Workshop → Ground floor → Production → UV station".
 *
 * For every screen that shows where a device is. Built here so the separator and
 * the ordering are the same everywhere rather than being reinvented per view.
 */
export function spacePath(spaceId: string, spaces: readonly PhysicalSpace[]): string {
  const byId = new Map(spaces.map((space) => [space.spaceId, space]));
  const self = byId.get(spaceId);
  if (!self) return "";
  return [...ancestorsOf(spaceId, spaces).reverse(), self].map((space) => space.name).join(" → ");
}

/** Every space beneath one, at any depth. */
export function descendantsOf(spaceId: string, spaces: readonly PhysicalSpace[]): PhysicalSpace[] {
  const children = new Map<string, PhysicalSpace[]>();
  for (const space of spaces) {
    if (!space.parentId) continue;
    children.set(space.parentId, [...(children.get(space.parentId) ?? []), space]);
  }

  const out: PhysicalSpace[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    for (const child of children.get(id) ?? []) {
      // Guarded, so a cycle in supplied data cannot hang a caller that has not
      // validated first.
      if (seen.has(child.spaceId)) continue;
      seen.add(child.spaceId);
      out.push(child);
      walk(child.spaceId);
    }
  };
  walk(spaceId);
  return out;
}
