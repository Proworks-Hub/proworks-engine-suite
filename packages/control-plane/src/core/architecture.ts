// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ── Deliberately no import from @proworks-hub/hive-runtime ──────────────────
//
// `tests/portability.test.ts` allows a suite package to import `contracts` and
// nothing else, and that rule is right: every dependency between packages is
// one an engine cannot be deployed without. So the console describes the SHAPE
// of the report it reads, structurally.
//
// This is not a duplicate source of truth. The console is not redefining what
// a conformance finding IS -- it is stating the minimum it needs in order to
// render one, which is a smaller claim. If the standard adds a field, nothing
// here has to change; if it removes one this file reads, the compile breaks
// where the report is loaded, which is where the mismatch actually lives.

export type ConformanceStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";

/** The minimum a finding must carry for the console to render it. */
export interface ReadableFinding {
  readonly ruleId: string;
  readonly subjectId: string;
  readonly status: ConformanceStatus;
  readonly waiverAdrId?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Control Center's view of architecture conformance.
//
// A READ MODEL over findings somebody else produced. This file imports the
// Architecture Engine nowhere, and that is not an oversight — ARCH-DEP-ENGINE-
// ISOLATION would fail the build if it did, and the rule is right: the console
// displays evidence and does not generate it. A console that ran the evaluator
// would make architecture conformance depend on the console being up, which
// inverts which of the two is infrastructure.
//
// So findings arrive as data, from CI or a report file, and this turns them
// into something a person can act on. The one thing it must never do is make
// the picture look better than the findings do.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the console shows for one subject.
 *
 * `unevaluated` is carried separately from `passing` and from `failing`, all
 * the way to the screen. Folding UNKNOWN into either produces a number that
 * cannot be acted on: into passing and the console certifies what nobody
 * checked, into failing and it cries wolf about work nobody has done yet.
 */
export interface ArchitectureSubjectView {
  readonly subjectId: string;
  readonly passing: number;
  readonly failing: number;
  readonly warning: number;
  /** Rules that apply and could not be evaluated. Never counted as healthy. */
  readonly unevaluated: number;
  /** Rules out of scope by a recorded decision. */
  readonly outOfScope: number;
  readonly blockingFailures: readonly string[];
  /**
   * Failures knowingly accepted by a named ADR.
   *
   * Shown rather than hidden. A waiver is a decision somebody made and can be
   * revisited; a suppression is a decision nobody can find.
   */
  readonly waived: readonly string[];
  readonly state: ArchitectureState;
}

/**
 * How a subject reads at a glance.
 *
 * `unevaluated` sits between `attention` and `conformant` deliberately: not
 * knowing is worse than passing and better than failing, and it must not
 * render as either. This mirrors `ENGINE_STATES.unknown`, which already
 * carries `demandsAttention: true` for the same reason.
 */
export type ArchitectureState = "conformant" | "unevaluated" | "attention" | "out-of-scope";

export const ARCHITECTURE_STATES: Readonly<
  Record<ArchitectureState, { readonly label: string; readonly severity: number; readonly demandsAttention: boolean }>
> = Object.freeze({
  conformant: { label: "Conformant", severity: 0, demandsAttention: false },
  "out-of-scope": { label: "Not yet adopted", severity: 1, demandsAttention: false },
  unevaluated: { label: "Not evaluated", severity: 2, demandsAttention: true },
  attention: { label: "Violations", severity: 3, demandsAttention: true },
});

export interface ArchitectureOverview {
  readonly subjects: readonly ArchitectureSubjectView[];
  readonly totals: Readonly<Record<ConformanceStatus, number>>;
  /** Subjects with at least one blocking failure. */
  readonly failingSubjects: number;
  /** Subjects that have adopted the standard at all. */
  readonly adoptedSubjects: number;
  /**
   * Adoption progress as a fraction, or null when there is nothing to divide.
   *
   * Null rather than 0 or 1 for an empty set: a progress bar reading 100% with
   * no subjects is a lie, and one reading 0% is a different lie.
   */
  readonly adoptionRatio: number | null;
}

function stateOf(view: Omit<ArchitectureSubjectView, "state">): ArchitectureState {
  if (view.blockingFailures.length > 0) return "attention";
  if (view.unevaluated > 0) return "unevaluated";
  if (view.passing === 0 && view.outOfScope > 0) return "out-of-scope";
  return "conformant";
}

/**
 * Builds the console view from a set of findings.
 *
 * Produces nothing when given nothing. An empty overview with `adoptionRatio:
 * null` says "no report has been loaded", which is different from "everything
 * passed", and the console must be able to tell a viewer which it is.
 */
export function summarizeArchitecture(
  findings: readonly ReadableFinding[],
): ArchitectureOverview {
  const bySubject = new Map<string, ReadableFinding[]>();
  for (const f of findings) {
    bySubject.set(f.subjectId, [...(bySubject.get(f.subjectId) ?? []), f]);
  }

  const totals: Record<ConformanceStatus, number> = {
    PASS: 0,
    WARN: 0,
    FAIL: 0,
    UNKNOWN: 0,
    NOT_APPLICABLE: 0,
  };
  for (const f of findings) totals[f.status] += 1;

  const subjects = [...bySubject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subjectId, own]) => {
      const partial = {
        subjectId,
        passing: own.filter((f) => f.status === "PASS").length,
        failing: own.filter((f) => f.status === "FAIL").length,
        warning: own.filter((f) => f.status === "WARN").length,
        unevaluated: own.filter((f) => f.status === "UNKNOWN").length,
        outOfScope: own.filter((f) => f.status === "NOT_APPLICABLE").length,
        blockingFailures: own
          .filter((f) => f.status === "FAIL" && !f.waiverAdrId)
          .map((f) => f.ruleId)
          .sort(),
        waived: own
          .filter((f) => f.status === "FAIL" && Boolean(f.waiverAdrId))
          .map((f) => `${f.ruleId} (${f.waiverAdrId})`)
          .sort(),
      };
      return { ...partial, state: stateOf(partial) };
    });

  const adoptedSubjects = subjects.filter((s) => s.state !== "out-of-scope").length;

  return {
    subjects,
    totals,
    failingSubjects: subjects.filter((s) => s.blockingFailures.length > 0).length,
    adoptedSubjects,
    adoptionRatio: subjects.length === 0 ? null : adoptedSubjects / subjects.length,
  };
}

/**
 * One line for the dashboard header.
 *
 * States the unevaluated count even when it is the only interesting number,
 * because a header that reads "42 conformant" while 20 rules went unevaluated
 * is the specific dishonesty this whole program exists to refuse.
 */
export function architectureHeadline(overview: ArchitectureOverview): string {
  if (overview.subjects.length === 0) return "No conformance report loaded.";
  const parts = [`${overview.adoptedSubjects} of ${overview.subjects.length} adopted`];
  if (overview.failingSubjects > 0) parts.push(`${overview.failingSubjects} with violations`);
  if (overview.totals.UNKNOWN > 0) parts.push(`${overview.totals.UNKNOWN} rules unevaluated`);
  return parts.join(" · ");
}
