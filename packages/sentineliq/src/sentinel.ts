// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { HealthState } from "@proworks-hub/contracts";

import {
  dispositionRecordSchema,
  findingSchema,
  type Disposition,
  type DispositionRecord,
  type Finding,
  type FindingKind,
  type RecordedFinding,
  type Severity,
} from "./finding.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel IQ: constitutional overwatch.
//
// Charter §18 — the doctrine, and the sentence this whole package is arranged
// around: "Sentinel protects without ruling."
//
// WHY THIS DOES NOT TAKE A `Governance`
//
// Every Core in this repo requires Governance and cannot be constructed without
// it. Sentinel deliberately does not, and the reason is constitutional rather
// than convenient.
//
// Charter §8: "Governance determines authorization. Sentinel verifies actual
// behavior. A Governance-approved action may still be temporarily restricted
// when Sentinel detects active compromise." Oversight that must ask permission
// from the system it oversees is not oversight — and §15 requires that "loss of
// one technical component should not automatically eliminate all constitutional
// oversight." A Sentinel that cannot observe while Governance is down or
// compromised is exactly the failure §15 names.
//
// What bounds Sentinel instead is everything below: every restriction expires,
// every finding is permanent and challengeable, emergency authority decays on a
// clock, and there is no method here that writes policy. §17 — "Sentinel does
// not become sovereign by protecting the Hive."
//
// WHAT IS DELIBERATELY ABSENT
//
//   no suppress / dismiss / delete   §17: findings cannot be silently suppressed
//   no policy write of any kind      §8: shall not permanently rewrite Governance policy
//   no repair, no redesign           §9: Foundry repairs; Sentinel validates the repair
//   no domain type anywhere          §4: does not own business-domain truth
//   no permanent restriction         §8: temporarily restricted
// ─────────────────────────────────────────────────────────────────────────────

export interface FindingQuery {
  kind?: FindingKind;
  severity?: Severity;
  disposition?: Disposition;
  subjectId?: string;
  tenant?: string;
  /** Findings at or above a severity. For "show me what actually matters". */
  atLeastSeverity?: Severity;
  limit?: number;
}

const SEVERITY_ORDER: readonly Severity[] = [
  "informational",
  "low",
  "moderate",
  "high",
  "catastrophic",
];

export interface SentinelIq {
  /**
   * Records a finding.
   *
   * Refuses rather than throws, for the same reason AuditIQ does: an observer
   * whose write throws gets wrapped in a try/catch, and a silently unrecorded
   * finding is the failure this engine exists to prevent.
   */
  observe(input: unknown): { recorded: true; finding: RecordedFinding } | { recorded: false; reason: string };

  /**
   * Moves a finding to a new disposition.
   *
   * Not `suppress`. The finding stays queryable at every disposition including
   * `resolved_false_positive` — being wrong in public is the point. Every
   * disposition needs a named person and a reason, and the history only grows.
   */
  disposition(
    findingId: string,
    record: unknown,
  ): { applied: true; finding: RecordedFinding } | { applied: false; reason: string };

  find(query?: FindingQuery): readonly RecordedFinding[];

  /**
   * What Sentinel would say about itself.
   *
   * Common Overwatch Protections, Constitutional Heartbeat: Sentinel "shall
   * expose sufficient trusted health information for the Hive to determine
   * whether each is Healthy, Degraded, Recovering, Unavailable, or Isolated",
   * and §17 requires Sentinel "remain independently observable and auditable".
   * An overwatch system that cannot be watched has exempted itself.
   */
  health(): { state: HealthState; detail: string; openFindings: number; unresolvedCatastrophic: number };

  count(): number;
}

export interface SentinelIqOptions {
  now?: () => Date;
  /**
   * Called for every finding at the moment it is recorded.
   *
   * The anti-suppression seam. A finding that only exists inside this store can
   * be lost with the process; §17 says findings cannot be silently suppressed,
   * and a sink that never sees them makes suppression indistinguishable from
   * nothing having happened. Wire it to AuditIQ in a real installation.
   */
  onFinding?: (finding: RecordedFinding) => void;
  /** Called when a finding is refused. Malformed observations are themselves a signal. */
  onRejected?: (reason: string, input: unknown) => void;
  /**
   * Why this Sentinel would report itself as less than healthy.
   *
   * Injected because Sentinel cannot honestly assess its own reachability from
   * inside itself — a process that has lost the network still believes it is
   * fine. Absent means the host has not said, which is reported as `unknown`
   * rather than as `healthy`.
   */
  selfAssessment?: () => { state: HealthState; detail: string } | null;
}

function atLeast(actual: Severity, required: Severity): boolean {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(required);
}

export function createSentinelIq(options: SentinelIqOptions = {}): SentinelIq {
  const now = options.now ?? (() => new Date());

  // Private and append-mostly: findings are only ever added, and their
  // disposition history only ever grows. Nothing removes an entry.
  const entries: { finding: Finding; sequence: number; disposition: Disposition; history: DispositionRecord[] }[] =
    [];

  const snapshot = (entry: (typeof entries)[number]): RecordedFinding =>
    Object.freeze({
      finding: entry.finding,
      sequence: entry.sequence,
      disposition: entry.disposition,
      history: Object.freeze([...entry.history]),
    });

  return {
    observe(input) {
      const parsed = findingSchema.safeParse(input);
      if (!parsed.success) {
        const reason = `Not a well-formed finding: ${JSON.stringify(parsed.error.flatten())}`;
        options.onRejected?.(reason, input);
        return { recorded: false, reason };
      }

      if (entries.some((e) => e.finding.findingId === parsed.data.findingId)) {
        const reason = `A finding with id "${parsed.data.findingId}" already exists. Re-observing under the same id would overwrite the original record.`;
        options.onRejected?.(reason, input);
        return { recorded: false, reason };
      }

      const entry = {
        finding: parsed.data,
        sequence: entries.length,
        disposition: "open" as Disposition,
        history: [] as DispositionRecord[],
      };
      entries.push(entry);

      const recorded = snapshot(entry);
      options.onFinding?.(recorded);
      return { recorded: true, finding: recorded };
    },

    disposition(findingId, record) {
      const entry = entries.find((e) => e.finding.findingId === findingId);
      if (!entry) {
        return { applied: false, reason: `No finding "${findingId}". Nothing was changed.` };
      }

      const parsed = dispositionRecordSchema.safeParse(record);
      if (!parsed.success) {
        return {
          applied: false,
          reason: `Not a valid disposition: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }

      // The finding does not move backwards to `open` once dispositioned. A
      // reopened investigation is a new finding correlated with this one —
      // rewinding the state would erase that somebody had already judged it.
      if (parsed.data.disposition === "open") {
        return {
          applied: false,
          reason:
            "A finding cannot be returned to `open`. Raise a new finding correlated with this one, so the earlier judgement stays visible.",
        };
      }

      entry.disposition = parsed.data.disposition;
      entry.history.push(parsed.data);
      return { applied: true, finding: snapshot(entry) };
    },

    find(query = {}) {
      const matches = entries.filter((e) => {
        const f = e.finding;
        if (query.kind && f.kind !== query.kind) return false;
        if (query.severity && f.severity !== query.severity) return false;
        if (query.atLeastSeverity && !atLeast(f.severity, query.atLeastSeverity)) return false;
        if (query.disposition && e.disposition !== query.disposition) return false;
        if (query.subjectId && f.subject.id !== query.subjectId) return false;
        if (query.tenant && f.subject.tenant?.organizationId !== query.tenant) return false;
        return true;
      });

      const limited = query.limit === undefined ? matches : matches.slice(0, query.limit);
      return limited.map(snapshot);
    },

    health() {
      const open = entries.filter((e) => e.disposition === "open" || e.disposition === "acknowledged");
      const unresolvedCatastrophic = open.filter((e) => e.finding.severity === "catastrophic").length;

      const assessment = options.selfAssessment?.() ?? null;
      if (assessment) {
        return { ...assessment, openFindings: open.length, unresolvedCatastrophic };
      }

      // No host assessment means Sentinel does not know its own reachability.
      // `unknown`, never `healthy` — the whole point of the five-state
      // vocabulary is that an unanswered heartbeat is not a healthy one.
      return {
        state: "unknown" as HealthState,
        detail:
          "No host self-assessment was supplied, so Sentinel cannot claim to be healthy. An unreported state is unknown, never healthy.",
        openFindings: open.length,
        unresolvedCatastrophic,
      };
    },

    count: () => entries.length,
  };
}

/**
 * Charter §17: "Sentinel does not become sovereign by protecting the Hive," and
 * the Overwatch No-Authority-Accumulation principle: failure of another
 * constitutional system "shall not permit a surviving system to permanently
 * absorb the missing system's powers."
 *
 * Always false. It exists so that a caller reasoning about a degraded
 * Governance finds a function that says no, instead of an absence they read as
 * yes. The same shape as `healthGrantsAuthority()` in Foundation, for the same
 * reason: the dangerous inference is the one nobody wrote down.
 */
export function absorbsAuthorityFrom(_unavailableSystem: string): false {
  return false;
}
