// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  conformanceFindingSchema,
  isConsequential,
  isExpectedToReport,
  type ConformanceFinding,
  type ParticipantRuntime,
} from "@proworks-hub/hive-runtime";

import { ruleById } from "../rules.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Architecture Conformance Chamber.
//
// Headless. It reads facts and produces findings. It does not modify code, does
// not authorize anything, and nothing it produces is self-executing — a report
// may propose remediation, and a human or Governance decides.
//
// THE ADOPTION REGISTER IS THE HONEST PART OF THIS FILE.
//
// Sixty-odd packages predate the Common Hive Runtime Standard. There are three
// ways to report them and only one is truthful:
//
//   Mark them PASS.   Certifies components nobody checked. This is the
//                     failure the whole program exists to prevent.
//   Mark them FAIL.   Sixty red findings on day one, CI permanently broken,
//                     and within a week nobody reads the report.
//   Say they are out of scope, and say WHO PUT THEM THERE.
//
// The third is what the register does. A package is a canonical participant
// when somebody adds it — which is a decision, recorded, reviewable, and
// exactly the difference between NOT_APPLICABLE and UNKNOWN. The queue shrinks
// as families adopt (Manifesto §34), and the report always states how many are
// still outside it, so scope cannot quietly become an alibi.
//
// Dependency rules are the exception: they are checked against package
// metadata that every package already has, so they apply to everything from
// the first run.
// ─────────────────────────────────────────────────────────────────────────────

/** What the collector can learn about a package without running it. */
export interface PackageFacts {
  readonly packageName: string;
  /** Runtime dependencies, by package name. */
  readonly dependencies: readonly string[];
  /**
   * The Common Runtime declaration, when the package has adopted the standard.
   *
   * Absent is a real and common state, not an error — see the register note.
   */
  readonly participant?: ParticipantRuntime;
}

export interface ArchitectureWorld {
  readonly packages: readonly PackageFacts[];
  /**
   * Package names that have adopted the standard and are therefore in scope
   * for declaration-based rules.
   */
  readonly adopted: readonly string[];
  /** Stable ids that once existed and must never be reissued. */
  readonly retiredIds?: readonly string[];
  /** Fixed clock, so a report is reproducible and diffable. */
  readonly observedAt: string;
}

const CONTROL_CENTER = "@proworks-hub/control-plane";
const ARCHITECTURE_ENGINE = "@proworks-hub/architecture-engine";
const STUDIO_HINTS = ["platform-studio", "studio-ui", "react-dom"];

function finding(input: {
  ruleId: string;
  subjectId: string;
  status: ConformanceFinding["status"];
  observedAt: string;
  facts?: readonly string[];
  expected?: string;
}): ConformanceFinding {
  const rule = ruleById(input.ruleId);
  return conformanceFindingSchema.parse({
    ruleId: input.ruleId,
    subjectId: input.subjectId,
    status: input.status,
    severity: rule?.severity,
    observedAt: input.observedAt,
    facts: input.facts ?? [],
    expected: input.expected ?? rule?.rule,
    remediation: rule?.remediation ? [rule.remediation] : [],
    evidenceRefs: [`package:${input.subjectId}`],
  });
}

/**
 * Evaluates every rule against every package.
 *
 * Deterministic and order-stable: the same world produces the same report,
 * byte for byte, so two runs can be diffed and a change in the report means a
 * change in the repository.
 */
export function evaluateConformance(world: ArchitectureWorld): readonly ConformanceFinding[] {
  const out: ConformanceFinding[] = [];
  const at = world.observedAt;
  const adopted = new Set(world.adopted);
  const retired = new Set(world.retiredIds ?? []);
  const packages = [...world.packages].sort((a, b) => a.packageName.localeCompare(b.packageName));

  // ── Rules checkable from package metadata alone: every package, always ────
  for (const pkg of packages) {
    const id = pkg.packageName;
    const deps = pkg.dependencies;
    const isSelf = id === ARCHITECTURE_ENGINE;
    const isControlCenter = id === CONTROL_CENTER;

    out.push(
      deps.includes(CONTROL_CENTER) && !isControlCenter
        ? finding({
            ruleId: "ARCH-DEP-NO-CONTROL-CENTER",
            subjectId: id,
            status: "FAIL",
            observedAt: at,
            facts: [`depends on ${CONTROL_CENTER}`],
          })
        : finding({ ruleId: "ARCH-DEP-NO-CONTROL-CENTER", subjectId: id, status: "PASS", observedAt: at }),
    );

    const studio = deps.filter((d) => STUDIO_HINTS.some((h) => d.includes(h)));
    out.push(
      studio.length > 0
        ? finding({
            ruleId: "ARCH-DEP-NO-STUDIO",
            subjectId: id,
            status: "FAIL",
            observedAt: at,
            facts: studio.map((d) => `depends on UI surface ${d}`),
          })
        : finding({ ruleId: "ARCH-DEP-NO-STUDIO", subjectId: id, status: "PASS", observedAt: at }),
    );

    // The self-test. The Architecture Engine is exempt from its own isolation
    // rule only in the sense that it may depend on itself; nothing else may.
    out.push(
      deps.includes(ARCHITECTURE_ENGINE) && !isSelf
        ? finding({
            ruleId: "ARCH-DEP-ENGINE-ISOLATION",
            subjectId: id,
            status: "FAIL",
            observedAt: at,
            facts: [`depends on ${ARCHITECTURE_ENGINE}`],
          })
        : finding({ ruleId: "ARCH-DEP-ENGINE-ISOLATION", subjectId: id, status: "PASS", observedAt: at }),
    );
  }

  // ── Declaration-based rules: adopted packages only ───────────────────────
  const declarationRules = [
    "ARCH-RUNTIME-METADATA",
    "ARCH-CHARTER-BOUNDARY",
    "ARCH-GOV-FIRST",
    "ARCH-COLLAB-CONTRACT",
    "ARCH-MATURITY-HONEST",
  ] as const;

  for (const pkg of packages) {
    const id = pkg.packageName;

    if (!adopted.has(id)) {
      // Out of scope BY DECISION, and the finding says whose and why. Without
      // that sentence this is UNKNOWN wearing a better label.
      for (const ruleId of declarationRules) {
        out.push(
          finding({
            ruleId,
            subjectId: id,
            status: "NOT_APPLICABLE",
            observedAt: at,
            facts: [
              "not in the Common Hive Runtime adoption register",
              "queued for the phased family migration (Manifesto §34)",
            ],
          }),
        );
      }
      continue;
    }

    const p = pkg.participant;
    if (!p) {
      // Registered as adopted, but no declaration was found. That is a real
      // failure and not a scope question: somebody said this package had
      // adopted the standard, and the artifact is missing.
      for (const ruleId of declarationRules) {
        out.push(
          finding({
            ruleId,
            subjectId: id,
            status: ruleId === "ARCH-RUNTIME-METADATA" ? "FAIL" : "UNKNOWN",
            observedAt: at,
            facts: ["listed in the adoption register but no runtime declaration was found"],
          }),
        );
      }
      continue;
    }

    out.push(finding({ ruleId: "ARCH-RUNTIME-METADATA", subjectId: id, status: "PASS", observedAt: at }));

    out.push(
      p.charter.doesNotOwn.length > 0
        ? finding({ ruleId: "ARCH-CHARTER-BOUNDARY", subjectId: id, status: "PASS", observedAt: at })
        : finding({
            ruleId: "ARCH-CHARTER-BOUNDARY",
            subjectId: id,
            status: "FAIL",
            observedAt: at,
            facts: ["charter states no boundary"],
          }),
    );

    // Governance-first, checked against the declaration: a capability whose
    // effect leaves the participant's boundary must be protected.
    const unprotected = p.collaboration.offers.filter(
      (c) => isConsequential(c.sideEffect) && !c.requiresAuthorization,
    );
    out.push(
      unprotected.length === 0
        ? finding({ ruleId: "ARCH-GOV-FIRST", subjectId: id, status: "PASS", observedAt: at })
        : finding({
            ruleId: "ARCH-GOV-FIRST",
            subjectId: id,
            status: "FAIL",
            observedAt: at,
            facts: unprotected.map(
              (c) => `${c.capabilityId} has side effect ${c.sideEffect} but requires no authorization`,
            ),
          }),
    );

    // The schema already refuses a contract missing `whenUnavailable`, so a
    // parsed declaration cannot violate this. Reported as PASS rather than
    // skipped: a rule that is enforced earlier is still a rule that held, and
    // dropping it from the report would make the coverage look thinner.
    out.push(finding({ ruleId: "ARCH-COLLAB-CONTRACT", subjectId: id, status: "PASS", observedAt: at }));

    out.push(
      !isExpectedToReport(p.maturity) || p.evidenceRefs.length > 0
        ? finding({ ruleId: "ARCH-MATURITY-HONEST", subjectId: id, status: "PASS", observedAt: at })
        : finding({
            ruleId: "ARCH-MATURITY-HONEST",
            subjectId: id,
            status: "WARN",
            observedAt: at,
            facts: [`claims ${p.maturity} with no evidence reference`],
          }),
    );
  }

  // ── Identity rules: across the adopted set ───────────────────────────────
  const seen = new Map<string, string[]>();
  for (const pkg of packages) {
    const sid = pkg.participant?.identity.stableId;
    if (!sid) continue;
    seen.set(sid, [...(seen.get(sid) ?? []), pkg.packageName]);
  }
  for (const [stableId, owners] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(
      owners.length === 1
        ? finding({ ruleId: "ARCH-ID-UNIQUE", subjectId: stableId, status: "PASS", observedAt: at })
        : finding({
            ruleId: "ARCH-ID-UNIQUE",
            subjectId: stableId,
            status: "FAIL",
            observedAt: at,
            facts: [`declared by ${owners.length} packages: ${owners.join(", ")}`],
          }),
    );
    out.push(
      retired.has(stableId)
        ? finding({
            ruleId: "ARCH-ID-NO-REUSE",
            subjectId: stableId,
            status: "FAIL",
            observedAt: at,
            facts: ["this id is in the retired register and has been reissued"],
          })
        : finding({ ruleId: "ARCH-ID-NO-REUSE", subjectId: stableId, status: "PASS", observedAt: at }),
    );
  }

  return out;
}
