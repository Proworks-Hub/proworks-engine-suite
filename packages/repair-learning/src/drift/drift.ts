// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Drift detection (directive §32).
//
// "Create a Drift Detection Bot or subsystem. It should compare expected
// architecture, actual manifest, actual contracts, actual dependencies, actual
// runtime behavior. Possible findings: missing Governance hook, new undeclared
// dependency, changed source-of-truth owner, unchartered component, contract
// drift, provider hard-coupling, tenant-boundary regression. These findings may
// create Repair-Learning scenarios."
//
// DRIFT IS A COMPARISON, SO BOTH SIDES MUST BE SUPPLIED
//
// Every check here takes DECLARED and ACTUAL as inputs. Nothing reads the
// filesystem, parses TypeScript, or shells out to a package manager — that
// would bind this to one language and one toolchain, which §41 forbids and
// which would make the detector useless in the multi-language Hive it is
// supposed to watch.
//
// The cost is that a host must produce both sides. The benefit is that the same
// detector works against a TypeScript monorepo, a Python service and a manifest
// scraped from a running cluster.
//
// WHAT IT FINDS IS NOT A VIOLATION
//
// Drift findings are OBSERVATIONS with a severity, not verdicts. A new
// undeclared dependency might be a supply-chain problem or might be somebody
// legitimately adding a library and forgetting the manifest. The detector says
// what differs; a human or a Governance decision says what it means.
//
// This is also where two invariants that the runtime detectors correctly
// refused to fake get answered: PORTABILITY (provider hard-coupling) and
// CHARTER (unchartered components) are architectural questions, not runtime
// ones, and this is the right place for them.
// ─────────────────────────────────────────────────────────────────────────────

export const driftKindSchema = z.enum([
  "MISSING_GOVERNANCE_HOOK",
  "UNDECLARED_DEPENDENCY",
  "REMOVED_DECLARED_DEPENDENCY",
  "SOURCE_OF_TRUTH_OWNER_CHANGED",
  "UNCHARTERED_COMPONENT",
  "CONTRACT_DRIFT",
  "PROVIDER_HARD_COUPLING",
  "TENANT_BOUNDARY_REGRESSION",
  "UNDECLARED_COMPONENT",
  "MISSING_DECLARED_COMPONENT",
]);
export type DriftKind = z.infer<typeof driftKindSchema>;

export const driftSeveritySchema = z.enum(["INFO", "MEDIUM", "HIGH", "CRITICAL"]);
export type DriftSeverity = z.infer<typeof driftSeveritySchema>;

export interface DriftFinding {
  readonly findingId: string;
  readonly kind: DriftKind;
  readonly severity: DriftSeverity;
  readonly componentId: string;
  /** What the architecture says. */
  readonly declared: string;
  /** What is actually there. */
  readonly actual: string;
  readonly detail: string;
  /**
   * Whether this finding could become a regression scenario (§33).
   *
   * Not everything should. A missing manifest entry is a documentation fix; a
   * tenant-boundary regression is worth a permanent scenario so it cannot come
   * back unnoticed.
   */
  readonly scenarioWorthy: boolean;
}

// ── The two sides of the comparison ──────────────────────────────────────────

export const declaredComponentSchema = z
  .object({
    componentId: z.string().min(1),
    /** The charter governing it, or null for an infrastructure package. */
    charterId: z.string().min(1).nullable(),
    /** Entity types this component is the source of truth for. */
    ownsSourceOfTruthFor: z.array(z.string().min(1)).default([]),
    /** Components it is declared to depend on. */
    dependsOn: z.array(z.string().min(1)).default([]),
    /** Contracts it produces or consumes, with the version declared. */
    contracts: z.record(z.string(), z.string()).default({}),
    /** Whether it must consult Governance before consequential action. */
    requiresGovernance: z.boolean(),
    /** Whether it handles tenant-scoped data. */
    tenantScoped: z.boolean(),
  })
  .strict();
export type DeclaredComponent = z.infer<typeof declaredComponentSchema>;

export const actualComponentSchema = z
  .object({
    componentId: z.string().min(1),
    ownsSourceOfTruthFor: z.array(z.string().min(1)).default([]),
    dependsOn: z.array(z.string().min(1)).default([]),
    contracts: z.record(z.string(), z.string()).default({}),
    /** Observed: does it actually call Governance? */
    callsGovernance: z.boolean(),
    /** Observed: does it actually scope reads and writes by tenant? */
    enforcesTenantScope: z.boolean(),
    /**
     * External providers named in its code or configuration.
     *
     * The host produces this however it can — import analysis, config scan,
     * SBOM. This module does not care how, only what.
     */
    namedProviders: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ActualComponent = z.infer<typeof actualComponentSchema>;

/**
 * Providers whose presence is a portability concern.
 *
 * Constitution portability and Foundry Charter §17: no single AI provider,
 * cloud, repository host or build platform may become constitutionally
 * required. Naming one is not automatically wrong — an adapter behind an
 * interface is fine, which is why this is MEDIUM and not CRITICAL, and why the
 * finding says "named" rather than "coupled to".
 */
const PORTABILITY_SENSITIVE = new Set([
  "aws",
  "gcp",
  "azure",
  "kafka",
  "rabbitmq",
  "redis",
  "dynamodb",
  "s3",
  "openai",
  "anthropic",
  "grok",
  "github",
  "pinecone",
  "twilio",
  "sendgrid",
]);

export interface DriftReport {
  readonly findings: readonly DriftFinding[];
  readonly componentsCompared: number;
  /** Declared components with no actual counterpart, and vice versa. */
  readonly unmatched: readonly string[];
  /** True when nothing drifted. */
  readonly clean: boolean;
}

let sequence = 0;

/**
 * Compares declared architecture against what is actually there.
 *
 * Returns findings, never verdicts. §32's list, one check each.
 */
export function detectDrift(input: {
  declared: readonly DeclaredComponent[];
  actual: readonly ActualComponent[];
  /** Charter ids known to exist. A component citing an unknown one is drift. */
  knownCharterIds?: readonly string[];
  generateId?: () => string;
}): DriftReport {
  const newId = input.generateId ?? (() => `drift_${(sequence += 1)}`);
  const findings: DriftFinding[] = [];
  const unmatched: string[] = [];

  const declaredById = new Map(input.declared.map((d) => [d.componentId, d]));
  const actualById = new Map(input.actual.map((a) => [a.componentId, a]));
  const knownCharters = new Set(input.knownCharterIds ?? []);

  const add = (
    finding: Omit<DriftFinding, "findingId">,
  ): void => {
    findings.push({ findingId: newId(), ...finding });
  };

  // ── Components that exist on one side only ────────────────────────────────
  for (const actual of input.actual) {
    if (declaredById.has(actual.componentId)) continue;
    unmatched.push(actual.componentId);
    add({
      kind: "UNDECLARED_COMPONENT",
      // HIGH, not CRITICAL. A component nobody declared is a real problem, but
      // the common cause is a new package that nobody added to the map — which
      // is exactly the drift this catches, and exactly why it is not an
      // emergency.
      severity: "HIGH",
      componentId: actual.componentId,
      declared: "<not in the architecture>",
      actual: "running",
      detail:
        `${actual.componentId} is running and the architecture does not describe it. ` +
        "Nothing governs what it may do, because nothing has said what it is.",
      scenarioWorthy: false,
    });
  }

  for (const declared of input.declared) {
    if (actualById.has(declared.componentId)) continue;
    unmatched.push(declared.componentId);
    add({
      kind: "MISSING_DECLARED_COMPONENT",
      severity: "MEDIUM",
      componentId: declared.componentId,
      declared: "described in the architecture",
      actual: "<not found>",
      detail:
        `${declared.componentId} is described in the architecture and is not present. ` +
        "Either it was retired without the map being updated, or something that should exist does not.",
      scenarioWorthy: false,
    });
  }

  // ── Per-component comparison ──────────────────────────────────────────────
  let compared = 0;

  for (const declared of input.declared) {
    const actual = actualById.get(declared.componentId);
    if (!actual) continue;
    compared += 1;

    // Governance hook. §32's first named finding.
    if (declared.requiresGovernance && !actual.callsGovernance) {
      add({
        kind: "MISSING_GOVERNANCE_HOOK",
        // CRITICAL. A component that is supposed to ask permission and does
        // not has an authorization gate on paper only, which is the exact
        // shape of the `if (!permSvc) return` failure this whole architecture
        // was built to prevent.
        severity: "CRITICAL",
        componentId: declared.componentId,
        declared: "requiresGovernance: true",
        actual: "does not call Governance",
        detail:
          `${declared.componentId} is declared to require Governance and does not consult it. ` +
          "Capability does not imply permission, and an unenforced requirement is not a requirement.",
        scenarioWorthy: true,
      });
    }

    // Tenant boundary regression.
    if (declared.tenantScoped && !actual.enforcesTenantScope) {
      add({
        kind: "TENANT_BOUNDARY_REGRESSION",
        severity: "CRITICAL",
        componentId: declared.componentId,
        declared: "tenantScoped: true",
        actual: "does not enforce tenant scope",
        detail:
          `${declared.componentId} handles tenant-scoped data and does not scope its reads and writes. ` +
          "A boundary that used to hold and no longer does is worse than one that never existed, because everything downstream assumes it.",
        scenarioWorthy: true,
      });
    }

    // Source-of-truth ownership.
    const declaredOwns = new Set(declared.ownsSourceOfTruthFor);
    const actualOwns = new Set(actual.ownsSourceOfTruthFor);
    const seized = [...actualOwns].filter((e) => !declaredOwns.has(e));
    const abandoned = [...declaredOwns].filter((e) => !actualOwns.has(e));

    if (seized.length > 0) {
      add({
        kind: "SOURCE_OF_TRUTH_OWNER_CHANGED",
        severity: "CRITICAL",
        componentId: declared.componentId,
        declared: `owns ${[...declaredOwns].join(", ") || "nothing"}`,
        actual: `also writes ${seized.join(", ")}`,
        detail:
          `${declared.componentId} has become authoritative for ${seized.join(", ")}, which the architecture assigns elsewhere. ` +
          "Two sources of truth for one entity is not redundancy; it is a disagreement waiting to be discovered by a customer.",
        scenarioWorthy: true,
      });
    }

    if (abandoned.length > 0) {
      add({
        kind: "SOURCE_OF_TRUTH_OWNER_CHANGED",
        severity: "HIGH",
        componentId: declared.componentId,
        declared: `owns ${abandoned.join(", ")}`,
        actual: "no longer writes it",
        detail: `${declared.componentId} is the declared owner of ${abandoned.join(", ")} and no longer writes it. Something else may have taken over, or nothing owns it now.`,
        scenarioWorthy: true,
      });
    }

    // Dependencies.
    const declaredDeps = new Set(declared.dependsOn);
    const actualDeps = new Set(actual.dependsOn);

    const undeclared = [...actualDeps].filter((d) => !declaredDeps.has(d));
    if (undeclared.length > 0) {
      add({
        kind: "UNDECLARED_DEPENDENCY",
        severity: "HIGH",
        componentId: declared.componentId,
        declared: `depends on ${[...declaredDeps].join(", ") || "nothing"}`,
        actual: `also depends on ${undeclared.join(", ")}`,
        detail:
          `${declared.componentId} depends on ${undeclared.join(", ")}, which the architecture does not record. ` +
          "An undeclared dependency is one nobody checked against the dependency law, and one nobody will think to update.",
        scenarioWorthy: true,
      });
    }

    const removed = [...declaredDeps].filter((d) => !actualDeps.has(d));
    if (removed.length > 0) {
      add({
        kind: "REMOVED_DECLARED_DEPENDENCY",
        // INFO. A dependency that went away is usually good news, and the
        // finding exists so the map catches up rather than to raise an alarm.
        severity: "INFO",
        componentId: declared.componentId,
        declared: `depends on ${removed.join(", ")}`,
        actual: "no longer does",
        detail: `${declared.componentId} no longer depends on ${removed.join(", ")}. The architecture still says it does.`,
        scenarioWorthy: false,
      });
    }

    // Contract drift.
    for (const [name, declaredVersion] of Object.entries(declared.contracts)) {
      const actualVersion = actual.contracts[name];
      if (actualVersion === undefined) {
        add({
          kind: "CONTRACT_DRIFT",
          severity: "MEDIUM",
          componentId: declared.componentId,
          declared: `${name} @ ${declaredVersion}`,
          actual: "<contract not present>",
          detail: `${declared.componentId} declares contract ${name} at ${declaredVersion} and does not use it.`,
          scenarioWorthy: false,
        });
        continue;
      }

      if (actualVersion !== declaredVersion) {
        const majorChanged = actualVersion.split(".")[0] !== declaredVersion.split(".")[0];
        add({
          kind: "CONTRACT_DRIFT",
          // A major-version difference is a compatibility break waiting to
          // happen; a minor one is a stale manifest.
          severity: majorChanged ? "HIGH" : "MEDIUM",
          componentId: declared.componentId,
          declared: `${name} @ ${declaredVersion}`,
          actual: `${name} @ ${actualVersion}`,
          detail: majorChanged
            ? `${declared.componentId} uses ${name} at ${actualVersion} while the architecture declares ${declaredVersion}. A major-version difference means consumers written against the declared version may already be broken.`
            : `${declared.componentId} uses ${name} at ${actualVersion} while the architecture declares ${declaredVersion}.`,
          scenarioWorthy: majorChanged,
        });
      }
    }

    // Provider hard-coupling — the PORTABILITY invariant the runtime detectors
    // correctly refused to fake.
    const sensitive = actual.namedProviders.filter((p) =>
      PORTABILITY_SENSITIVE.has(p.toLowerCase()),
    );
    if (sensitive.length > 0) {
      add({
        kind: "PROVIDER_HARD_COUPLING",
        // MEDIUM, deliberately. Naming a provider is not automatically wrong —
        // an adapter behind an interface is exactly right. The finding says
        // "named", not "coupled to", and a human decides which it is.
        severity: "MEDIUM",
        componentId: declared.componentId,
        declared: "no provider dependency recorded",
        actual: `names ${sensitive.join(", ")}`,
        detail:
          `${declared.componentId} names ${sensitive.join(", ")}. ` +
          "That is fine behind an adapter and a problem in the domain logic. No provider shall become constitutionally required (Foundry Charter §17).",
        scenarioWorthy: false,
      });
    }

    // Unchartered component — the CHARTER invariant, likewise.
    if (declared.charterId !== null && knownCharters.size > 0 && !knownCharters.has(declared.charterId)) {
      add({
        kind: "UNCHARTERED_COMPONENT",
        severity: "HIGH",
        componentId: declared.componentId,
        declared: `charter ${declared.charterId}`,
        actual: "<charter not in the registry>",
        detail: `${declared.componentId} cites charter ${declared.charterId}, which the registry does not contain. A component governed by a document nobody can find is ungoverned.`,
        scenarioWorthy: false,
      });
    }
  }

  return {
    findings,
    componentsCompared: compared,
    unmatched,
    clean: findings.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Turning a drift finding into a regression scenario (§33).
//
// "Eventually the loop should create a regression scenario from a real failure...
// Do not automatically publish production-sensitive data into the scenario.
// Generalize/minimize first."
//
// So this produces a CANDIDATE scenario, not a corpus entry. §34's rule for
// externally-proposed scenarios applies to internally-generated ones for the
// same reason: "External AI may propose. The Hive decides whether the scenario
// becomes trusted validation material."
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateScenario {
  /** No SIM- id. It is not a corpus member until somebody promotes it. */
  readonly candidateId: string;
  readonly title: string;
  readonly family: string;
  readonly components: readonly string[];
  readonly setup: string;
  readonly steps: readonly string[];
  readonly mustPass: readonly string[];
  readonly mustFailTheEngineIf: string;
  readonly faultClass: string;
  readonly invariantsAtRisk: readonly string[];
  readonly severity: DriftSeverity;
  readonly derivedFromFindingId: string;
  /** Always PROPOSED. Promotion is a separate act. */
  readonly status: "PROPOSED";
}

/** Which invariant a drift kind puts at risk. */
const DRIFT_TO_INVARIANT: Readonly<Partial<Record<DriftKind, string>>> = Object.freeze({
  MISSING_GOVERNANCE_HOOK: "HIVE-INV-AUTHORITY-001",
  TENANT_BOUNDARY_REGRESSION: "HIVE-INV-TENANT-001",
  SOURCE_OF_TRUTH_OWNER_CHANGED: "HIVE-INV-OWNERSHIP-001",
  UNDECLARED_DEPENDENCY: "HIVE-INV-PORTABILITY-001",
  CONTRACT_DRIFT: "HIVE-INV-VERSION-LINEAGE-001",
  PROVIDER_HARD_COUPLING: "HIVE-INV-PORTABILITY-001",
  UNCHARTERED_COMPONENT: "HIVE-INV-CHARTER-001",
});

export type ScenarioProposal =
  | { readonly proposed: true; readonly scenario: CandidateScenario }
  | { readonly proposed: false; readonly reason: string };

/**
 * Proposes a regression scenario from a drift finding.
 *
 * Refuses when the finding is not scenario-worthy. Turning every drift finding
 * into a permanent scenario would bury the corpus in stale-manifest entries and
 * make the whole suite slower for no protection — a documentation fix does not
 * need a regression test.
 *
 * The generated scenario contains no tenant data, no timestamps and no
 * identifiers beyond the component name, because §33 says to minimize BEFORE
 * publishing and the easiest way to comply is to have nothing to minimize.
 */
export function proposeScenarioFrom(
  finding: DriftFinding,
  options: { candidateId: string; family?: string } = { candidateId: "cand_1" },
): ScenarioProposal {
  if (!finding.scenarioWorthy) {
    return {
      proposed: false,
      reason:
        `${finding.kind} on ${finding.componentId} is not worth a permanent scenario. ` +
        "It is a map or documentation correction, and a corpus full of those protects nothing while slowing every run.",
    };
  }

  const invariant = DRIFT_TO_INVARIANT[finding.kind];
  if (invariant === undefined) {
    return {
      proposed: false,
      reason: `${finding.kind} maps to no invariant, so a scenario built from it would assert nothing in particular.`,
    };
  }

  return {
    proposed: true,
    scenario: {
      candidateId: options.candidateId,
      title: `Regression: ${finding.kind} on ${finding.componentId}`,
      family: options.family ?? "DRIFT",
      components: [finding.componentId],
      // Deliberately abstract. No tenant, no ids, no times — nothing to
      // minimize because nothing sensitive was put in.
      setup: `${finding.componentId} configured as the architecture declares: ${finding.declared}.`,
      steps: [
        `Exercise ${finding.componentId} on its normal path.`,
        `Observe whether the declared property still holds: ${finding.declared}.`,
      ],
      mustPass: [`${finding.componentId} behaves as declared: ${finding.declared}`],
      mustFailTheEngineIf: `${finding.componentId} exhibits: ${finding.actual}`,
      faultClass: finding.kind,
      invariantsAtRisk: [invariant],
      severity: finding.severity,
      derivedFromFindingId: finding.findingId,
      status: "PROPOSED",
    },
  };
}

/**
 * Charter §9, restated for the drift detector.
 *
 * "Foundry may repair conditions Sentinel discovers... Sentinel shall not
 * become the architecture designer merely because it identified the problem."
 * The same holds one level down: finding drift does not confer authority to
 * resolve it by editing the architecture to match reality.
 *
 * Always false. The temptation is specific and strong — the fastest way to
 * clear a drift report is to update the declaration, and that converts every
 * finding into a rubber stamp.
 */
export function driftFindingAuthorizesArchitectureChange(_finding: DriftFinding): false {
  return false;
}
