/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — integration test helpers
 *
 * Shared fixtures + factories for the Phase 1 cross-module integration
 * harness (`integration.test.ts`). Everything here is deterministic —
 * fixed clocks and sequential id generators — so the event stream each
 * scenario produces is byte-reproducible across runs.
 *
 * NOT a test file. Only imported by sibling `.test.ts` files.
 */

import {
  createInMemoryEventLog,
  createInMemoryStationRegistry,
  createInMemoryTemplateLibrary,
} from "../index.js";
import type {
  Clock,
  EventActor,
  EventLog,
  IdGenerator,
  IntakeInput,
  ProcessTemplate,
  Station,
  StationRegistry,
  StepSnapshot,
  TemplateLibrary,
} from "../index.js";

// ---------- Time ----------

export const FIXED_NOW: Date = new Date("2026-01-15T10:00:00.000Z");

/** Deterministic, non-advancing clock. Good default for event-stream assertions. */
export function fixedClock(at: Date = FIXED_NOW): Clock {
  return () => at;
}

// ---------- Ids ----------

/**
 * Produces `prefix-1`, `prefix-2`, ... Use separate generators for each
 * id domain (events, work orders, steps) so the output is easy to read
 * in a failing assertion.
 */
export function sequentialIdGenerator(prefix: string): IdGenerator {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// ---------- Actors ----------

export const OPERATOR: EventActor = {
  kind: "user",
  userId: "u-operator-1",
  role: "operator",
};

export const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

export const PRE_PRODUCTION: EventActor = {
  kind: "user",
  userId: "u-prepro-1",
  role: "pre_production",
};

export const SYSTEM: EventActor = {
  kind: "system",
  source: "integration_test",
};

// ---------- Station seed ----------

/**
 * Minimal shop floor covering the template below:
 *   - 1 laser station
 *   - 2 assembly stations (so change-order reroute has a target to move to)
 *   - 1 QC station
 *   - 1 pack/ship station
 *
 * All available, queueDepth 0, so routing is deterministic.
 */
export const STATIONS: ReadonlyArray<Station> = [
  {
    id: "station-laser-1",
    label: "Laser A",
    workstationClass: "laser",
    availableSkillTags: ["laser_operator"],
    status: "available",
    queueDepth: 0,
  },
  {
    id: "station-assembly-1",
    label: "Assembly Bench 1",
    workstationClass: "hand_assembly",
    availableSkillTags: ["assembly"],
    status: "available",
    queueDepth: 0,
  },
  {
    id: "station-assembly-2",
    label: "Assembly Bench 2",
    workstationClass: "hand_assembly",
    availableSkillTags: ["assembly"],
    status: "available",
    queueDepth: 0,
  },
  {
    id: "station-qc-1",
    label: "QC 1",
    workstationClass: "quality_check",
    availableSkillTags: ["inspection"],
    status: "available",
    queueDepth: 0,
  },
  {
    id: "station-pack-1",
    label: "Pack & Ship",
    workstationClass: "pack_ship",
    availableSkillTags: ["packing"],
    status: "available",
    queueDepth: 0,
  },
];

export function buildStationRegistry(
  stations: ReadonlyArray<Station> = STATIONS
): StationRegistry {
  return createInMemoryStationRegistry({ stations: [...stations] });
}

// ---------- Template seed ----------

/**
 * Single template covering the four canonical milestones:
 *   laser → hand_assembly → quality_check → pack_ship
 *
 * Durations sum to 100 minutes so ETA math is easy to reason about.
 */
export const BASIC_TEMPLATE: ProcessTemplate = {
  id: "tpl-basic-1",
  name: "Basic four-step template",
  kind: "template",
  steps: [
    {
      id: "step-laser",
      label: "Laser cut",
      workstationClass: "laser",
      requiredSkillTags: ["laser_operator"],
      estimatedDurationMinutes: 30,
      dependsOn: [],
      optional: false,
    },
    {
      id: "step-assembly",
      label: "Assemble",
      workstationClass: "hand_assembly",
      requiredSkillTags: ["assembly"],
      estimatedDurationMinutes: 45,
      dependsOn: ["step-laser"],
      optional: false,
    },
    {
      id: "step-qc",
      label: "Quality check",
      workstationClass: "quality_check",
      requiredSkillTags: ["inspection"],
      estimatedDurationMinutes: 15,
      dependsOn: ["step-assembly"],
      optional: false,
    },
    {
      id: "step-pack",
      label: "Pack & ship",
      workstationClass: "pack_ship",
      requiredSkillTags: ["packing"],
      estimatedDurationMinutes: 10,
      dependsOn: ["step-qc"],
      optional: false,
    },
  ],
};

export function buildTemplateLibrary(
  templates: ReadonlyArray<ProcessTemplate> = [BASIC_TEMPLATE]
): TemplateLibrary {
  return createInMemoryTemplateLibrary({
    templates: [...templates],
    // Deterministic matcher: every line item gets the basic template.
    matcher: (_lineItem, tpls) => tpls.get(BASIC_TEMPLATE.id) ?? null,
  });
}

// ---------- Intake input ----------

export function buildIntakeInput(
  overrides: Partial<IntakeInput> = {}
): IntakeInput {
  const base: IntakeInput = {
    customerId: "cust-001",
    customerName: "Acme Co",
    source: "manual",
    priority: "medium",
    dueDate: "2026-01-20",
    lineItems: [
      {
        id: "li-1",
        label: "Widget",
        quantity: 1,
      },
    ],
  };
  return { ...base, ...overrides };
}

// ---------- Step snapshot (initial/pending) ----------

/**
 * Construct a pending `StepSnapshot` for driving the Task Flow use case.
 * Inlined (vs. `buildInitialSnapshot` from taskFlowRules) so tests don't
 * need a second import path just to get a zero-state snapshot.
 */
export function pendingSnapshot(
  workOrderId: string,
  stepId: string,
  dependsOn: ReadonlyArray<string> = []
): StepSnapshot {
  return {
    stepId,
    workOrderId,
    state: "pending",
    dependsOn,
    accumulatedActiveMinutes: 0,
    pauseCount: 0,
    issueFlags: [],
    reworkEntries: [],
  };
}

// ---------- Environment bundle ----------

export interface IntegrationEnv {
  readonly eventLog: EventLog;
  readonly stationRegistry: StationRegistry;
  readonly templateLibrary: TemplateLibrary;
  readonly clock: Clock;
}

/**
 * One-stop setup for an integration scenario. Each scenario gets its own
 * fresh log / registry / library so events from one test don't leak into
 * the next.
 */
export function buildIntegrationEnv(): IntegrationEnv {
  const clock = fixedClock();
  return {
    eventLog: createInMemoryEventLog({
      clock,
      idGenerator: sequentialIdGenerator("evt"),
    }),
    stationRegistry: buildStationRegistry(),
    templateLibrary: buildTemplateLibrary(),
    clock,
  };
}
