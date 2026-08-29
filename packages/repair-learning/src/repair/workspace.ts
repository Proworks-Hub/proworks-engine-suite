// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { changeWithinScope, type AgentLease } from "./lease.js";

// ─────────────────────────────────────────────────────────────────────────────
// The candidate workspace (directive §15).
//
// "Every code/configuration repair should occur in an isolated candidate
// workspace... Do not mutate the trusted baseline directly."
//
// PORTABILITY FIRST
//
// §41 forbids hard-coupling to GitHub, one CI vendor, or one repository host.
// So this is a branch/worktree/sandbox ABSTRACTION: a base revision, a change
// set, a diff, and a rollback path. Nothing here knows what git is. A host
// binds `WorkspaceProvider` to a worktree, a container, a copied directory or
// anything else that can hold changes without touching the baseline.
//
// THE BASELINE IS NAMED, AND THAT IS THE POINT
//
// `baseRevision` is required on every workspace. A change set with no stated
// base cannot be reviewed (against what?), cannot be rolled back (to what?),
// and cannot be revalidated later (§30 requires exactly that when a prior
// repair is reused). A workspace that does not know where it started is a pile
// of edits.
// ─────────────────────────────────────────────────────────────────────────────

export const changeKindSchema = z.enum(["added", "modified", "removed", "renamed"]);

export const fileChangeSchema = z
  .object({
    path: z.string().min(1),
    kind: changeKindSchema,
    /** Which component this file belongs to, for scope accounting. */
    componentId: z.string().min(1),
    /** Lines added/removed. Size, not content — the diff lives in the workspace. */
    linesAdded: z.number().int().nonnegative().default(0),
    linesRemoved: z.number().int().nonnegative().default(0),
    /** Set when the change renames. */
    fromPath: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => c.kind !== "renamed" || Boolean(c.fromPath), {
    message: "A rename must say what it renamed from.",
    path: ["fromPath"],
  });
export type FileChange = z.infer<typeof fileChangeSchema>;

export interface ChangeSet {
  readonly changes: readonly FileChange[];
  readonly filesChanged: number;
  readonly componentsTouched: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Tests the change set touches, so a deleted test is visible as such. */
  readonly testsRemoved: readonly string[];
  readonly contractsTouched: readonly string[];
  readonly dependenciesTouched: readonly string[];
}

export interface CandidateWorkspace {
  readonly workspaceId: string;
  readonly repairCandidateId: string;
  /** Where this started. Required. */
  readonly baseRevision: string;
  readonly leaseId: string;

  /** Records a change. Refuses one outside the lease's scope. */
  stage(change: unknown): { staged: true } | { staged: false; reason: string };
  changeSet(): ChangeSet;
  /** A textual diff, produced by the host. */
  diff(): Promise<string>;
  /** Undo everything. Back to baseRevision. */
  discard(): Promise<void>;
  readonly rollbackPath: string;
}

/** What a host must provide to hold a workspace. */
export interface WorkspaceProvider {
  create(input: {
    workspaceId: string;
    baseRevision: string;
  }): Promise<{ diff(): Promise<string>; discard(): Promise<void>; rollbackPath: string }>;
}

function summarize(changes: readonly FileChange[]): ChangeSet {
  return {
    changes,
    filesChanged: changes.length,
    componentsTouched: new Set(changes.map((c) => c.componentId)).size,
    linesAdded: changes.reduce((n, c) => n + c.linesAdded, 0),
    linesRemoved: changes.reduce((n, c) => n + c.linesRemoved, 0),
    // Surfaced as its own field rather than left inside the file list. Deleting
    // a failing test is §13's named shortcut, and it should be visible in the
    // summary a reviewer reads first, not discoverable by scanning paths.
    testsRemoved: changes
      .filter((c) => c.kind === "removed" && /(\.test\.|\.spec\.|__tests__)/.test(c.path))
      .map((c) => c.path),
    contractsTouched: changes.filter((c) => /contract|schema/i.test(c.path)).map((c) => c.path),
    dependenciesTouched: changes
      .filter((c) => /package\.json|lock|requirements|go\.mod|Cargo\.toml/i.test(c.path))
      .map((c) => c.path),
  };
}

export async function createCandidateWorkspace(input: {
  workspaceId: string;
  repairCandidateId: string;
  baseRevision: string;
  lease: AgentLease;
  provider: WorkspaceProvider;
}): Promise<CandidateWorkspace> {
  const backing = await input.provider.create({
    workspaceId: input.workspaceId,
    baseRevision: input.baseRevision,
  });

  const changes: FileChange[] = [];

  return {
    workspaceId: input.workspaceId,
    repairCandidateId: input.repairCandidateId,
    baseRevision: input.baseRevision,
    leaseId: input.lease.agentId,
    rollbackPath: backing.rollbackPath,

    stage(input_) {
      const parsed = fileChangeSchema.safeParse(input_);
      if (!parsed.success) {
        return { staged: false, reason: `Not a valid change: ${JSON.stringify(parsed.error.flatten())}` };
      }

      const change = parsed.data;

      // Scope is checked BEFORE the change is recorded, against what the change
      // set WOULD become. Checking afterwards would let the workspace hold a
      // change the lease never permitted, and "we recorded it but flagged it"
      // is how out-of-scope edits get reviewed into existence.
      const wouldBe = summarize([...changes, change]);
      const verdict = changeWithinScope(input.lease, {
        filesChanged: wouldBe.filesChanged,
        componentsTouched: wouldBe.componentsTouched,
      });
      if (!verdict.permitted) return { staged: false, reason: verdict.reason };

      if (!input.lease.targetComponents.includes(change.componentId)) {
        return {
          staged: false,
          reason: `Component ${change.componentId} is outside this lease's target components (${input.lease.targetComponents.join(", ")}). A repair that spreads is a repair that needs a new lease.`,
        };
      }

      changes.push(change);
      return { staged: true };
    },

    changeSet: () => summarize(changes),
    diff: () => backing.diff(),
    discard: () => backing.discard(),
  };
}

/**
 * An in-memory workspace provider, for simulation.
 *
 * Deliberately trivial. It exists so the harness can run end to end without a
 * repository host, which is what §41's portability requirement means in
 * practice: the default path must not require anybody's cloud.
 */
export function createInMemoryWorkspaceProvider(): WorkspaceProvider {
  return {
    async create({ workspaceId, baseRevision }) {
      let discarded = false;
      return {
        async diff() {
          return discarded
            ? ""
            : `# workspace ${workspaceId}\n# base ${baseRevision}\n# (in-memory provider holds no file contents)`;
        },
        async discard() {
          discarded = true;
        },
        rollbackPath: `memory://${workspaceId}@${baseRevision}`,
      };
    },
  };
}
