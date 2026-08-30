// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * File:    packages/foundry-evolutioniq/src/interop/evolution.ts
 * Module:  foundry-evolutioniq / interop
 * Purpose: Learning from connection failures without inheriting their contents.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// THE THIN FOUNDATION, AND WHY THIN IS THE POINT
//
// The build prompt asks for scenario and evidence storage NOW so that every
// test being written for the Fabric, Sentinel and later engines becomes a
// permanent asset, with "the full autonomous research cadence" deferred behind
// security and governance gates. That ordering is right and worth stating: the
// corpus is what makes the research loop possible later, and building the loop
// first would produce an engine that learns confidently from nothing.
//
// So this file is storage shapes, ingestion, generalization and promotion
// GATES. It has no scheduler, no crawler and no network. What it has instead
// is a set of refusals that the eventual autonomous version will need and
// would be much harder to retrofit.
//
// RESEARCH CONTENT IS UNTRUSTED INPUT
//
// The expansion blueprint says it twice, and it deserves the emphasis: an
// external document is attacker-controlled text arriving inside a system that
// writes code. Prompt injection, poisoned examples, stale specifications,
// license contamination — all of it enters as something that LOOKS like
// knowledge. `ResearchSource` therefore records provenance, license class and
// trust level, and `mayInformCandidate` refuses to let an unreviewed source
// justify a promotion. Nothing here executes anything it read.
//
// STRUCTURAL, NOT IMPORTED
//
// The evidence shape below is declared structurally rather than imported from
// @proworks-hub/neural-fabric. Foundry consuming the Fabric's type would make
// Foundry's build depend on the Fabric's version, and the Fabric is the
// component that has to keep working when the learning layer is absent —
// coupling them in that direction is exactly backwards. The two shapes are
// checked against each other by a test in the Fabric's own suite instead.
// ─────────────────────────────────────────────────────────────────────────────

// ── Scenario Library ─────────────────────────────────────────────────────────

export const scenarioKindSchema = z.enum([
  "INTEROPERABILITY",
  "SECURITY_ADVERSARIAL",
  "RESILIENCE_CHAOS",
  "PERFORMANCE_SCALE",
  "UPGRADE_ROLLBACK",
  "CROSS_INSTANCE",
  "EDGE_OFFLINE",
]);
export type ScenarioKind = z.infer<typeof scenarioKindSchema>;

export const scenarioDefinitionSchema = z
  .object({
    scenarioId: z.string().min(1),
    kind: scenarioKindSchema,
    title: z.string().min(1),
    /** What this scenario is trying to find out. */
    question: z.string().min(1),
    /** The invariant that must hold. A scenario without one proves nothing. */
    invariant: z.string().min(1),
    /** Which engine contributed it. Every engine may add scenario packs. */
    contributedBy: z.string().min(1),
    /**
     * Deterministic seed.
     *
     * Required, because a scenario that cannot be re-run identically is an
     * anecdote. Reproducing a failure six months later is the entire value of
     * a permanent corpus.
     */
    seed: z.number().int().nonnegative(),
    /** True when the scenario uses only synthetic data. Enforced on ingest. */
    syntheticDataOnly: z.literal(true),
    createdAt: z.string().min(1),
  })
  .strict();
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>;

export const scenarioVersionSchema = z
  .object({
    scenarioId: z.string().min(1),
    version: z.number().int().positive(),
    /** The scenario body, opaque to the store. */
    specJson: z.string().min(1),
    /** Why this version differs. Required — an unexplained edit is a fork. */
    changeReason: z.string().min(1),
    supersedesVersion: z.number().int().positive().nullable(),
    createdAt: z.string().min(1),
  })
  .strict();
export type ScenarioVersion = z.infer<typeof scenarioVersionSchema>;

/**
 * The scenario corpus.
 *
 * Append-only by design. `retire` marks a scenario superseded and never
 * deletes it: a scenario that stopped being run is a regression nobody is
 * watching for any more, and losing the record of why it was retired is how
 * the same bug ships twice.
 */
export interface ScenarioStore {
  put(definition: ScenarioDefinition, version: ScenarioVersion): void;
  get(scenarioId: string): { readonly definition: ScenarioDefinition; readonly versions: readonly ScenarioVersion[] } | null;
  list(kind?: ScenarioKind): readonly ScenarioDefinition[];
  retire(scenarioId: string, reason: string, at: string): boolean;
}

// ── Evidence Library ─────────────────────────────────────────────────────────

export const simulationOutcomeSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);
export type SimulationOutcome = z.infer<typeof simulationOutcomeSchema>;

export const simulationRunSchema = z
  .object({
    runId: z.string().min(1),
    scenarioId: z.string().min(1),
    scenarioVersion: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
    outcome: simulationOutcomeSchema,
    /**
     * Required when the outcome is INCONCLUSIVE.
     *
     * The Simulation Lab's rule: if the intended fault did not actually
     * occur, return INCONCLUSIVE rather than a false pass. An inconclusive
     * run that does not say why is indistinguishable from a pass to anyone
     * skimming, which defeats the reason the outcome exists.
     */
    inconclusiveReason: z.string().min(1).nullable(),
    /** Component versions under test, so a result can be scoped. */
    componentVersions: z.record(z.string(), z.string()),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
  })
  .strict()
  .refine((r) => r.outcome !== "INCONCLUSIVE" || r.inconclusiveReason !== null, {
    message:
      "An inconclusive run must say why it was inconclusive. Without a reason it reads as a pass to everyone who skims, which is precisely what the outcome exists to prevent.",
    path: ["inconclusiveReason"],
  });
export type SimulationRun = z.infer<typeof simulationRunSchema>;

export const evidenceRecordSchema = z
  .object({
    evidenceId: z.string().min(1),
    /** What produced it. */
    sourceKind: z.enum(["SIMULATION", "FABRIC_FAILURE", "BENCHMARK", "CERTIFICATION", "SENTINEL_FINDING", "MUTATION_RUN"]),
    /** The run or observation this came from. */
    sourceRef: z.string().min(1),
    /** Summary safe to retain permanently. Never a payload. */
    summary: z.string().min(1).max(2_000),
    /** Structured facts, bounded. Values are scalars, never blobs. */
    facts: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])),
    /**
     * True when a human confirmed this contains no private data.
     *
     * Defaults to false and is not set by ingestion. Promotion gates require
     * it — see `mayPromoteLesson`.
     */
    privacyReviewed: z.boolean(),
    recordedAt: z.string().min(1),
  })
  .strict();
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export interface EvidenceStore {
  record(evidence: EvidenceRecord): void;
  recordRun(run: SimulationRun): void;
  byScenario(scenarioId: string): readonly SimulationRun[];
  find(sourceKind: EvidenceRecord["sourceKind"]): readonly EvidenceRecord[];
}

// ── Research Observatory ─────────────────────────────────────────────────────

export const licenseClassSchema = z.enum([
  /** Public standards and specifications. Safe to learn from and cite. */
  "OPEN_STANDARD",
  /** Permissive open source (MIT/Apache/BSD-style). */
  "PERMISSIVE_OSS",
  /** Copyleft. Learning from behaviour is fine; copying code is not. */
  "COPYLEFT_OSS",
  /** Proprietary documentation. Read, cite, never copy. */
  "PROPRIETARY_DOCS",
  /** Unknown provenance. Treated as the most restrictive case. */
  "UNKNOWN",
]);
export type LicenseClass = z.infer<typeof licenseClassSchema>;

export const researchSourceSchema = z
  .object({
    sourceId: z.string().min(1),
    url: z.string().min(1),
    title: z.string().min(1),
    licenseClass: licenseClassSchema,
    /** When it was captured. Standards move; a stale reading misleads. */
    retrievedAt: z.string().min(1),
    /** Digest of what was actually read, so a later change is detectable. */
    contentDigest: z.string().min(1),
    /**
     * Trust level. Nothing is TRUSTED on arrival.
     *
     * External content is attacker-controlled text entering a system that
     * writes code. UNREVIEWED is the only honest default, and promotion gates
     * refuse to act on it.
     */
    trust: z.enum(["UNREVIEWED", "REVIEWED", "REJECTED"]),
    /** Required once reviewed: who read it and what they concluded. */
    reviewNote: z.string().min(1).nullable(),
    /** True when the source may contain personal data. Forces handling rules. */
    mayContainPersonalData: z.boolean(),
  })
  .strict()
  .refine((s) => s.trust === "UNREVIEWED" || s.reviewNote !== null, {
    message: "A reviewed or rejected source must record who reviewed it and what they concluded, or the review is not reproducible.",
    path: ["reviewNote"],
  });
export type ResearchSource = z.infer<typeof researchSourceSchema>;

/** Whether a source may justify a candidate change. */
export function mayInformCandidate(source: ResearchSource): { readonly permitted: boolean; readonly reason: string } {
  if (source.trust === "REJECTED") {
    return { permitted: false, reason: `Source ${source.sourceId} was rejected on review: ${source.reviewNote}` };
  }
  if (source.trust === "UNREVIEWED") {
    return {
      permitted: false,
      reason: `Source ${source.sourceId} has not been reviewed. External content is untrusted input — a plausible-looking document is exactly what a poisoning attempt produces, and "it was on the internet" is not provenance.`,
    };
  }
  if (source.licenseClass === "UNKNOWN") {
    return {
      permitted: false,
      reason: `Source ${source.sourceId} has an unknown license. Unknown is treated as the most restrictive case, because license contamination is discovered by lawyers rather than by tests.`,
    };
  }
  return {
    permitted: true,
    reason: `Reviewed (${source.reviewNote}) under ${source.licenseClass}. Behaviour and patterns may inform a candidate; code may not be copied.`,
  };
}

// ── Connection failure patterns and the knowledge graph ──────────────────────

/**
 * The Fabric's minimized evidence, declared structurally.
 *
 * See the header: this is deliberately not an import.
 */
export interface IngestedFailureEvidence {
  readonly evidenceId: string;
  readonly intentFingerprint: string;
  readonly failureStage: string;
  readonly failureCode: string;
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly providerFamily: string | null;
  readonly patternId: string | null;
  readonly classification: string;
  readonly generalizedTags: readonly string[];
  readonly attemptCount: number;
  readonly isTest: boolean;
  readonly observedAt: string;
}

/** Fields that must never appear on ingested evidence. */
export const FORBIDDEN_EVIDENCE_FIELDS: readonly string[] = Object.freeze([
  "tenantId",
  "participantId",
  "instanceId",
  "payload",
  "payloadSample",
  "errorMessage",
  "fieldNames",
  "customerId",
  "userId",
  "email",
]);

export type IngestVerdict =
  | { readonly ingested: true; readonly pattern: ConnectionFailurePattern }
  | { readonly ingested: false; readonly reason: string };

export const connectionFailurePatternSchema = z
  .object({
    patternKey: z.string().min(1),
    intentFingerprint: z.string().min(1),
    failureStage: z.string().min(1),
    failureCode: z.string().min(1),
    /** Distinct instances that have hit this. A count, never a list. */
    observationCount: z.number().int().positive(),
    adapterIds: z.array(z.string().min(1)).max(50),
    providerFamilies: z.array(z.string().min(1)).max(50),
    tags: z.array(z.string().min(1)).max(20),
    firstObservedAt: z.string().min(1),
    lastObservedAt: z.string().min(1),
  })
  .strict();
export type ConnectionFailurePattern = z.infer<typeof connectionFailurePatternSchema>;

/**
 * Ingests one minimized failure into a reusable failure class.
 *
 * The guard is deliberately paranoid: it inspects the OBJECT for forbidden
 * keys rather than trusting the Fabric to have minimized correctly. Two
 * independent checks on the same property is the right amount when the
 * failure mode is silent cross-tenant data retention — the Fabric's
 * minimizer could be bypassed by a caller constructing the record by hand,
 * and this is the layer that would notice.
 */
export function ingestFailure(
  evidence: IngestedFailureEvidence,
  existing: ConnectionFailurePattern | null,
): IngestVerdict {
  const present = FORBIDDEN_EVIDENCE_FIELDS.filter((f) => f in (evidence as unknown as Record<string, unknown>));
  if (present.length > 0) {
    return {
      ingested: false,
      reason: `Refused: the record carries ${present.join(", ")}, which must never reach the corpus. Evidence is retained permanently and shared across instances, so a field that identifies anybody becomes a permanent cross-tenant disclosure.`,
    };
  }

  const patternKey = `${evidence.intentFingerprint}:${evidence.failureStage}:${evidence.failureCode}`;

  if (existing === null) {
    return {
      ingested: true,
      pattern: {
        patternKey,
        intentFingerprint: evidence.intentFingerprint,
        failureStage: evidence.failureStage,
        failureCode: evidence.failureCode,
        observationCount: 1,
        adapterIds: evidence.adapterId === null ? [] : [evidence.adapterId],
        providerFamilies: evidence.providerFamily === null ? [] : [evidence.providerFamily],
        tags: [...evidence.generalizedTags].slice(0, 20),
        firstObservedAt: evidence.observedAt,
        lastObservedAt: evidence.observedAt,
      },
    };
  }

  const mergeCapped = (before: readonly string[], candidate: string | null, cap: number): string[] =>
    candidate === null || before.includes(candidate) ? [...before] : [...before, candidate].slice(0, cap);

  return {
    ingested: true,
    pattern: {
      ...existing,
      observationCount: existing.observationCount + 1,
      adapterIds: mergeCapped(existing.adapterIds, evidence.adapterId, 50),
      providerFamilies: mergeCapped(existing.providerFamilies, evidence.providerFamily, 50),
      tags: [...new Set([...existing.tags, ...evidence.generalizedTags])].slice(0, 20),
      firstObservedAt: evidence.observedAt < existing.firstObservedAt ? evidence.observedAt : existing.firstObservedAt,
      lastObservedAt: evidence.observedAt > existing.lastObservedAt ? evidence.observedAt : existing.lastObservedAt,
    },
  };
}

/** A node in the connection knowledge graph. */
export const knowledgeNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    kind: z.enum(["PROTOCOL", "CONTRACT_PROFILE", "ADAPTER", "PLATFORM", "FAILURE_CLASS", "REMEDY", "PATTERN"]),
    label: z.string().min(1),
  })
  .strict();
export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;

export const knowledgeEdgeSchema = z
  .object({
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    relation: z.enum(["CAUSES", "REMEDIES", "SUPPORTS", "CONFLICTS_WITH", "SUPERSEDES", "OBSERVED_ON"]),
    /** How many observations back this edge. Confidence is earned, not set. */
    observationCount: z.number().int().nonnegative(),
    /** Evidence backing it. An edge with none is an opinion. */
    evidenceRefs: z.array(z.string().min(1)).min(1).max(50),
  })
  .strict();
export type KnowledgeEdge = z.infer<typeof knowledgeEdgeSchema>;

// ── Generalized lessons and improvement packets ──────────────────────────────

export const generalizedLessonSchema = z
  .object({
    lessonId: z.string().min(1),
    /** The failure class this generalizes. */
    patternKey: z.string().min(1),
    /** What was learned, in words that apply to any instance. */
    statement: z.string().min(1).max(2_000),
    /** Suggested remedy. Advice, not an instruction. */
    suggestedRemedy: z.string().min(1).max(2_000),
    /** How many independent observations support it. */
    supportingObservations: z.number().int().positive(),
    evidenceRefs: z.array(z.string().min(1)).min(1).max(50),
    researchSourceIds: z.array(z.string().min(1)).max(20),
    /** Confirmed to contain nothing instance-specific. */
    privacyReviewed: z.boolean(),
    /** DRAFT until Governance promotes it. Nothing here advances it. */
    status: z.enum(["DRAFT", "PROPOSED", "PROMOTED", "RETIRED"]),
    promotingDecisionRef: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  })
  .strict()
  .refine((l) => l.status !== "PROMOTED" || l.promotingDecisionRef !== null, {
    message: "A promoted lesson must name the decision that promoted it.",
    path: ["promotingDecisionRef"],
  });
export type GeneralizedLesson = z.infer<typeof generalizedLessonSchema>;

export const improvementPacketSchema = z
  .object({
    packetId: z.string().min(1),
    kind: z.enum(["ADAPTER_CANDIDATE", "MAPPING_CANDIDATE", "PATTERN_CHANGE", "CONTRACT_PROFILE", "MANUAL_LIBRARY_UPDATE"]),
    title: z.string().min(1),
    rationale: z.string().min(1),
    /** The proposed change, as a diff or spec. Never applied by Foundry. */
    diff: z.string().min(1),
    /** Tests that must pass. A packet without them is a suggestion. */
    testRefs: z.array(z.string().min(1)).min(1).max(200),
    /** Simulation runs behind it. */
    simulationRunIds: z.array(z.string().min(1)).max(200),
    /** Benchmarks, when performance is claimed. */
    benchmarkRefs: z.array(z.string().min(1)).max(50),
    riskAssessment: z.string().min(1),
    securityReviewRef: z.string().min(1).nullable(),
    rollbackPlan: z.string().min(1),
    researchSourceIds: z.array(z.string().min(1)).max(20),
    /** Approvals gathered so far. Foundry gathers; it does not grant. */
    approvals: z.array(z.string().min(1)).max(20),
    status: z.enum(["SANDBOX", "READY_FOR_REVIEW", "APPROVED", "REJECTED"]),
    createdAt: z.string().min(1),
  })
  .strict()
  .refine((p) => p.status !== "APPROVED" || p.approvals.length > 0, {
    message: "An approved packet must carry its approvals. A status field is not an approval.",
    path: ["approvals"],
  });
export type ImprovementPacket = z.infer<typeof improvementPacketSchema>;

export type PromotionGateVerdict =
  | { readonly permitted: true; readonly reason: string }
  | { readonly permitted: false; readonly blockers: readonly string[] };

/**
 * Whether a lesson may be promoted to other instances.
 *
 * Promotion is the moment a local observation becomes collective knowledge,
 * and it is the last point at which a mistake is cheap. The gates check the
 * three ways promotion goes wrong: promoting something instance-specific
 * (privacy), promoting a coincidence (support), and promoting something
 * justified by an unreviewed source (provenance).
 */
export function mayPromoteLesson(
  lesson: GeneralizedLesson,
  sources: readonly ResearchSource[],
  minimumObservations = 3,
): PromotionGateVerdict {
  const blockers: string[] = [];

  if (!lesson.privacyReviewed) {
    blockers.push(
      "No privacy review. A lesson crosses instance boundaries permanently, so anything instance-specific inside it becomes a disclosure that cannot be recalled.",
    );
  }
  if (lesson.supportingObservations < minimumObservations) {
    blockers.push(
      `Only ${lesson.supportingObservations} supporting observation(s) against a minimum of ${minimumObservations}. One instance's experience is a coincidence until it repeats somewhere else, and a promoted coincidence teaches every future instance the wrong thing.`,
    );
  }
  if (lesson.evidenceRefs.length === 0) {
    blockers.push("No evidence references. A lesson nobody can trace back is folklore.");
  }

  for (const sourceId of lesson.researchSourceIds) {
    const source = sources.find((s) => s.sourceId === sourceId);
    if (source === undefined) {
      blockers.push(`Research source ${sourceId} is cited but not on record. A citation that cannot be resolved is worse than none.`);
      continue;
    }
    const verdict = mayInformCandidate(source);
    if (!verdict.permitted) blockers.push(verdict.reason);
  }

  if (blockers.length > 0) return { permitted: false, blockers };
  return {
    permitted: true,
    reason: `${lesson.supportingObservations} observations, privacy reviewed, ${lesson.researchSourceIds.length} reviewed source(s). Eligible to be PROPOSED — Governance still takes the decision.`,
  };
}

// ── The refusals that make the rest safe ─────────────────────────────────────

/** Foundry proposes. It does not deploy, and there is no function here that could. */
export function foundryMayDeployToProduction(): false {
  return false;
}

/** Foundry may not grant authority to anything, including itself. */
export function foundryMayGrantAuthority(): false {
  return false;
}

/** Foundry cannot alter Governance policy or Sentinel's findings. */
export function foundryMayModifyGovernanceOrSentinel(): false {
  return false;
}

/** Research is read and cited. Nothing read is ever executed. */
export function foundryExecutesResearchedCode(): false {
  return false;
}
