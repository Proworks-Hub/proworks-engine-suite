// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { PackageFacts } from "../chambers/conformance.js";

// ─────────────────────────────────────────────────────────────────────────────
// KnowledgePackageIQ · ArchitectureDriftIQ · ArchitectureProvenanceIQ.
//
// The three modules that compare the Hive against what is written about it.
// ─────────────────────────────────────────────────────────────────────────────

/** The twelve books a Knowledge Package Volume requires. Manifesto §15. */
export const REQUIRED_BOOKS: readonly string[] = [
  "Charter / Constitutional Role",
  "Engineering Blueprint",
  "Technical Manual",
  "Hive Knowledge Specification",
  "Developer / Integration Guide",
  "Operations / Runbooks / Failure Encyclopedia",
  "Security / Threat Model",
  "Testing / Certification / Evidence",
  "Interaction / Contract Atlas",
  "Capability Catalog / APIs / Events",
  "Evolution / ADR / Provenance",
  "Builder / Host Guide",
];

export interface KnowledgePackageStatus {
  readonly subjectId: string;
  readonly presentBooks: readonly string[];
  readonly missingBooks: readonly string[];
  readonly completeness: number;
  /**
   * The book whose absence most limits the package's usefulness.
   *
   * One name rather than a list, because a completeness percentage tells an
   * author nothing about what to write next. Ordered by what a reader is
   * stopped by first: you cannot evaluate a component without knowing what it
   * is chartered to do, and you cannot operate one without knowing how it
   * fails.
   */
  readonly limitingDimension: string | null;
}

const LIMITING_ORDER: readonly string[] = [
  "Charter / Constitutional Role",
  "Security / Threat Model",
  "Operations / Runbooks / Failure Encyclopedia",
  "Testing / Certification / Evidence",
  "Interaction / Contract Atlas",
];

export function assessKnowledgePackage(
  subjectId: string,
  presentBooks: readonly string[],
): KnowledgePackageStatus {
  const present = REQUIRED_BOOKS.filter((b) => presentBooks.includes(b));
  const missing = REQUIRED_BOOKS.filter((b) => !presentBooks.includes(b));
  return {
    subjectId,
    presentBooks: present,
    missingBooks: missing,
    completeness: Math.round((present.length / REQUIRED_BOOKS.length) * 100) / 100,
    limitingDimension:
      LIMITING_ORDER.find((b) => missing.includes(b)) ?? (missing.length > 0 ? missing[0]! : null),
  };
}

// ── ArchitectureDriftIQ ──────────────────────────────────────────────────────

export const driftCategorySchema = z.enum([
  "IMPLEMENTATION_DRIFT",
  "DOCUMENTATION_DRIFT",
  "CONTRACT_DRIFT",
  "STATE_OWNERSHIP_DRIFT",
  "AUTHORITY_DRIFT",
  "DEPENDENCY_DRIFT",
  "VERSION_DRIFT",
]);
export type DriftCategory = z.infer<typeof driftCategorySchema>;

export interface DriftFinding {
  readonly category: DriftCategory;
  readonly subject: string;
  readonly detail: string;
  /**
   * Which side is wrong, when that is knowable.
   *
   * `UNKNOWN` is common and honest: the map and the repository disagreeing
   * does not say which one is right, and a drift tool that always blamed the
   * documentation would be used to justify whatever the code happened to do.
   */
  readonly authoritative: "MAP" | "REPOSITORY" | "UNKNOWN";
}

/**
 * Compares the ratified map against the repository on disk.
 *
 * Both directions are reported, and they mean different things. A package with
 * no map entry is undescribed — nobody agreed it should exist. A map entry
 * with no package is a component the architecture claims and the repository
 * does not have, which is the more misleading of the two: it makes the Hive
 * look more built than it is.
 */
export function detectArchitectureDrift(
  mapped: readonly { readonly id: string; readonly packageName?: string }[],
  packages: readonly PackageFacts[],
): readonly DriftFinding[] {
  const out: DriftFinding[] = [];
  const onDisk = new Set(packages.map((p) => p.packageName));
  const inMap = new Set(mapped.map((m) => m.packageName).filter((n): n is string => Boolean(n)));

  for (const entry of mapped) {
    if (entry.packageName && !onDisk.has(entry.packageName)) {
      out.push({
        category: "IMPLEMENTATION_DRIFT",
        subject: entry.id,
        detail: `the map lists ${entry.packageName}, which is not in the workspace`,
        authoritative: "UNKNOWN",
      });
    }
  }
  for (const pkg of packages) {
    if (!inMap.has(pkg.packageName)) {
      out.push({
        category: "DOCUMENTATION_DRIFT",
        subject: pkg.packageName,
        detail: "the package exists and the map does not describe it",
        authoritative: "REPOSITORY",
      });
    }
  }
  return out.sort((a, b) => (a.category + a.subject).localeCompare(b.category + b.subject));
}

// ── ArchitectureProvenanceIQ ─────────────────────────────────────────────────

/** One link of the chain from constitution to running code. */
export const provenanceLinkSchema = z.enum([
  "CONSTITUTION",
  "MANIFESTO_RULE",
  "ARCHITECTURE_RULE",
  "ADR",
  "IMPLEMENTATION",
  "TEST",
  "EVIDENCE",
]);
export type ProvenanceLink = z.infer<typeof provenanceLinkSchema>;

export interface ProvenanceChain {
  readonly subject: string;
  readonly links: Readonly<Partial<Record<ProvenanceLink, string>>>;
}

export interface ProvenanceGap {
  readonly subject: string;
  readonly missing: readonly ProvenanceLink[];
  /** True when the chain reaches running code with no decision behind it. */
  readonly implementedWithoutDecision: boolean;
}

/**
 * Finds the breaks in a traceability chain.
 *
 * `implementedWithoutDecision` is the flag worth having. Code that exists with
 * no ADR or manifesto rule behind it is not necessarily wrong — much of any
 * system predates its own governance — but it is the population where nobody
 * can answer "why is this like this?", and that is the population that gets
 * rewritten by the next person who dislikes it.
 *
 * This module never invents a missing link. A chain with a gap is reported
 * with the gap; writing history backwards from the implementation would make
 * every decision look like it was made on purpose.
 */
export function findProvenanceGaps(chains: readonly ProvenanceChain[]): readonly ProvenanceGap[] {
  const all = provenanceLinkSchema.options;
  return chains
    .map((chain) => {
      const missing = all.filter((link) => !chain.links[link]);
      return {
        subject: chain.subject,
        missing,
        implementedWithoutDecision:
          Boolean(chain.links.IMPLEMENTATION) && !chain.links.ADR && !chain.links.MANIFESTO_RULE,
      };
    })
    .filter((gap) => gap.missing.length > 0);
}
