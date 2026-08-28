// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { Alert } from "./alerts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Incidents, runbooks, and what happened while you were away.
//
// An incident is the record a small team actually needs: what broke, what was
// tried, what worked. Its value is almost entirely in being written down at the
// time — six months later nobody remembers which of four changes fixed it, and
// the next person hits the same fault with none of the knowledge.
//
// The rules that matter here are about NOT LYING:
//
//   Customer impact is stated only when it can be computed. "Approximately 300
//   customers affected" invented from an error rate is a number that ends up in
//   a status page and then in an apology.
//
//   Incidents deduplicate. One fault must not open an incident per telemetry
//   cycle, or the incident list becomes the thing nobody reads.
//
//   The briefing counts what is recorded, and says when it knows nothing.
// ─────────────────────────────────────────────────────────────────────────────

export const incidentStateSchema = z.enum([
  "investigating",
  "identified",
  "mitigating",
  "monitoring",
  "resolved",
]);
export type IncidentState = z.infer<typeof incidentStateSchema>;

export const incidentSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

export const incidentEntrySchema = z
  .object({
    at: z.string().min(1),
    author: z.string().min(1),
    note: z.string().min(1),
    /** A state change, when this entry caused one. */
    movedTo: incidentStateSchema.optional(),
  })
  .strict();
export type IncidentEntry = z.infer<typeof incidentEntrySchema>;

export const incidentSchema = z
  .object({
    id: z.string().min(1),
    /** Stable across telemetry cycles, so the same fault is the same incident. */
    dedupeKey: z.string().min(1),
    title: z.string().min(1),
    severity: incidentSeveritySchema,
    state: incidentStateSchema,
    engineIds: z.array(z.string()).min(1),
    openedAt: z.string().min(1),
    /** Who is working on it. Absent means nobody has picked it up. */
    owner: z.string().optional(),
    resolvedAt: z.string().optional(),
    /**
     * What was actually wrong. Written at resolution, not guessed at the start.
     */
    rootCause: z.string().optional(),
    resolution: z.string().optional(),
    /** Correlation ids worth keeping. */
    traceIds: z.array(z.string()).default([]),
    /** Versions in production when this started. */
    versions: z.record(z.string(), z.string()).default({}),
    timeline: z.array(incidentEntrySchema).default([]),
    /**
     * Customer impact, ONLY when it can be computed from something real.
     *
     * Left absent rather than estimated. A guessed number reads as a measured
     * one the moment it leaves this screen.
     */
    measuredImpact: z.string().optional(),
  })
  .strict();
export type Incident = z.infer<typeof incidentSchema>;

/**
 * The key that decides whether two observations are the same incident.
 *
 * Engine plus kind, not engine plus message: the message carries changing
 * numbers ("13.3% of 45 jobs failed"), and keying on it would open a new
 * incident every few seconds for one continuous fault.
 */
export function incidentKeyFor(alert: Pick<Alert, "source" | "kind">): string {
  return `${alert.source}:${alert.kind}`;
}

export interface IncidentOpenResult {
  readonly incident: Incident;
  readonly created: boolean;
}

/**
 * Opens an incident for an alert, or attaches to the one already open.
 *
 * Returns `created: false` when it deduplicated, so a caller can avoid
 * notifying twice about one fault.
 */
export function openOrAttachIncident(
  alert: Alert,
  open: readonly Incident[],
  options: { now: number; idFor(): string; versions?: Record<string, string> },
): IncidentOpenResult {
  const key = incidentKeyFor(alert);
  const existing = open.find((incident) => incident.dedupeKey === key && incident.state !== "resolved");

  if (existing) {
    return {
      created: false,
      incident: {
        ...existing,
        // Severity can rise on an open incident but never falls on its own: a
        // fault that briefly looks better is not a fault that got less serious.
        severity: escalate(existing.severity, severityFor(alert)),
        timeline: [
          ...existing.timeline,
          {
            at: new Date(options.now).toISOString(),
            author: "system",
            note: `Still occurring: ${alert.reason}`,
          },
        ],
      },
    };
  }

  return {
    created: true,
    incident: incidentSchema.parse({
      id: options.idFor(),
      dedupeKey: key,
      title: `${alert.source}: ${alert.kind.replace(/\./g, " ")}`,
      severity: severityFor(alert),
      state: "investigating",
      engineIds: [alert.source],
      openedAt: new Date(options.now).toISOString(),
      versions: options.versions ?? {},
      timeline: [
        { at: new Date(options.now).toISOString(), author: "system", note: `Opened automatically: ${alert.reason}` },
      ],
    }),
  };
}

function severityFor(alert: Alert): IncidentSeverity {
  if (alert.severity === "critical") return "high";
  if (alert.severity === "warning") return "medium";
  return "low";
}

const SEVERITY_ORDER: IncidentSeverity[] = ["low", "medium", "high", "critical"];
function escalate(current: IncidentSeverity, candidate: IncidentSeverity): IncidentSeverity {
  return SEVERITY_ORDER.indexOf(candidate) > SEVERITY_ORDER.indexOf(current) ? candidate : current;
}

/**
 * Moves an incident along, refusing transitions that skip the evidence.
 *
 * An incident cannot go straight from investigating to resolved. Something
 * closed without ever being identified or monitored is either not understood or
 * not actually fixed, and both are worth a moment's friction — this is the
 * record the next person will trust.
 */
export function advanceIncident(
  incident: Incident,
  to: IncidentState,
  by: string,
  note: string,
  now: number,
): { ok: true; incident: Incident } | { ok: false; reason: string } {
  if (incident.state === "resolved") {
    return { ok: false, reason: "This incident is already resolved. Reopen it rather than editing the state." };
  }

  if (to === "resolved" && incident.state === "investigating") {
    return {
      ok: false,
      reason:
        "An incident cannot go from investigating straight to resolved. Record what it was first — the next person reading this needs to know.",
    };
  }

  if (to === "resolved" && !incident.rootCause) {
    return { ok: false, reason: "Record a root cause before resolving. An incident with no cause teaches nobody anything." };
  }

  return {
    ok: true,
    incident: {
      ...incident,
      state: to,
      ...(to === "resolved" ? { resolvedAt: new Date(now).toISOString() } : {}),
      timeline: [...incident.timeline, { at: new Date(now).toISOString(), author: by, note, movedTo: to }],
    },
  };
}

// ── Runbooks ─────────────────────────────────────────────────────────────────

export const runbookSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    engineId: z.string().optional(),
    /** Conditions that should surface this runbook. */
    triggerConditions: z.array(z.string()).default([]),
    symptoms: z.array(z.string()).default([]),
    /** Non-destructive things to look at, in order. */
    checks: z.array(z.string()).default([]),
    /** Actions safe to take without further authorization. */
    safeActions: z.array(z.string()).default([]),
    escalation: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([]),
    relatedIncidents: z.array(z.string()).default([]),
    version: z.number().int().positive().default(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type Runbook = z.infer<typeof runbookSchema>;

/**
 * Finds runbooks worth showing for an alert.
 *
 * Matches on engine and trigger, and returns them ordered by how specific they
 * are: a runbook written for this engine and this condition beats a general one
 * about the same condition, because somebody wrote the specific one after
 * living through it.
 */
export function runbooksFor(
  alert: Pick<Alert, "source" | "kind">,
  runbooks: readonly Runbook[],
): Runbook[] {
  return runbooks
    .map((runbook) => {
      const engineMatch = runbook.engineId === alert.source;
      const triggerMatch = runbook.triggerConditions.includes(alert.kind);
      const score = (engineMatch ? 2 : 0) + (triggerMatch ? 1 : 0);
      return { runbook, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.runbook);
}

// ── Session briefing ─────────────────────────────────────────────────────────

export interface BriefingLine {
  readonly text: string;
  readonly tone: "neutral" | "attention";
}

export interface Briefing {
  readonly since: string;
  readonly lines: readonly BriefingLine[];
  /** True when there is genuinely nothing recorded, rather than nothing wrong. */
  readonly noData: boolean;
}

/**
 * What changed since an operator last looked.
 *
 * Built only from records that exist. A briefing that fabricates narrative
 * ("all systems performing well") from an absence of data is worse than one
 * that says it has nothing — the first is a reassurance nobody earned.
 */
export function buildBriefing(input: {
  since: string;
  incidents: readonly Incident[];
  alerts: readonly Alert[];
  deployments?: readonly { engineId: string; version: string; at: string }[];
  now: number;
}): Briefing {
  const sinceMs = Date.parse(input.since);
  const lines: BriefingLine[] = [];

  const opened = input.incidents.filter((incident) => Date.parse(incident.openedAt) >= sinceMs);
  const unresolved = input.incidents.filter((incident) => incident.state !== "resolved");
  const deployments = (input.deployments ?? []).filter((entry) => Date.parse(entry.at) >= sinceMs);
  const activeAlerts = input.alerts.filter((alert) => !alert.resolvedAt);

  if (opened.length > 0) {
    lines.push({ text: `${opened.length} incident${opened.length === 1 ? "" : "s"} opened.`, tone: "attention" });
  }

  if (unresolved.length > 0) {
    const critical = unresolved.filter((incident) => incident.severity === "critical" || incident.severity === "high");
    lines.push({
      text:
        critical.length > 0
          ? `${unresolved.length} incident${unresolved.length === 1 ? "" : "s"} still open, ${critical.length} of them high or critical.`
          : `${unresolved.length} incident${unresolved.length === 1 ? "" : "s"} still open.`,
      tone: "attention",
    });
    // Named, because "1 unresolved incident" with no owner is how something
    // sits unclaimed for a week.
    const unowned = unresolved.filter((incident) => !incident.owner);
    if (unowned.length > 0) {
      lines.push({ text: `${unowned.length} of them has nobody assigned.`, tone: "attention" });
    }
  }

  for (const deployment of deployments) {
    lines.push({ text: `${deployment.engineId} ${deployment.version} deployed.`, tone: "neutral" });
  }

  if (activeAlerts.length > 0) {
    lines.push({
      text: `${activeAlerts.length} alert${activeAlerts.length === 1 ? "" : "s"} currently open.`,
      tone: "attention",
    });
  }

  const noData =
    input.incidents.length === 0 && input.alerts.length === 0 && (input.deployments ?? []).length === 0;

  if (noData) {
    lines.push({
      text: "Nothing is recorded for this period. That means no records exist, not that nothing happened.",
      tone: "neutral",
    });
  } else if (lines.length === 0) {
    lines.push({ text: "No incidents opened, no alerts open, nothing deployed.", tone: "neutral" });
  }

  return { since: input.since, lines, noData };
}
