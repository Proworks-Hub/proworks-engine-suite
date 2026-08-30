// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// What a release does to data on the way in, and whether it can be undone.
//
// Declared here rather than in the console because Foundry packages releases
// and does not depend on the console — a migration vocabulary only the console
// could import is one the thing producing releases cannot speak. The console
// keeps the authority over what these mean for a deployment and re-exports
// them; what moved is where the shapes live.
// ─────────────────────────────────────────────────────────────────────────────

export const migrationKindSchema = z.enum([
  /** Old code still works against the new schema. Additive columns, new tables. */
  "backward_compatible",
  /** New code still works against the old schema. Required for staged rollout. */
  "forward_compatible",
  /** Undoable without data loss. */
  "reversible",
  /** Cannot be undone: data was dropped, coerced, or rewritten in place. */
  "irreversible",
]);
export type MigrationKind = z.infer<typeof migrationKindSchema>;

export const migrationSchema = z
  .object({
    id: z.string().min(1),
    kind: migrationKindSchema,
    description: z.string().min(1),
    /** What is lost if this is reversed. Required for irreversible ones. */
    dataLossOnReverse: z.string().optional(),
  })
  .strict()
  .refine(
    (migration) => migration.kind !== "irreversible" || Boolean(migration.dataLossOnReverse),
    {
      // An irreversible migration with no stated consequence is one nobody
      // thought about, and the thinking is the point.
      message: "An irreversible migration must state what is lost when reversed.",
      path: ["dataLossOnReverse"],
    },
  );
export type Migration = z.infer<typeof migrationSchema>;
