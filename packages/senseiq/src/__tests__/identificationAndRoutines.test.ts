// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { assignSpace, confirmIdentity, correctIdentity, suggestIdentity } from "../identification.js";
import { controlPolicySchema, type ControlPolicy } from "../command.js";
import { senseDeviceSchema, type SenseDevice } from "../models.js";
import { physicalSpaceSchema } from "../space.js";
import {
  MIN_OBSERVATIONS_TO_RECOMMEND,
  approveRoutine,
  declineRoutine,
  explainExecution,
  pauseRoutine,
  planExecution,
  recommendRoutine,
  routineSchema,
  type Routine,
} from "../routine.js";

const NOW = Date.parse("2026-08-28T07:30:00.000Z");
const at = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

const spaces = [
  physicalSpaceSchema.parse({ spaceId: "site", name: "Workshop", level: "site" }),
  physicalSpaceSchema.parse({ spaceId: "prod", name: "Production", level: "zone", parentId: "site" }),
  physicalSpaceSchema.parse({ spaceId: "uv", name: "UV station", level: "area", parentId: "prod" }),
  physicalSpaceSchema.parse({ spaceId: "cnc", name: "CNC bay", level: "area", parentId: "prod" }),
];

const equipment = [
  { equipmentId: "e1", name: "UV Printer 2", spaceId: "uv", aliases: ["uvprinter"] },
  { equipmentId: "e2", name: "Router Table", spaceId: "cnc" },
];

const device = (over: Partial<SenseDevice> = {}): SenseDevice =>
  senseDeviceSchema.parse({
    deviceId: "simulated:plug-1",
    adapterId: "simulated",
    providerRef: "plug-1",
    capabilities: ["power.switch", "energy.measure"],
    health: { availability: "online", detail: "Responding." },
    discoveredAt: at(),
    updatedAt: at(),
    ...over,
  });

describe("working out what a device is", () => {
  it("matches a device whose name mentions known equipment", () => {
    const suggestions = suggestIdentity({
      device: device({ identity: { identifiedAs: "UV Printer 2 energy plug" } }),
      equipment,
      spaces,
    });

    expect(suggestions[0]?.identifiedAs).toContain("UV Printer 2");
    expect(suggestions[0]?.suggestedSpaceId).toBe("uv");
    expect(suggestions[0]?.rule).toBe("name-matches-known-equipment");
  });

  it("never reaches certainty from a name alone", () => {
    // Two plugs both labelled "printer" is exactly the case this must not
    // resolve on its own.
    const suggestions = suggestIdentity({
      device: device({ identity: { identifiedAs: "UV Printer 2 monitor uvprinter" } }),
      equipment,
      spaces,
    });
    expect(suggestions[0]!.confidence.score).toBeLessThan(1);
    expect(suggestions[0]!.confidence.score).toBeLessThanOrEqual(0.85);
  });

  it("gives every suggestion its reasoning", () => {
    const suggestions = suggestIdentity({
      device: device({ identity: { identifiedAs: "UV Printer 2 plug" } }),
      equipment,
      spaces,
    });
    for (const suggestion of suggestions) {
      expect(suggestion.confidence.basis.length).toBeGreaterThan(0);
      expect(suggestion.rule.length).toBeGreaterThan(0);
    }
  });

  it("offers a weak guess when a space holds one machine", () => {
    const suggestions = suggestIdentity({ device: device(), equipment, spaces });
    const weak = suggestions.find((suggestion) => suggestion.rule === "sole-equipment-in-space");
    expect(weak).toBeDefined();
    expect(weak!.confidence.score).toBeLessThan(0.5);
  });

  it("returns candidates rather than one answer", () => {
    // Choosing between named machines is easy; being told the wrong one
    // confidently is how somebody stops trusting the list.
    expect(suggestIdentity({ device: device(), equipment, spaces }).length).toBeGreaterThan(1);
  });

  it("orders reproducibly", () => {
    const once = suggestIdentity({ device: device(), equipment, spaces });
    const twice = suggestIdentity({ device: device(), equipment: [...equipment].reverse(), spaces });
    expect(once.map((s) => s.rule)).toEqual(twice.map((s) => s.rule));
  });

  it("suggests nothing when there is no equipment to match", () => {
    expect(suggestIdentity({ device: device(), equipment: [], spaces })).toEqual([]);
  });
});

describe("a guess becomes a fact only when a person says so", () => {
  const suggestion = {
    deviceId: "simulated:plug-1",
    identifiedAs: "UV Printer 2 monitor",
    confidence: { score: 0.8, basis: ["name match"] },
    suggestedSpaceId: "uv",
    rule: "name-matches-known-equipment",
  };

  it("records who confirmed it", () => {
    // "Confirmed" with no name is indistinguishable from a system confirming
    // itself.
    const result = confirmIdentity(device(), suggestion, "steven", NOW);
    expect(result.ok).toBe(true);
    expect(result.device?.identity.confirmedBy).toBe("steven");
    expect(result.device?.spaceId).toBe("uv");
  });

  it("refuses a suggestion for a different device", () => {
    const result = confirmIdentity(device({ deviceId: "simulated:other" }), suggestion, "steven", NOW);
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("no_such_suggestion");
  });

  it("refuses to silently overwrite an existing confirmation", () => {
    const already = device({
      identity: { identifiedAs: "Router Table monitor", confirmedBy: "dana", confirmedAt: at(86_400_000) },
    });
    const result = confirmIdentity(already, suggestion, "steven", NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Correct it explicitly");
  });

  it("does not move a device somebody already placed", () => {
    const placed = device({ spaceId: "cnc" });
    expect(confirmIdentity(placed, suggestion, "steven", NOW).device?.spaceId).toBe("cnc");
  });

  it("lets a correction override placement, because that is what a correction is", () => {
    const wrong = device({
      spaceId: "cnc",
      identity: { identifiedAs: "Router Table monitor", confirmedBy: "dana" },
    });
    const fixed = correctIdentity(wrong, "UV Printer 2 monitor", "steven", NOW, "uv");
    expect(fixed.identity.identifiedAs).toBe("UV Printer 2 monitor");
    expect(fixed.spaceId).toBe("uv");
    expect(fixed.identity.confidence?.basis[0]).toContain("corrected by steven");
  });

  it("drops inferred placement confidence when a person assigns a space", () => {
    // Leaving a score beside a human decision would misrepresent it.
    const guessed = device({ spaceConfidence: { score: 0.4, basis: ["nearby devices"] } });
    expect(assignSpace(guessed, "uv", NOW).spaceConfidence).toBeUndefined();
  });
});

describe("learning a pattern grants no permission", () => {
  const routine = (over: Partial<Routine> = {}): Routine =>
    routineSchema.parse({
      routineId: "r-open-shop",
      name: "Open Shop",
      state: "observed",
      trigger: { kind: "schedule", atLocalTime: "07:30", weekdays: [1, 2, 3, 4, 5] },
      steps: [{ deviceId: "simulated:plug-1", capability: "power.switch", action: "on" }],
      evidence: ["lights on at ~07:30 on 8 of the last 10 weekdays"],
      observedCount: 8,
      createdAt: at(),
      ...over,
    });

  it("refuses to be active without a named approver", () => {
    // The rule the whole file exists for, enforced by the parser.
    expect(() => routine({ state: "active" })).toThrow();
    expect(() => routine({ state: "active", approvedBy: "steven" })).not.toThrow();
  });

  it("will not recommend on thin evidence", () => {
    // A system that suggests constantly is one whose suggestions get dismissed
    // unread, which costs the good ones too.
    const result = recommendRoutine(routine({ observedCount: 2 }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("too_few_observations");
    expect(result.reason).toContain(String(MIN_OBSERVATIONS_TO_RECOMMEND));
  });

  it("recommends once the pattern is real", () => {
    expect(recommendRoutine(routine()).routine?.state).toBe("recommended");
  });

  it("does not re-suggest something already declined", () => {
    const declined = declineRoutine(routine(), "steven");
    const result = recommendRoutine(declined);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("nagging");
  });

  it("clears approval when declined", () => {
    // A declined routine keeping an approver's name would read as authorized.
    const approved = approveRoutine(routine({ state: "recommended" }), "steven", NOW);
    expect(declineRoutine(approved, "steven").approvedBy).toBeUndefined();
  });

  it("keeps the approver's name on an active routine", () => {
    const approved = approveRoutine(routine({ state: "recommended" }), "steven", NOW);
    expect(approved.state).toBe("active");
    expect(approved.approvedBy).toBe("steven");
    expect(pauseRoutine(approved).approvedBy).toBe("steven");
  });
});

describe("running a routine", () => {
  const devices = new Map<string, SenseDevice>([
    ["simulated:plug-1", device()],
    ["simulated:plug-2", device({ deviceId: "simulated:plug-2", providerRef: "plug-2" })],
    [
      "simulated:laser",
      device({ deviceId: "simulated:laser", providerRef: "laser", capabilities: ["power.switch"] }),
    ],
  ]);

  const policy = (over: Partial<ControlPolicy> = {}): ControlPolicy =>
    controlPolicySchema.parse({
      safetyClass: "low", remoteControlAllowed: true, automationAllowed: true, ...over,
    });

  const active = routineSchema.parse({
    routineId: "r-open-shop",
    name: "Open Shop",
    state: "active",
    approvedBy: "steven",
    approvedAt: at(),
    trigger: { kind: "manual" },
    steps: [
      { deviceId: "simulated:plug-1", capability: "power.switch", action: "on" },
      { deviceId: "simulated:plug-2", capability: "power.switch", action: "on" },
    ],
    createdAt: at(),
  });

  it("refuses to run a routine nobody approved", () => {
    const observed = routineSchema.parse({ ...active, state: "observed", approvedBy: undefined, approvedAt: undefined });
    const plan = planExecution({
      routine: observed, devices, policies: new Map(), correlationId: "c1", now: NOW,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.reason).toContain("approved");
  });

  it("authorizes the steps it may take", () => {
    const policies = new Map([
      ["simulated:plug-1", policy()],
      ["simulated:plug-2", policy()],
    ]);
    const plan = planExecution({ routine: active, devices, policies, correlationId: "c1", now: NOW });
    expect(plan.intents).toHaveLength(2);
    expect(plan.refused).toHaveLength(0);
  });

  it("runs what it can and names what it could not", () => {
    // Four of five things on, with the fifth named, is far more useful than
    // refusing everything because one plug is offline.
    const policies = new Map([["simulated:plug-1", policy()]]);
    const plan = planExecution({ routine: active, devices, policies, correlationId: "c1", now: NOW });

    expect(plan.intents).toHaveLength(1);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.reason).toContain("No control policy");
    expect(plan.reason).toContain("1 refused");
  });

  it("treats a missing policy as refusal, not as permission", () => {
    const plan = planExecution({ routine: active, devices, policies: new Map(), correlationId: "c1", now: NOW });
    expect(plan.intents).toHaveLength(0);
    expect(plan.refused).toHaveLength(2);
  });

  it("will not let a routine start dangerous equipment", () => {
    const dangerous = routineSchema.parse({
      ...active,
      steps: [{ deviceId: "simulated:laser", capability: "power.switch", action: "on" }],
    });
    const policies = new Map([
      ["simulated:laser", controlPolicySchema.parse({ safetyClass: "high", remoteControlAllowed: false })],
    ]);
    const plan = planExecution({ routine: dangerous, devices, policies, correlationId: "c1", now: NOW });
    expect(plan.intents).toHaveLength(0);
    expect(plan.refused[0]?.reason).toContain("can injure");
  });

  it("respects a routine that requires a person each time", () => {
    const confirmed = routineSchema.parse({ ...active, requiresConfirmation: true });
    const policies = new Map([["simulated:plug-1", policy()], ["simulated:plug-2", policy()]]);

    expect(
      planExecution({ routine: confirmed, devices, policies, correlationId: "c1", now: NOW }).blocked,
    ).toBe(true);
    expect(
      planExecution({ routine: confirmed, devices, policies, correlationId: "c1", now: NOW, triggeredBy: "steven" }).intents,
    ).toHaveLength(2);
  });

  it("keys idempotency per run, so a retry is safe and two runs are distinct", () => {
    const policies = new Map([["simulated:plug-1", policy()], ["simulated:plug-2", policy()]]);
    const first = planExecution({ routine: active, devices, policies, correlationId: "run-1", now: NOW });
    const retry = planExecution({ routine: active, devices, policies, correlationId: "run-1", now: NOW + 5_000 });
    const second = planExecution({ routine: active, devices, policies, correlationId: "run-2", now: NOW + 60_000 });

    expect(retry.intents[0]!.idempotencyKey).toBe(first.intents[0]!.idempotencyKey);
    expect(second.intents[0]!.idempotencyKey).not.toBe(first.intents[0]!.idempotencyKey);
  });

  it("explains what it did and why", () => {
    // An automated action nobody can account for is indistinguishable from a
    // fault, and gets reported as one.
    const policies = new Map([["simulated:plug-1", policy()], ["simulated:plug-2", policy()]]);
    const plan = planExecution({ routine: active, devices, policies, correlationId: "c1", now: NOW });
    const explanation = explainExecution(active, plan.intents[0]!, "Production lights");

    expect(explanation).toContain("Production lights");
    expect(explanation).toContain("Open Shop ran");
  });

  it("names the person when they triggered it themselves", () => {
    const policies = new Map([["simulated:plug-1", policy()], ["simulated:plug-2", policy()]]);
    const plan = planExecution({
      routine: active, devices, policies, correlationId: "c1", now: NOW, triggeredBy: "steven",
    });
    expect(explainExecution(active, plan.intents[0]!, "Production lights")).toContain("steven ran Open Shop");
  });
});
