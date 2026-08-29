// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The V2 scenario contract.
//
// Mirrors `corpus/simulation-v2.schema.json`, which the directive names as the
// starting contract. Written as Zod rather than validated against the JSON
// Schema at runtime so that a scenario becomes a TYPE — a harness that reads
// `scenario.learning.faultClass` should not compile if the field moves.
//
// TWO THINGS THE CORPUS TAUGHT ME, WHICH CHANGED THE TYPES
//
// 1. `learning.violatedInvariants` DOES NOT MEAN VIOLATED.
//
//    All 80 happy-path scenarios (faultClass NONE_HAPPY_PATH, "No fault
//    expected") carry a non-empty `violatedInvariants` array. SIM-0001 lists
//    OWNERSHIP-001 and CORRELATION-001 while asserting nothing goes wrong.
//
//    So the field means "the invariants this scenario puts at risk" — what to
//    watch — not "the invariants that were broken". It is loaded as
//    `invariantsAtRisk`, because a field named `violatedInvariants` will
//    eventually be read as a list of violations by somebody in a hurry, and
//    then 80 passing scenarios each report two constitutional breaches.
//
//    The directive says the same thing from the other side (§8): "Do not mark
//    an invariant violation merely because a test title suggests one. Use
//    evidence."
//
// 2. `learning.expectedDiagnosis` IS AN EXPECTATION, NOT A FINDING.
//
//    Directive §1: "Do not assume every expected diagnosis is true. Expected
//    diagnosis is a test expectation. Actual diagnosis must come from runtime
//    evidence." It is kept in a nested `expectation` object so that no
//    diagnostic code can reach a scenario's expected answer by accident — the
//    diagnosis pipeline never receives the scenario, only the evidence.
// ─────────────────────────────────────────────────────────────────────────────

/** Kinds of component a scenario may name. From `component-map.json`. */
export const componentKindSchema = z.enum([
  "ENGINE",
  "HOST_APPLICATION",
  "INFRASTRUCTURE",
  /**
   * The migration could not map this name to anything canonical.
   *
   * 30 components in the corpus, all carrying
   * `resolutionStatus: REQUIRES_ARCHITECTURE_REVIEW`. Kept as a first-class
   * kind rather than dropped, because a scenario about an unresolved component
   * is still a scenario — it just cannot produce findings about a component
   * nobody has confirmed exists. `scenarioIsGrounded()` below is what acts on
   * that.
   */
  "UNRESOLVED_COMPONENT",
]);

export const scenarioComponentSchema = z
  .object({
    /** The name as the scenario author wrote it. Kept for traceability. */
    sourceName: z.string().min(1),
    /** The canonical id. `hive.specialized.forgeiq`, not "ForgeIQ". */
    componentId: z.string().min(1),
    componentKind: componentKindSchema,
    engineClassification: z.string().min(1).optional(),
    /**
     * Whether the mapping is trustworthy.
     *
     * The V2 migration resolved most names against the component map; some it
     * guessed. A scenario built on an unresolved component is still runnable,
     * but its findings are about a component nobody has confirmed exists.
     */
    resolutionStatus: z.string().min(1).optional(),
  })
  .strict();
export type ScenarioComponent = z.infer<typeof scenarioComponentSchema>;

export const scenarioTypeSchema = z.enum([
  "VALIDATION",
  "FAULT_INJECTION",
  "CHAOS_FUZZ",
  "EXPERIMENTAL",
]);
export type ScenarioType = z.infer<typeof scenarioTypeSchema>;

// The V2 JSON Schema types these three as plain strings, so I guessed the value
// sets and got all three wrong — 919 of 1000 scenarios were rejected on the
// first run. These are the values the corpus actually uses.
export const severitySchema = z.enum(["INFO", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * How far the failure reaches.
 *
 * Sixteen values, and DELIBERATELY NOT ORDERED. They are heterogeneous — some
 * name a scope (WORK_ORDER, TENANT, HIVE), some a domain (FINANCIAL,
 * INVENTORY), some a layer (ARCHITECTURE, ENGINE). There is no honest
 * comparison between ARCHITECTURE and FINANCIAL, so nothing here ranks them
 * and no scoring dimension treats this as a scale.
 */
export const blastRadiusSchema = z.enum([
  "REQUEST",
  "WORK_ORDER",
  "WORKFLOW",
  "LOCAL_WORKFLOW",
  "TENANT_WORKFLOW",
  "CUSTOMER_VIEW",
  "ENGINE",
  "MULTI_ENGINE",
  "CROSS_ENGINE_TRACE",
  "AUTHORITY_SCOPE",
  "DOMAIN",
  "INVENTORY",
  "FINANCIAL",
  "TENANT",
  "ARCHITECTURE",
  "HIVE",
]);

/**
 * Whether the damage can be undone.
 *
 * `CONTAIN_FIRST` is the corpus's own value and a better idea than the
 * "partially reversible" I had assumed: it says the question of reversibility
 * comes AFTER containment, not instead of it.
 */
export const reversibilitySchema = z.enum(["REVERSIBLE", "CONTAIN_FIRST", "NOT_APPLICABLE"]);

/**
 * The learning metadata — what V2 added over V1.
 *
 * Everything here is the scenario author's INTENT. None of it is evidence, and
 * the harness must never promote it to evidence. Hence the split below: the
 * fields that describe what to inject and what to capture are operational, and
 * the fields that describe what should be concluded are quarantined under
 * `expectation`.
 */
export const learningMetadataSchema = z
  .object({
    scenarioType: scenarioTypeSchema,
    faultClass: z.string().min(1),
    faultInjection: z.string().nullable().optional(),

    expectedDetection: z.string().min(1),
    expectedDiagnosis: z.string().min(1),
    expectedContainment: z.string().min(1),
    expectedRecovery: z.string().min(1),

    /** SEE THE HEADER. This is "at risk", not "was violated". */
    violatedInvariants: z.array(z.string().min(1)),
    requiredEvidence: z.array(z.string().min(1)),

    repairClass: z.string().min(1),
    allowedRepairActions: z.array(z.string().min(1)).optional(),
    /** Enforced in Phase D. A candidate doing any of these is rejected. */
    forbiddenRepairActions: z.array(z.string().min(1)),

    severity: severitySchema,
    blastRadius: blastRadiusSchema,
    reversibility: reversibilitySchema,

    tenantAndDataClass: z.record(z.string(), z.unknown()).optional(),
    generalizationCandidate: z.boolean().optional(),
    metadataConfidence: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  })
  .strict();
export type LearningMetadata = z.infer<typeof learningMetadataSchema>;

/**
 * A raw V2 scenario, exactly as it appears in the corpus.
 *
 * `.passthrough()` rather than `.strict()`, deliberately and unusually: V1
 * fields the migration preserved (`engines`, `tags`) still ride along, and the
 * directive says "Preserve the original V1 scenarios. Do not rewrite the
 * scenario intent simply to make implementation easier." Dropping unknown
 * fields would quietly discard scenario intent this code has not learned to
 * read yet.
 */
export const rawScenarioSchema = z
  .object({
    id: z.string().regex(/^SIM-[0-9]{4,}$/),
    family: z.string().min(1),
    title: z.string().min(1),
    schemaVersion: z.literal("2.0"),
    components: z.array(scenarioComponentSchema),
    setup: z.string(),
    steps: z.array(z.string()),
    mustPass: z.array(z.string()),
    mustFailTheEngineIf: z.string(),
    tags: z.array(z.string()).optional(),
    v1Gate: z.boolean().optional(),
    learning: learningMetadataSchema,
  })
  .passthrough();
export type RawScenario = z.infer<typeof rawScenarioSchema>;

/**
 * What the scenario author expects to be concluded.
 *
 * QUARANTINED ON PURPOSE. The diagnostic pipeline is never handed a Scenario;
 * it is handed evidence. This object exists so a TEST can compare what was
 * concluded against what was expected, and so the gap between them is visible
 * rather than assumed away.
 */
export interface ScenarioExpectation {
  readonly detection: string;
  readonly diagnosis: string;
  readonly containment: string;
  readonly recovery: string;
  /** Conditions the run must satisfy. */
  readonly mustPass: readonly string[];
  /** The condition under which the ENGINE, not the test, has failed. */
  readonly mustFailTheEngineIf: string;
}

/** A loaded scenario: operational fields flat, expectations quarantined. */
export interface Scenario {
  readonly id: string;
  readonly family: string;
  readonly title: string;
  readonly schemaVersion: "2.0";
  readonly components: readonly ScenarioComponent[];
  readonly setup: string;
  readonly steps: readonly string[];

  readonly scenarioType: ScenarioType;
  readonly faultClass: string;
  readonly faultInjection: string | null;

  /**
   * Invariants this scenario PUTS AT RISK.
   *
   * Renamed from the corpus's `violatedInvariants`. See the header: every
   * happy-path scenario carries a non-empty list, so the corpus field cannot
   * mean "violated". These are what to watch, and the classifier decides from
   * evidence which of them actually broke.
   */
  readonly invariantsAtRisk: readonly string[];
  readonly requiredEvidence: readonly string[];

  readonly repairClass: string;
  readonly allowedRepairActions: readonly string[];
  readonly forbiddenRepairActions: readonly string[];

  readonly severity: z.infer<typeof severitySchema>;
  readonly blastRadius: z.infer<typeof blastRadiusSchema>;
  readonly reversibility: z.infer<typeof reversibilitySchema>;

  readonly generalizationCandidate: boolean;
  readonly v1Gate: boolean;
  readonly tags: readonly string[];

  readonly expectation: ScenarioExpectation;
}

export type ScenarioLoad =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly reason: string };

/** Parses one raw corpus entry into a Scenario. */
export function loadScenario(input: unknown): ScenarioLoad {
  const parsed = rawScenarioSchema.safeParse(input);
  if (!parsed.success) {
    const id =
      typeof input === "object" && input !== null && "id" in input
        ? String((input as { id: unknown }).id)
        : "<no id>";
    return {
      ok: false,
      reason: `Scenario ${id} does not satisfy the V2 contract: ${JSON.stringify(parsed.error.flatten())}`,
    };
  }

  const raw = parsed.data;
  const l = raw.learning;

  return {
    ok: true,
    scenario: {
      id: raw.id,
      family: raw.family,
      title: raw.title,
      schemaVersion: raw.schemaVersion,
      components: raw.components,
      setup: raw.setup,
      steps: raw.steps,

      scenarioType: l.scenarioType,
      faultClass: l.faultClass,
      faultInjection: l.faultInjection ?? null,

      invariantsAtRisk: l.violatedInvariants,
      requiredEvidence: l.requiredEvidence,

      repairClass: l.repairClass,
      allowedRepairActions: l.allowedRepairActions ?? [],
      forbiddenRepairActions: l.forbiddenRepairActions,

      severity: l.severity,
      blastRadius: l.blastRadius,
      reversibility: l.reversibility,

      generalizationCandidate: l.generalizationCandidate ?? false,
      v1Gate: raw.v1Gate ?? false,
      tags: raw.tags ?? [],

      expectation: {
        detection: l.expectedDetection,
        diagnosis: l.expectedDiagnosis,
        containment: l.expectedContainment,
        recovery: l.expectedRecovery,
        mustPass: raw.mustPass,
        mustFailTheEngineIf: raw.mustFailTheEngineIf,
      },
    },
  };
}

export interface CorpusLoad {
  readonly scenarios: readonly Scenario[];
  readonly rejected: readonly { index: number; reason: string }[];
}

/**
 * Loads a whole corpus, keeping what parses and reporting what does not.
 *
 * Partial rather than all-or-nothing: one malformed scenario out of a thousand
 * should not make the corpus unusable, and a silently skipped scenario is worse
 * than a listed one. The caller decides whether the rejection count is
 * tolerable.
 */
export function loadCorpus(entries: readonly unknown[]): CorpusLoad {
  const scenarios: Scenario[] = [];
  const rejected: { index: number; reason: string }[] = [];

  entries.forEach((entry, index) => {
    const result = loadScenario(entry);
    if (result.ok) scenarios.push(result.scenario);
    else rejected.push({ index, reason: result.reason });
  });

  return { scenarios, rejected };
}

/**
 * Whether a scenario's components are all confirmed to exist.
 *
 * 30 corpus components are `UNRESOLVED_COMPONENT` with
 * `resolutionStatus: REQUIRES_ARCHITECTURE_REVIEW` — the V2 migration saying
 * honestly that it could not map a name onto anything canonical.
 *
 * Such a scenario still RUNS. What it must not do is produce a finding, a
 * diagnosis or a repair aimed at a component nobody has confirmed exists: the
 * repair would target a guess, and the lesson learned from it would be about a
 * component that may never have been real. The corpus flagged these for
 * architecture review, and this is the code that keeps the flag meaningful
 * instead of decorative.
 */
export function scenarioIsGrounded(scenario: Scenario): {
  grounded: boolean;
  unresolved: readonly string[];
} {
  const unresolved = scenario.components
    .filter(
      (c) =>
        c.componentKind === "UNRESOLVED_COMPONENT" ||
        c.resolutionStatus === "REQUIRES_ARCHITECTURE_REVIEW",
    )
    .map((c) => c.sourceName);

  return { grounded: unresolved.length === 0, unresolved };
}
