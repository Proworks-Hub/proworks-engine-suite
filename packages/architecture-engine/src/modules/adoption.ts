// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PackageFacts } from "../chambers/conformance.js";

// ─────────────────────────────────────────────────────────────────────────────
// P7 — bringing the existing Hive into conformance without destabilising it.
//
// NOT ONE MASSIVE REWRITE. A queue, ordered by evidence rather than by a list
// somebody wrote down.
//
// The ordering principle is blast radius, ascending: adopt the packages that
// nothing depends on first. Two reasons, and the second is the one that
// matters. The obvious one is that a mistake in a leaf package hurts less. The
// real one is that adoption is a LEARNING exercise — the first few packages
// teach you what the standard actually costs, and you want those lessons
// before you touch something fifty packages import, not after.
//
// The build directive suggests an order (architecture packages, then low-risk
// utilities, then specialists, then Core, then Prime, then Overwatch, then
// Fabric, then Sentinel, then Governance). That suggestion and this
// computation agree on the shape, because the suggestion is itself a blast
// radius argument — Governance last because everything answers to it. Where
// they disagree, the repository wins: it knows which packages are actually
// depended upon here, and the suggestion was written without seeing it.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdoptionCandidate {
  readonly packageName: string;
  /** How many workspace packages import it. The cost of getting it wrong. */
  readonly dependents: number;
  /** How many workspace packages it imports. Roughly, how much it can be broken BY. */
  readonly dependencies: number;
  readonly adopted: boolean;
  /**
   * Why this position, in one sentence a reader can disagree with.
   *
   * A queue without reasons is a queue people reorder to suit whoever is
   * asking, because there is nothing to argue against.
   */
  readonly rationale: string;
}

export interface AdoptionWave {
  readonly wave: number;
  readonly label: string;
  readonly candidates: readonly AdoptionCandidate[];
}

const WORKSPACE_PREFIX = "@proworks-hub/";

/**
 * Orders the workspace for adoption, in waves.
 *
 * Waves rather than a flat list because within a wave the order genuinely does
 * not matter, and pretending it does invites arguments about positions 14 and
 * 15 that nobody should be having.
 */
export function planAdoptionQueue(
  packages: readonly PackageFacts[],
  adopted: readonly string[] = [],
): readonly AdoptionWave[] {
  const inWorkspace = new Set(packages.map((p) => p.packageName));
  const already = new Set(adopted);

  const dependentCount = new Map<string, number>();
  for (const pkg of packages) {
    for (const dep of pkg.dependencies) {
      if (!inWorkspace.has(dep)) continue; // External packages are not ours to adopt.
      dependentCount.set(dep, (dependentCount.get(dep) ?? 0) + 1);
    }
  }

  const candidates: AdoptionCandidate[] = packages.map((pkg) => {
    const dependents = dependentCount.get(pkg.packageName) ?? 0;
    const dependencies = pkg.dependencies.filter((d) => inWorkspace.has(d)).length;
    return {
      packageName: pkg.packageName,
      dependents,
      dependencies,
      adopted: already.has(pkg.packageName),
      rationale:
        dependents === 0
          ? "nothing in the workspace imports it, so a mistake here is contained"
          : `${dependents} package${dependents === 1 ? "" : "s"} import${dependents === 1 ? "s" : ""} it, so adopt it once the standard's cost is known`,
    };
  });

  const waves: { readonly label: string; readonly test: (c: AdoptionCandidate) => boolean }[] = [
    {
      label: "Already adopted",
      test: (c) => c.adopted,
    },
    {
      label: "Leaves — nothing imports them",
      test: (c) => c.dependents === 0,
    },
    {
      label: "Lightly depended upon — one or two importers",
      test: (c) => c.dependents <= 2,
    },
    {
      label: "Widely depended upon",
      test: (c) => c.dependents <= 10,
    },
    {
      label: "Foundational — the blast radius is the whole suite",
      test: () => true,
    },
  ];

  const assigned = new Set<string>();
  const out: AdoptionWave[] = [];
  waves.forEach((wave, index) => {
    const members = candidates
      .filter((c) => !assigned.has(c.packageName) && wave.test(c))
      .sort((a, b) => a.dependents - b.dependents || a.packageName.localeCompare(b.packageName));
    for (const m of members) assigned.add(m.packageName);
    if (members.length > 0) out.push({ wave: index, label: wave.label, candidates: members });
  });

  return out;
}

export interface AdoptionProgress {
  readonly total: number;
  readonly adopted: number;
  readonly remaining: number;
  /** Null when there is nothing to divide, rather than a flattering 0 or 1. */
  readonly ratio: number | null;
  readonly nextUp: readonly string[];
}

/**
 * Where the programme actually stands.
 *
 * `nextUp` names the next few packages rather than only a percentage, because
 * a percentage tells nobody what to do on Monday.
 */
export function adoptionProgress(
  waves: readonly AdoptionWave[],
  limit = 5,
): AdoptionProgress {
  const all = waves.flatMap((w) => w.candidates);
  const adopted = all.filter((c) => c.adopted).length;
  const pending = waves
    .filter((w) => w.label !== "Already adopted")
    .flatMap((w) => w.candidates)
    .filter((c) => !c.adopted);

  return {
    total: all.length,
    adopted,
    remaining: all.length - adopted,
    ratio: all.length === 0 ? null : adopted / all.length,
    nextUp: pending.slice(0, limit).map((c) => c.packageName),
  };
}

/** True for a workspace package, so external dependencies are never queued. */
export function isWorkspacePackage(name: string): boolean {
  return name.startsWith(WORKSPACE_PREFIX);
}
