// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { hiveClassificationSchema, lifecycleStateSchema } from "./hiveClassification.js";

// ─────────────────────────────────────────────────────────────────────────────
// Charter registry: references to authoritative Charter documents.
//
// THE AUTHORITY CHAIN THIS EXISTS TO PRESERVE
//
//   Hive Constitution
//           ↓
//   Engine Charter
//           ↓
//   Architecture / Contract Standard
//           ↓
//   Implementation
//
// A runtime manifest may REFERENCE a charter. It shall not redefine one, and
// code shall not expand authority beyond what its charter grants. This module
// holds only references, deliberately: the moment charter text lives in source,
// there are two authoritative copies and no way to tell which is current.
//
// CHARTER LIFECYCLE IS NOT IMPLEMENTATION LIFECYCLE. A charter may be ACTIVE
// while its implementation is SCAFFOLDED, and that is a normal, valid state —
// it means somebody has decided what a thing must be before building it. The
// two fields are separate so nobody infers one from the other.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How authoritative a charter document is.
 *
 * Separate from `ratificationState` because a charter can be a well-formed,
 * complete DRAFT — the document exists and is worth reading — while nobody has
 * ratified it. Collapsing the two would let a draft become binding by being
 * committed.
 */
export const charterStatusSchema = z.enum([
  /** Being written. Not authoritative. */
  "DRAFT",
  /** Complete and in force. */
  "ACTIVE",
  /** Replaced. See `supersededBy`. */
  "SUPERSEDED",
  /** No longer in force and not replaced. */
  "WITHDRAWN",
]);
export type CharterStatus = z.infer<typeof charterStatusSchema>;

/**
 * Where a document sits between its approved source and this repository.
 *
 * The distinction §6 requires, and the reason it matters: **a generated
 * repository amendment must not become authoritative merely because it was
 * committed.** Human Constitutional Authority ratifies. A commit does not.
 */
export const ratificationStateSchema = z.enum([
  /** The authoritative original, approved outside this repository. */
  "APPROVED_SOURCE",
  /** A faithful copy of an approved source, synchronized into the repository. */
  "REPOSITORY_SYNCHRONIZED_COPY",
  /** Written here, proposed, NOT yet ratified. Committed but not binding. */
  "PROPOSED_AMENDMENT",
  /** Ratified by Human Constitutional Authority. */
  "RATIFIED_AMENDMENT",
]);
export type RatificationState = z.infer<typeof ratificationStateSchema>;

/**
 * A reference to one authoritative Charter document.
 *
 * `.strict()` because a typo'd field name in a governing reference is worse
 * than a rejected record: `charterVerison` would silently read as version-less.
 */
export const charterRecordSchema = z
  .object({
    charterId: z.string().min(1),
    /**
     * The engine's permanent constitutional identity.
     *
     * Absent for a framework document such as Overwatch, which is a
     * relationship between chartered systems rather than a component. A
     * framework with an engine id would eventually be built as one.
     */
    canonicalEngineId: z.string().min(1).optional(),
    canonicalName: z.string().min(1),
    /** Absent for framework documents, for the same reason. */
    classification: hiveClassificationSchema.optional(),
    charterVersion: z.string().min(1),
    status: charterStatusSchema,
    ratificationState: ratificationStateSchema,
    /** The charter this replaces, if any. */
    supersedes: z.string().min(1).optional(),
    /** Which Constitution version this charter was written against. */
    constitutionVersion: z.string().min(1).optional(),
    /**
     * Integrity of the referenced text.
     *
     * Optional only while charters are unwritten. Once a charter is ACTIVE this
     * must be present — an unverifiable reference to a governing document is
     * how a compromised runtime redefines what counts as constitutional.
     */
    integrityHash: z.string().min(1).optional(),
    /** Where the authoritative text lives. Not necessarily a URL. */
    sourceDocument: z.string().min(1).optional(),
    /**
     * How much of the thing the charter describes actually exists.
     *
     * NOT derived from charter status. A charter may be ACTIVE while this is
     * CHARTERED, meaning nothing is built yet.
     */
    implementationLifecycle: lifecycleStateSchema,
    /**
     * In the V1 runtime slice — the closed shop loop.
     *
     * A flag rather than a list elsewhere, so adding an engine to V1 scope is a
     * visible edit to that engine's own record. `tests/charterRegistry.test.ts`
     * asserts the exact set, so scaffolding a new engine into the allowlist
     * fails rather than quietly widening what V1 means.
     */
    v1Runtime: z.boolean().optional(),
  })
  .strict()
  .refine((c) => c.status !== "ACTIVE" || Boolean(c.integrityHash), {
    message:
      "An ACTIVE charter must carry an integrity hash. A governing document that cannot be verified is one that can be silently altered.",
    path: ["integrityHash"],
  })
  .refine((c) => Boolean(c.canonicalEngineId) === Boolean(c.classification), {
    message:
      "A charter has either both an engine id and a classification (an engine) or neither (a framework document). One without the other is a component that cannot be placed.",
    path: ["classification"],
  });
export type CharterRecord = z.infer<typeof charterRecordSchema>;

export interface CharterLookupProblem {
  readonly charterId: string;
  readonly reason: string;
}

export interface CharterRegistry {
  /** Every charter reference held. */
  all(): readonly CharterRecord[];
  /** One charter by id, or null. */
  byId(charterId: string): CharterRecord | null;
  /** The charter governing an engine, or null when the engine is unchartered. */
  forEngine(canonicalEngineId: string): CharterRecord | null;
  /** References that failed to parse, with the reason. */
  problems(): readonly CharterLookupProblem[];
}

/**
 * Builds a registry from charter references.
 *
 * Malformed records are COLLECTED, not thrown. A registry that refuses to load
 * because one reference is wrong tells an operator nothing about the other
 * forty; the caller usually wants every problem at once.
 */
export function createCharterRegistry(inputs: readonly unknown[]): CharterRegistry {
  const records: CharterRecord[] = [];
  const problems: CharterLookupProblem[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const parsed = charterRecordSchema.safeParse(input);
    if (!parsed.success) {
      const id =
        typeof input === "object" && input !== null && "charterId" in input
          ? String((input as { charterId: unknown }).charterId)
          : "<unidentified>";
      problems.push({ charterId: id, reason: JSON.stringify(parsed.error.flatten()) });
      continue;
    }

    if (seen.has(parsed.data.charterId)) {
      // Two charters claiming one id is the failure this registry exists to
      // prevent: whichever loaded last would silently govern.
      problems.push({
        charterId: parsed.data.charterId,
        reason: "Duplicate charter id. Two documents cannot both govern one identity.",
      });
      continue;
    }

    seen.add(parsed.data.charterId);
    records.push(parsed.data);
  }

  const byEngine = new Map<string, CharterRecord>();
  for (const r of records) {
    if (r.canonicalEngineId) byEngine.set(r.canonicalEngineId, r);
  }

  return {
    all: () => records,
    byId: (id) => records.find((r) => r.charterId === id) ?? null,
    forEngine: (engineId) => byEngine.get(engineId) ?? null,
    problems: () => problems,
  };
}

/**
 * Whether a charter may be relied upon as governing.
 *
 * A DRAFT is readable and useful and governs nothing. A PROPOSED_AMENDMENT is
 * committed and governs nothing. Only the combination below is binding, and it
 * is stated as a function so no call site has to remember the rule.
 */
export function isBinding(record: CharterRecord): boolean {
  return (
    record.status === "ACTIVE" &&
    (record.ratificationState === "APPROVED_SOURCE" ||
      record.ratificationState === "REPOSITORY_SYNCHRONIZED_COPY" ||
      record.ratificationState === "RATIFIED_AMENDMENT")
  );
}
