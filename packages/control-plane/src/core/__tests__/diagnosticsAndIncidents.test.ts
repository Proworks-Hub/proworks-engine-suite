// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { blastRadius, explainFailure } from "../diagnostics.js";
import {
  advanceIncident,
  buildBriefing,
  incidentKeyFor,
  incidentSchema,
  openOrAttachIncident,
  runbookSchema,
  runbooksFor,
  type Incident,
} from "../incident.js";
import { deriveEngineHealth, type EngineHeartbeat } from "../health.js";
import type { Alert } from "../alerts.js";
import type { ObservedHeartbeat } from "../heartbeat.js";
import { SUITE_MANIFESTS, forgeIqManifest } from "../../manifests/index.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const beat = (over: Partial<EngineHeartbeat> = {}): ObservedHeartbeat => ({
  engineId: "forgeiq",
  version: "2.1.4",
  observedAt: ago(5_000),
  jobsProcessed: 1_000,
  jobsFailed: 0,
  openCircuits: [],
  maintenance: false,
  source: "reported",
  observedEvents: 0,
  ...over,
});

const healthFrom = (over: Partial<EngineHeartbeat> = {}) =>
  deriveEngineHealth("forgeiq", beat(over), { now: NOW });

const alert = (over: Partial<Alert> = {}): Alert => ({
  alertId: "forgeiq:engine.failed",
  kind: "engine.failed",
  severity: "critical",
  source: "forgeiq",
  reason: "13.3% of 45 jobs failed.",
  firstSeenAt: ago(120_000),
  openedAt: ago(60_000),
  lastSeenAt: ago(1_000),
  occurrences: 12,
  ...over,
});

describe("explaining a failure to somebody who has to fix it", () => {
  it("puts a broken dependency first", () => {
    // The commonest cause and the one most often missed while somebody restarts
    // the wrong engine.
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: healthFrom({ jobsFailed: 800 }),
      heartbeat: beat({ jobsFailed: 800 }),
      dependencies: [{ engineId: "visioniq", state: "failed" }],
    });

    expect(explanation.causes[0]?.summary).toContain("visioniq");
    expect(explanation.causes[0]?.confidence).toBe("likely");
    expect(explanation.causes[0]?.checks[0]).toContain("visioniq");
  });

  it("treats a recent deployment as correlation, not diagnosis", () => {
    // A deployment shortly before a fault is a strong hint. Calling it a
    // diagnosis pushes somebody to roll back a release that is not the cause.
    const withDependency = explainFailure({
      manifest: forgeIqManifest,
      health: healthFrom({ jobsFailed: 800 }),
      heartbeat: beat({ jobsFailed: 800 }),
      recentDeployment: { version: "2.1.4", atMsAgo: 10 * 60_000 },
      dependencies: [{ engineId: "visioniq", state: "failed" }],
    });
    const deploymentCause = withDependency.causes.find((cause) => cause.summary.includes("2.1.4"));
    expect(deploymentCause?.confidence).toBe("possible");
  });

  it("will not call a rate over three samples a rate", () => {
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: healthFrom({ jobsProcessed: 3, jobsFailed: 2 }),
      heartbeat: beat({ jobsProcessed: 3, jobsFailed: 2 }),
    });
    const rateCause = explanation.causes.find((cause) => cause.summary.includes("failing"));
    expect(rateCause?.confidence).toBe("speculative");
  });

  it("says it does not know rather than inventing causes", () => {
    // Three plausible causes for somebody to eliminate at 2am is worse than an
    // honest blank.
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: healthFrom(),
      heartbeat: beat(),
    });
    expect(explanation.inconclusive).toBe(true);
    expect(explanation.causes).toEqual([]);
  });

  it("distinguishes unknown from down", () => {
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: deriveEngineHealth("forgeiq", undefined, { now: NOW }),
    });
    expect(explanation.impact).toContain("not the same as");
  });

  it("flags derived silence as ambiguous", () => {
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: deriveEngineHealth("forgeiq", undefined, { now: NOW }),
      heartbeat: beat({ observedAt: ago(600_000) }) && { ...beat({ observedAt: ago(600_000) }), source: "derived" },
    });
    expect(explanation.causes[0]?.summary).toContain("idle rather than broken");
  });

  it("explains an open circuit without suggesting somebody force it", () => {
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: healthFrom({ openCircuits: ["postgres"] }),
      heartbeat: beat({ openCircuits: ["postgres"] }),
    });
    const circuit = explanation.causes.find((cause) => cause.summary.includes("circuit"))!;
    expect(circuit.checks.join(" ")).toContain("does not fix the cause");
  });

  it("always carries the raw detail", () => {
    // This explains the diagnostics; it does not replace them.
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: healthFrom({ jobsFailed: 800 }),
      heartbeat: beat({ jobsFailed: 800 }),
    });
    expect(explanation.rawDetail).toContain("jobsFailed");
  });

  it("gives every cause its evidence", () => {
    const explanation = explainFailure({
      manifest: forgeIqManifest,
      health: healthFrom({ jobsFailed: 800, openCircuits: ["db"] }),
      heartbeat: beat({ jobsFailed: 800, openCircuits: ["db"] }),
      dependencies: [{ engineId: "visioniq", state: "degraded" }],
    });
    for (const cause of explanation.causes) {
      expect(cause.evidence.length, cause.summary).toBeGreaterThan(0);
    }
  });
});

describe("what else a change can affect", () => {
  it("follows the graph past the first hop", () => {
    // The second hop is the one people forget, and usually where the
    // customer-visible damage happens.
    const radius = blastRadius("order-ingestion", SUITE_MANIFESTS);
    expect(radius.directConsumers).toContain("prime");
    expect(radius.indirectConsumers.length).toBeGreaterThan(0);
  });

  it("names the events that carry the effect", () => {
    const radius = blastRadius("forgeiq", SUITE_MANIFESTS);
    expect(radius.via).toContain("manufacturing.plan.generated");
  });

  it("terminates on a cycle", () => {
    // ForgeIQ and CostIQ reference each other through the mappings.
    expect(() => blastRadius("costiq", SUITE_MANIFESTS)).not.toThrow();
  });

  it("reports nothing for an engine nothing consumes", () => {
    const radius = blastRadius("nonexistent", SUITE_MANIFESTS);
    expect(radius.directConsumers).toEqual([]);
  });
});

describe("incidents deduplicate", () => {
  const options = { now: NOW, idFor: () => "inc-1" };

  it("keys on the fault, not the message", () => {
    // The message carries changing numbers, so keying on it would open a new
    // incident every few seconds for one continuous fault.
    const a = incidentKeyFor(alert({ reason: "13.3% of 45 jobs failed." }));
    const b = incidentKeyFor(alert({ reason: "26.1% of 92 jobs failed." }));
    expect(a).toBe(b);
  });

  it("opens one incident and then attaches to it", () => {
    const first = openOrAttachIncident(alert(), [], options);
    expect(first.created).toBe(true);

    const second = openOrAttachIncident(alert({ reason: "worse now" }), [first.incident], options);
    expect(second.created).toBe(false);
    expect(second.incident.id).toBe(first.incident.id);
    expect(second.incident.timeline).toHaveLength(2);
  });

  it("opens a new incident once the old one is resolved", () => {
    const resolved: Incident = { ...openOrAttachIncident(alert(), [], options).incident, state: "resolved" };
    expect(openOrAttachIncident(alert(), [resolved], options).created).toBe(true);
  });

  it("escalates severity but never quietly lowers it", () => {
    // A fault that briefly looks better is not a fault that got less serious.
    const low = openOrAttachIncident(alert({ severity: "warning" }), [], options).incident;
    const raised = openOrAttachIncident(alert({ severity: "critical" }), [low], options).incident;
    expect(raised.severity).toBe("high");

    const lowered = openOrAttachIncident(alert({ severity: "warning" }), [raised], options).incident;
    expect(lowered.severity).toBe("high");
  });
});

describe("an incident cannot be closed without saying what it was", () => {
  const open = openOrAttachIncident(alert(), [], { now: NOW, idFor: () => "inc-1" }).incident;

  it("refuses investigating straight to resolved", () => {
    const result = advanceIncident(open, "resolved", "steven", "seems fine now", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Record what it was first");
  });

  it("refuses to resolve without a root cause", () => {
    const monitoring = { ...open, state: "monitoring" as const };
    const result = advanceIncident(monitoring, "resolved", "steven", "looks good", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("root cause");
  });

  it("resolves once the cause is recorded", () => {
    const ready = { ...open, state: "monitoring" as const, rootCause: "A bad migration on 2.1.4." };
    const result = advanceIncident(ready, "resolved", "steven", "rolled back and verified", NOW);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.incident.resolvedAt).toBeTruthy();
  });

  it("refuses to edit a resolved incident", () => {
    const resolved = { ...open, state: "resolved" as const };
    expect(advanceIncident(resolved, "investigating", "steven", "reopening", NOW).ok).toBe(false);
  });
});

describe("runbooks", () => {
  const specific = runbookSchema.parse({
    id: "rb-1", name: "ForgeIQ plan failures", engineId: "forgeiq",
    triggerConditions: ["engine.failed"], updatedAt: ago(0),
  });
  const general = runbookSchema.parse({
    id: "rb-2", name: "Any engine failing", triggerConditions: ["engine.failed"], updatedAt: ago(0),
  });
  const unrelated = runbookSchema.parse({
    id: "rb-3", name: "Queue backlog", triggerConditions: ["engine.queue.backlog"], updatedAt: ago(0),
  });

  it("prefers the runbook written for this engine", () => {
    // Somebody wrote the specific one after living through it.
    const found = runbooksFor(alert(), [general, specific, unrelated]);
    expect(found.map((runbook) => runbook.id)).toEqual(["rb-1", "rb-2"]);
  });

  it("returns nothing rather than something irrelevant", () => {
    expect(runbooksFor(alert({ kind: "engine.latency", source: "costiq" }), [specific, unrelated])).toEqual([]);
  });
});

describe("the briefing counts what is recorded", () => {
  it("says it has nothing rather than reassuring", () => {
    // "All systems performing well" built from an absence of data is a
    // reassurance nobody earned.
    const briefing = buildBriefing({ since: ago(86_400_000), incidents: [], alerts: [], now: NOW });
    expect(briefing.noData).toBe(true);
    expect(briefing.lines[0]?.text).toContain("not that nothing happened");
  });

  it("distinguishes quiet from unrecorded", () => {
    const briefing = buildBriefing({
      since: ago(86_400_000),
      incidents: [{ ...openOrAttachIncident(alert(), [], { now: NOW - 200_000_000, idFor: () => "old" }).incident, state: "resolved", openedAt: ago(200_000_000) }],
      alerts: [],
      now: NOW,
    });
    expect(briefing.noData).toBe(false);
    expect(briefing.lines[0]?.text).toContain("No incidents opened");
  });

  it("names unowned incidents", () => {
    // "1 unresolved incident" with no owner is how something sits unclaimed
    // for a week.
    const open = openOrAttachIncident(alert(), [], { now: NOW - 3_600_000, idFor: () => "inc-1" }).incident;
    const briefing = buildBriefing({ since: ago(86_400_000), incidents: [open], alerts: [alert()], now: NOW });
    expect(briefing.lines.some((line) => line.text.includes("nobody assigned"))).toBe(true);
  });

  it("reports deployments in the window", () => {
    const briefing = buildBriefing({
      since: ago(86_400_000),
      incidents: [],
      alerts: [],
      deployments: [{ engineId: "forgeiq", version: "2.1.5", at: ago(3_600_000) }],
      now: NOW,
    });
    expect(briefing.lines.some((line) => line.text.includes("2.1.5"))).toBe(true);
  });
});

describe("incident records refuse invented impact", () => {
  it("has no field that estimates customer impact", () => {
    // A guessed number reads as a measured one the moment it leaves the screen.
    const parsed = incidentSchema.safeParse({
      id: "i", dedupeKey: "k", title: "t", severity: "high", state: "investigating",
      engineIds: ["forgeiq"], openedAt: ago(0), estimatedCustomersAffected: 300,
    });
    expect(parsed.success).toBe(false);
  });
});
