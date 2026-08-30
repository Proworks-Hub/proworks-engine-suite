// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  evolutionCandidateSchema,
  identifierSchema,
  migrationSchema,
  requiresHumanAuthorization,
  type EvolutionCandidate,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// THE COLLECTIVE ENGINE REPOSITORY.
//
// The authoritative record of approved engine artifacts, and the one place in
// this architecture where a single write in the wrong direction would undo the
// separation everything else maintains: a tenant instance writing into it
// makes one shop's code everybody's runtime.
//
// So there is no `write`. There is `publish`, it takes a PACKAGED release, and
// a packaged release can only be produced from a candidate that Governance
// approved — which is a different object, produced by a different call, and
// impossible to fabricate from inside an instance because it carries the
// decision id of an approval the instance did not make.
//
// PUBLISHING IS NOT DEPLOYING
//
// Worth stating twice because it is the thing most likely to be misread. This
// repository holds artifacts. Nothing here installs one, and Foundry's
// promotion wall is unchanged — `PROMOTABLE` remains SIMULATION and VALIDATION.
// An instance PINS itself to a version through its own channel, deliberately,
// and that is a separate decision made by whoever runs it.
//
// IMMUTABLE
//
// A published release is never edited. Withdrawal is a new state on the same
// record and the artifact stays; a repository that could rewrite a release
// could rewrite the evidence for it, and the evidence is most of what makes a
// promotion reviewable a year later.
// ─────────────────────────────────────────────────────────────────────────────

export const releaseChannelSchema = z.enum(["sandbox", "beta", "stable", "lts"]);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

/**
 * Which versions a release works with.
 *
 * A range, not a single number, because instances do not upgrade together —
 * that is the whole premise of independent Hive instances, and a release that
 * only recorded what it was built against would tell an operator nothing about
 * whether they may adopt it.
 */
export const compatibilitySchema = z
  .object({
    engineId: identifierSchema,
    minVersion: z.string().min(1),
    /** Absent means no known upper bound, which is a claim and not an absence. */
    maxVersion: z.string().min(1).optional(),
  })
  .strict();
export type Compatibility = z.infer<typeof compatibilitySchema>;

/**
 * The immutable package.
 *
 * Everything a promotion needs to be reviewed afterwards: what it was, what it
 * came from, what proved it, who approved it, and how to undo it.
 */
export const collectiveReleaseSchema = z
  .object({
    releaseId: identifierSchema,
    engineId: identifierSchema,
    version: z.string().min(1),
    /** Where the built artifact lives. A reference, never the bytes. */
    artifact: z.string().min(1),
    /** Content hash, so what is adopted can be checked against what was approved. */
    checksum: z.string().min(1),

    /** The candidate this came from, kept whole. */
    candidate: evolutionCandidateSchema,

    /**
     * The Governance decision that approved it. REQUIRED.
     *
     * Not optional and not defaulted. A release with no decision behind it is
     * one nobody authorized, and the shape of this field is what makes that
     * impossible rather than discouraged.
     */
    approvalDecisionId: identifierSchema,
    /** The person, when the change class required one. */
    authorizedBy: identifierSchema.optional(),

    migrations: z.array(migrationSchema).default([]),
    /**
     * How to get back. REQUIRED.
     *
     * A release without a rollback artifact is one whose failure has no
     * remedy, and the moment that is discovered is the moment it has failed.
     */
    rollbackArtifact: z.string().min(1),

    compatibility: z.array(compatibilitySchema).default([]),
    /** What the validation actually found. Kept with the artifact, not beside it. */
    testEvidence: z.array(z.string().min(1)).min(1),

    channel: releaseChannelSchema,
    publishedAt: z.string().min(1),
    /** Set when withdrawn. The record stays; the artifact stays. */
    withdrawnAt: z.string().min(1).optional(),
    withdrawnReason: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (r) => !requiresHumanAuthorization(r.candidate.changeClass) || Boolean(r.authorizedBy),
    {
      message:
        "A major, constitutional or new-engine release must name the human who authorized it. Governance policy permits it; a person accepts it, and an unnamed acceptance is one nobody can be asked about.",
      path: ["authorizedBy"],
    },
  )
  .refine((r) => !r.withdrawnAt || Boolean(r.withdrawnReason), {
    message: "A withdrawn release must say why. A withdrawal with no reason cannot be reviewed or reversed.",
    path: ["withdrawnReason"],
  });
export type CollectiveRelease = z.infer<typeof collectiveReleaseSchema>;

/**
 * A candidate that Governance has approved and Foundry has built.
 *
 * The only thing `publish` accepts. It cannot be constructed by an instance
 * because it carries a decision id an instance did not produce — which is what
 * makes "no tenant instance writes to the repository" a property of the types
 * rather than a rule somebody remembers.
 */
export interface PackagedRelease {
  readonly candidate: EvolutionCandidate;
  readonly approvalDecisionId: string;
  readonly authorizedBy?: string;
  readonly artifact: string;
  readonly checksum: string;
  readonly rollbackArtifact: string;
  readonly testEvidence: readonly string[];
  readonly compatibility?: readonly Compatibility[];
  readonly version: string;
  readonly channel: ReleaseChannel;
}

export type PublishResult =
  | { readonly published: true; readonly release: CollectiveRelease }
  | { readonly published: false; readonly reason: string };

/**
 * Where published releases live.
 *
 * Flagged as debt when this repository was built and closed here rather than
 * left for later. A collective repository that lost its releases on restart
 * would lose the provenance, the approval record and the rollback pointer for
 * every artifact any instance is running — which is precisely the evidence
 * that only matters after something has gone wrong.
 *
 * No `delete`. Withdrawal is a state change and the record stays; a store that
 * offered deletion would put the method within reach during an incident.
 */
export interface CollectiveRepositoryStore {
  readonly durability: "in-memory" | "durable";
  all(): readonly CollectiveRelease[];
  append(release: CollectiveRelease): void;
  /** Replaces one record in place. Used only to mark a withdrawal. */
  replace(releaseId: string, release: CollectiveRelease): boolean;
  nextReleaseId(): string;
}

export function createInMemoryCollectiveRepositoryStore(): CollectiveRepositoryStore {
  const held: CollectiveRelease[] = [];
  let counter = 0;
  return {
    durability: "in-memory",
    all: () => held,
    append: (r) => {
      held.push(r);
    },
    replace: (releaseId, release) => {
      const index = held.findIndex((r) => r.releaseId === releaseId);
      if (index < 0) return false;
      held[index] = release;
      return true;
    },
    nextReleaseId: () => `rel_${(counter += 1)}`,
  };
}

export interface CollectiveRepository {
  /**
   * Publishes an approved, built release.
   *
   * Refuses rather than throws, and refuses for reasons a reviewer can act on.
   */
  publish(input: PackagedRelease): PublishResult;

  /** Every release for an engine, newest first. */
  releases(engineId: string): readonly CollectiveRelease[];

  /**
   * The newest non-withdrawn release on a channel.
   *
   * What an instance pinned to that channel would adopt if it chose to. It
   * does not adopt it; this only says what is there.
   */
  lastKnownGood(engineId: string, channel: ReleaseChannel): CollectiveRelease | null;

  /** Marks a release withdrawn. The record and the artifact both stay. */
  withdraw(releaseId: string, reason: string, by: string): { withdrawn: boolean; reason: string };

  /** Whether an instance on this version may adopt this release. */
  mayAdopt(input: {
    release: CollectiveRelease;
    instanceVersions: Readonly<Record<string, string>>;
  }): { permitted: boolean; reason: string };

  count(): number;

  /** Whether published releases survive a restart. */
  durability(): "in-memory" | "durable";
}

export interface CollectiveRepositoryOptions {
  readonly now?: () => Date;
  /** Where releases live. Defaults to in-memory. */
  readonly store?: CollectiveRepositoryStore;
  readonly generateId?: () => string;
  /**
   * Sentinel's block list, by engine or by release.
   *
   * A port. Sentinel may block or quarantine a release on safety grounds, and
   * it does so by being consulted here rather than by having a method on this
   * object — a repository that Sentinel could write to would be a repository
   * with two authorities.
   */
  readonly blocked?: () => { engines: readonly string[]; releases: readonly string[] };
  readonly onPublished?: (release: CollectiveRelease) => void;
}

/** Compares dotted numeric versions. Returns <0, 0, >0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function createCollectiveRepository(
  options: CollectiveRepositoryOptions = {},
): CollectiveRepository {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createInMemoryCollectiveRepositoryStore();
  const newId = options.generateId ?? (() => store.nextReleaseId());

  return {
    publish(input) {
      const blocked = options.blocked?.() ?? { engines: [], releases: [] };
      if (blocked.engines.includes(input.candidate.engineId)) {
        // Sentinel's veto, checked before anything else. A release blocked on
        // safety grounds must not be published and then withdrawn — by then it
        // is a thing instances may have seen.
        return {
          published: false,
          reason: `Sentinel has blocked releases for ${input.candidate.engineId}.`,
        };
      }

      const parsed = collectiveReleaseSchema.safeParse({
        releaseId: newId(),
        engineId: input.candidate.engineId,
        version: input.version,
        artifact: input.artifact,
        checksum: input.checksum,
        candidate: input.candidate,
        approvalDecisionId: input.approvalDecisionId,
        ...(input.authorizedBy ? { authorizedBy: input.authorizedBy } : {}),
        migrations: input.candidate.migrations,
        rollbackArtifact: input.rollbackArtifact,
        compatibility: input.compatibility ?? [],
        testEvidence: input.testEvidence,
        channel: input.channel,
        publishedAt: now().toISOString(),
      });

      if (!parsed.success) {
        return {
          published: false,
          reason: `Not a publishable release: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }

      // Versions are immutable. Republishing one would let the artifact behind
      // a version change while every instance pinned to it kept believing it
      // had the build it adopted.
      const clash = store.all().find(
        (r) => r.engineId === parsed.data.engineId && r.version === parsed.data.version,
      );
      if (clash) {
        return {
          published: false,
          reason:
            `${parsed.data.engineId} ${parsed.data.version} is already published. Versions are immutable — ` +
            "republishing one would change the artifact behind a version while every instance pinned to it " +
            "kept believing it had the build it adopted.",
        };
      }

      store.append(parsed.data);
      options.onPublished?.(parsed.data);
      return { published: true, release: parsed.data };
    },

    releases: (engineId) =>
      store
        .all()
        .filter((r) => r.engineId === engineId)
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),

    lastKnownGood(engineId, channel) {
      return (
        store
          .all()
          .filter((r) => r.engineId === engineId && r.channel === channel && !r.withdrawnAt)
          .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
      );
    },

    withdraw(releaseId, reason, by) {
      const existing = store.all().find((r) => r.releaseId === releaseId);
      if (!existing) return { withdrawn: false, reason: `No release ${releaseId}.` };
      if (existing.withdrawnAt) return { withdrawn: false, reason: "Already withdrawn." };

      // A new record replacing the old one in the list, with the artifact and
      // every other field carried through. Withdrawal is a state, not a
      // deletion: instances that already adopted it need the record to still
      // explain what they are running.
      store.replace(releaseId, {
        ...existing,
        withdrawnAt: now().toISOString(),
        withdrawnReason: `${reason} (withdrawn by ${by})`,
      });
      return { withdrawn: true, reason: "Withdrawn; the record and the artifact both remain." };
    },

    mayAdopt({ release, instanceVersions }) {
      if (release.withdrawnAt) {
        return { permitted: false, reason: `${release.version} was withdrawn: ${release.withdrawnReason}` };
      }

      for (const requirement of release.compatibility) {
        const running = instanceVersions[requirement.engineId];
        if (running === undefined) {
          // Not running it is not the same as running an incompatible one, and
          // the difference decides whether this is a blocker or a non-issue.
          // Refused, because an engine a release depends on and the instance
          // does not have is a dependency nobody has checked.
          return {
            permitted: false,
            reason: `This release requires ${requirement.engineId}, which this instance does not report running.`,
          };
        }
        if (compareVersions(running, requirement.minVersion) < 0) {
          return {
            permitted: false,
            reason: `Requires ${requirement.engineId} >= ${requirement.minVersion}; this instance runs ${running}.`,
          };
        }
        if (requirement.maxVersion && compareVersions(running, requirement.maxVersion) > 0) {
          return {
            permitted: false,
            reason: `Requires ${requirement.engineId} <= ${requirement.maxVersion}; this instance runs ${running}.`,
          };
        }
      }

      return { permitted: true, reason: "Compatible with what this instance reports running." };
    },

    count: () => store.all().length,
    durability: () => store.durability,
  };
}

/**
 * Whether a tenant instance can write into the collective repository.
 *
 * Always false, and structurally: `publish` accepts only a `PackagedRelease`,
 * which carries the id of a Governance decision an instance did not make. The
 * rule is enforced by there being nothing an instance could construct, not by
 * a check it could be routed around.
 */
export function tenantMayWriteToRepository(): false {
  return false;
}

/**
 * Whether a published release is thereby running anywhere.
 *
 * Always false. The repository holds artifacts; adoption is a separate,
 * deliberate act by whoever runs an instance. Foundry's promotion wall is
 * unchanged — building a road does not open the gate.
 */
export function publishedMeansDeployed(): false {
  return false;
}
