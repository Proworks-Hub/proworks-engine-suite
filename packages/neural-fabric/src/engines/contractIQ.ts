/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/contractIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  Whether two versions can speak, decided before the topology says yes.
 */

import { z } from "zod";

import { laneSchema, type Lane } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY IS TESTED BEFORE ACTIVATION, NOT DISCOVERED AFTER
//
// §10 asks for exactly one thing that most systems do not do: "Contract
// compatibility should be testable before topology activation." The usual
// order is reversed — a connection is made, traffic flows, and the first
// incompatible message is found by whoever is on call.
//
// So compatibility here is a question with an answer, asked of two declared
// versions, and the answer is available while the topology is still a draft.
//
// THE DIRECTION OF COMPATIBILITY IS THE PART PEOPLE GET WRONG
//
// "Backward compatible" is said constantly and means two opposite things
// depending on who is speaking. This module refuses the word in favour of
// naming the participants:
//
//   A NEW READER can read OLD data  — this is what lets you deploy consumers
//                                     first, and it is what a schema registry
//                                     usually calls BACKWARD.
//   An OLD READER can read NEW data — this is what lets you deploy producers
//                                     first, usually called FORWARD.
//
// Which one you need depends entirely on deployment order, and picking the
// wrong one produces a system that works in staging, where everything deploys
// at once, and fails in production, where it does not.
//
// A DEPRECATION WITHOUT A DATE IS A LABEL
//
// Marking a version deprecated and leaving it running forever is how a system
// accumulates six live versions of one contract. A sunset date makes it a
// commitment, and `usableAt` refuses the version after it — so the deadline
// has teeth rather than being an annotation in a wiki.
// ─────────────────────────────────────────────────────────────────────────────

/** What kind of change a version made, from the point of view of readers. */
export const compatibilityModeSchema = z.enum([
  /** A new reader can read old data. Deploy consumers first. */
  "NEW_READER_READS_OLD",
  /** An old reader can read new data. Deploy producers first. */
  "OLD_READER_READS_NEW",
  /** Both. The only mode that permits deploying in any order. */
  "BOTH_DIRECTIONS",
  /** Neither. A coordinated cutover, and it must be planned as one. */
  "BREAKING",
]);
export type CompatibilityMode = z.infer<typeof compatibilityModeSchema>;

export const contractVersionSchema = z
  .object({
    schemaId: z.string().min(1),
    /** Ordered integers rather than semver strings, so comparison is total. */
    version: z.number().int().positive(),
    lane: laneSchema,
    /** How this version relates to the one before it. */
    compatibilityWithPrevious: compatibilityModeSchema,
    /** Required fields a reader must find. Used for the structural check. */
    requiredFields: z.array(z.string().min(1)).default([]),
    /** Fields a reader may find and need not. */
    optionalFields: z.array(z.string().min(1)).default([]),
    status: z.enum(["ACTIVE", "DEPRECATED", "RETIRED"]),
    /** When a deprecated version stops being usable. Required if deprecated. */
    sunsetAt: z.string().min(1).nullable(),
  })
  .strict()
  .refine((c) => c.status !== "DEPRECATED" || c.sunsetAt !== null, {
    message:
      "A deprecated version needs a sunset date. Without one, 'deprecated' is a label rather than a commitment, and the version runs forever alongside its replacement.",
    path: ["sunsetAt"],
  });
export type ContractVersion = z.infer<typeof contractVersionSchema>;

export type SpeakVerdict =
  | { readonly canSpeak: true; readonly note: string; readonly warnings: readonly string[] }
  | { readonly canSpeak: false; readonly reason: string; readonly remedy: string };

/**
 * Whether a producer on one version can be understood by a consumer on another.
 *
 * Asked with the versions the two participants actually declare, so a
 * mismatched pair is refused while the topology that would connect them is
 * still a draft.
 */
export function canSpeak(
  producer: ContractVersion,
  consumer: ContractVersion,
  now: string,
): SpeakVerdict {
  if (producer.schemaId !== consumer.schemaId) {
    return {
      canSpeak: false,
      reason: `The producer speaks "${producer.schemaId}" and the consumer expects "${consumer.schemaId}". These are different contracts, not different versions of one.`,
      remedy: "Route through a translation the owning engine provides, or correct the addressing.",
    };
  }

  if (producer.lane !== consumer.lane) {
    return {
      canSpeak: false,
      reason: `The same contract is declared on the ${producer.lane} lane by the producer and the ${consumer.lane} lane by the consumer. The lane decides delivery, ordering and durability, so these are not the same conversation.`,
      remedy: "Agree the lane first. A contract that means different things on different lanes needs two contracts.",
    };
  }

  for (const [role, version] of [
    ["producer", producer],
    ["consumer", consumer],
  ] as const) {
    const usable = usableAt(version, now);
    if (!usable.usable) {
      return {
        canSpeak: false,
        reason: `The ${role} is on ${version.schemaId} v${version.version}, which ${usable.reason}`,
        remedy: `Move the ${role} to an active version.`,
      };
    }
  }

  if (producer.version === consumer.version) {
    return {
      canSpeak: true,
      note: `Both are on ${producer.schemaId} v${producer.version}.`,
      warnings: warningsFor(producer, consumer, now),
    };
  }

  const older = producer.version < consumer.version ? producer : consumer;
  const newer = producer.version < consumer.version ? consumer : producer;
  const producerIsOlder = producer.version < consumer.version;

  // The direction that matters is which side is READING. A newer consumer
  // reading an older producer needs NEW_READER_READS_OLD; an older consumer
  // reading a newer producer needs OLD_READER_READS_NEW.
  const needed: CompatibilityMode = producerIsOlder ? "NEW_READER_READS_OLD" : "OLD_READER_READS_NEW";

  // Every version between the two must carry the needed direction. One
  // breaking change anywhere in the chain breaks the whole span, and checking
  // only the endpoints is how a system concludes v1 and v5 are compatible
  // because v5 said so about v4.
  const chainMode = newer.compatibilityWithPrevious;
  if (chainMode === "BREAKING") {
    return {
      canSpeak: false,
      reason: `${newer.schemaId} v${newer.version} is a breaking change from v${newer.version - 1}, and these participants are on v${producer.version} and v${consumer.version}.`,
      remedy:
        "A breaking change is a coordinated cutover. Deploy both sides together, or run the two versions on separate contracts until the old one sunsets.",
    };
  }

  if (chainMode !== "BOTH_DIRECTIONS" && chainMode !== needed) {
    return {
      canSpeak: false,
      reason: `This pairing needs ${needed} and ${newer.schemaId} v${newer.version} only offers ${chainMode}. ${
        needed === "NEW_READER_READS_OLD"
          ? "The consumer is ahead of the producer, so the consumer has to understand the older shape."
          : "The producer is ahead of the consumer, so the older consumer has to tolerate the newer shape."
      }`,
      remedy:
        needed === "NEW_READER_READS_OLD"
          ? "Deploy the producer first, or give the new version a default for what the old one omits."
          : "Deploy the consumer first, or keep new fields optional so an older reader can ignore them.",
    };
  }

  // A consumer's REQUIRED field must be REQUIRED on the producer.
  //
  // The first version of this accepted a producer's optional field as
  // satisfying a consumer's requirement, and that is wrong in the worst way:
  // optional means the producer sometimes sends it, so the pairing works on
  // every message that happens to include the field and fails on the ones that
  // do not. An intermittent contract failure that passes a contract check is
  // considerably worse than one that fails it.
  //
  // The two cases are separated because the remedies differ. A field the
  // producer does not have at all is a modelling gap; a field it has as
  // optional is a promise nobody made.
  const absent = consumer.requiredFields.filter(
    (field) => !producer.requiredFields.includes(field) && !producer.optionalFields.includes(field),
  );
  if (absent.length > 0) {
    return {
      canSpeak: false,
      reason: `The consumer requires ${absent.join(", ")}, which v${producer.version} does not produce at all. The declared compatibility mode says these versions should interoperate, and the field lists say they cannot — the field lists win.`,
      remedy: "Correct the declared compatibility, or add the field to the producing version.",
    };
  }

  const onlyOptional = consumer.requiredFields.filter((field) => producer.optionalFields.includes(field));
  if (onlyOptional.length > 0) {
    return {
      canSpeak: false,
      reason: `The consumer requires ${onlyOptional.join(", ")}, and v${producer.version} declares ${onlyOptional.length === 1 ? "it" : "them"} OPTIONAL. Optional means sometimes sent, so this pairing would work on the messages that happen to carry the field and fail on the ones that do not.`,
      remedy:
        "Promote the field to required on the producer, or make it optional on the consumer with a defined behaviour when it is absent. An intermittent failure that passes a contract check is worse than one that fails it.",
    };
  }

  return {
    canSpeak: true,
    note: `v${producer.version} to v${consumer.version} works: ${needed} is satisfied by ${chainMode}. Spanning ${newer.version - older.version} version${newer.version - older.version === 1 ? "" : "s"}.`,
    warnings: warningsFor(producer, consumer, now),
  };
}

function warningsFor(producer: ContractVersion, consumer: ContractVersion, now: string): readonly string[] {
  const warnings: string[] = [];
  for (const [role, version] of [
    ["producer", producer],
    ["consumer", consumer],
  ] as const) {
    if (version.status === "DEPRECATED" && version.sunsetAt !== null) {
      warnings.push(
        `The ${role} is on v${version.version}, deprecated and unusable from ${version.sunsetAt}. It works today and will stop, on a date that is already set — this pairing has a deadline whether or not anyone has noticed.`,
      );
    }
  }
  const optionalOnly = consumer.optionalFields.filter(
    (f) => !producer.requiredFields.includes(f) && !producer.optionalFields.includes(f),
  );
  if (optionalOnly.length > 0) {
    warnings.push(
      `The consumer can use ${optionalOnly.join(", ")} and the producer never sends ${optionalOnly.length === 1 ? "it" : "them"}. Not an error — the consumer will simply never see that path exercised, which is worth knowing before somebody debugs why a feature "does nothing".`,
    );
  }
  return warnings;
}

/**
 * Whether a version may be used at a given moment.
 *
 * `now` is an argument. A sunset that depended on the wall clock could not be
 * simulated, and simulating a sunset before it happens is the whole point of
 * setting a date.
 */
export function usableAt(
  version: ContractVersion,
  now: string,
): { readonly usable: boolean; readonly reason: string } {
  if (version.status === "RETIRED") {
    return { usable: false, reason: "is retired. Nothing may speak it." };
  }
  if (version.status === "DEPRECATED" && version.sunsetAt !== null && now >= version.sunsetAt) {
    return {
      usable: false,
      reason: `passed its sunset date of ${version.sunsetAt}. The deprecation had a deadline so that it would eventually mean something, and this is it.`,
    };
  }
  return { usable: true, reason: "is usable." };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGOTIATION
// ─────────────────────────────────────────────────────────────────────────────

export interface NegotiationResult {
  readonly agreed: number | null;
  readonly considered: readonly number[];
  readonly note: string;
}

/**
 * The highest version both sides can speak.
 *
 * Highest rather than lowest, so a deployment that has upgraded both sides
 * actually gets the new contract instead of being pinned to the oldest thing
 * either side still supports. Falling back to the lowest common version is how
 * a system upgrades for two years without ever using a new field.
 */
export function negotiate(
  producerVersions: readonly ContractVersion[],
  consumerVersions: readonly ContractVersion[],
  now: string,
): NegotiationResult {
  const considered: number[] = [];
  let agreed: number | null = null;

  const sortedProducers = [...producerVersions].sort((a, b) => b.version - a.version);
  for (const producer of sortedProducers) {
    for (const consumer of consumerVersions) {
      if (consumer.version !== producer.version) continue;
      considered.push(producer.version);
      if (canSpeak(producer, consumer, now).canSpeak) {
        agreed = producer.version;
        break;
      }
    }
    if (agreed !== null) break;
  }

  return {
    agreed,
    considered: [...considered].sort((a, b) => b - a),
    note:
      agreed === null
        ? `No version is speakable by both. ${considered.length} shared version${considered.length === 1 ? " was" : "s were"} considered — a shared version number is not the same as a usable one, since either side may have retired or sunset it.`
        : `Agreed on v${agreed}, the highest both can speak. Falling back to the lowest common version is how a system upgrades for years without ever using a new field.`,
  };
}

/**
 * Every incompatible pairing a proposed topology would create.
 *
 * The pre-activation check §10 asks for. It answers with the whole list rather
 * than the first failure, because a topology change is reviewed once and
 * should be corrected once.
 */
export function checkTopologyContracts(
  pairings: readonly {
    readonly adjacencyId: string;
    readonly producer: ContractVersion;
    readonly consumer: ContractVersion;
  }[],
  now: string,
): {
  readonly compatible: boolean;
  readonly failures: readonly { readonly adjacencyId: string; readonly reason: string; readonly remedy: string }[];
  readonly warnings: readonly string[];
  readonly note: string;
} {
  const failures: { adjacencyId: string; reason: string; remedy: string }[] = [];
  const warnings: string[] = [];

  for (const pairing of [...pairings].sort((a, b) => a.adjacencyId.localeCompare(b.adjacencyId))) {
    const verdict = canSpeak(pairing.producer, pairing.consumer, now);
    if (!verdict.canSpeak) {
      failures.push({ adjacencyId: pairing.adjacencyId, reason: verdict.reason, remedy: verdict.remedy });
    } else {
      for (const w of verdict.warnings) warnings.push(`${pairing.adjacencyId}: ${w}`);
    }
  }

  return {
    compatible: failures.length === 0,
    failures,
    warnings,
    note:
      failures.length === 0
        ? `All ${pairings.length} pairing${pairings.length === 1 ? "" : "s"} can speak. This was checked before activation, which is the only time it is cheap to fix.`
        : `${failures.length} of ${pairings.length} pairings cannot speak. Activating this topology would create ${failures.length} connection${failures.length === 1 ? "" : "s"} whose first real message fails.`,
  };
}

/** The lane a contract is bound to, so a caller need not reach into the record. */
export function laneOfContract(version: ContractVersion): Lane {
  return version.lane;
}
