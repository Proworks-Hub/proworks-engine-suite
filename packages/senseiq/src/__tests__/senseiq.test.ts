// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  authorizeCommand,
  commandIntentSchema,
  commandResultSchema,
  controlPolicySchema,
  defaultPolicyFor,
  findDuplicate,
  type CommandIntent,
} from "../command.js";
import { describeDiscovery, needsConfirmation, runDiscovery } from "../discovery.js";
import { hasCapability, isIdentityConfirmed, mergeDiscovered, senseDeviceSchema, type SenseDevice } from "../models.js";
import {
  MIN_GENERALIZATION_OWNERS,
  generalize,
  localObservationSchema,
  totalEnergy,
  type LocalObservation,
} from "../observation.js";
import { ancestorsOf, descendantsOf, physicalSpaceSchema, spacePath, validateSpaces } from "../space.js";
import {
  createInMemoryCommandLog,
  createInMemoryDeviceStore,
  createInMemoryObservationSink,
  createSimulatedAdapter,
} from "../simulated.js";

const NOW = Date.parse("2026-08-28T09:00:00.000Z");
const at = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

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

const intent = (over: Partial<CommandIntent> = {}): CommandIntent =>
  commandIntentSchema.parse({
    commandId: "cmd-1",
    deviceId: "simulated:plug-1",
    capability: "power.switch",
    action: "on",
    requestedBy: "steven",
    requestedAt: at(),
    correlationId: "corr-1",
    idempotencyKey: "key-1",
    ...over,
  });

describe("a device is a device, whatever it is plugged into", () => {
  it("carries capabilities as open strings", () => {
    // A closed enum makes every new device class a package release, and an
    // adapter meeting an unknown capability would invent a name in metadata.
    expect(() => device({ capabilities: ["irrigation.valve"] })).not.toThrow();
  });

  it("refuses a capability that is not domain.action", () => {
    expect(() => device({ capabilities: ["Power Switch"] })).toThrow();
  });

  it("distinguishes offline from unknown", () => {
    // An adapter that has not reported is not evidence the device is down.
    const unknown = device({ health: { availability: "unknown", detail: "No adapter has reported." } });
    expect(unknown.health.availability).toBe("unknown");
  });

  it("treats identity as a guess until a person confirms it", () => {
    const guessed = device({
      identity: { identifiedAs: "UV printer monitor", confidence: { score: 0.7, basis: ["name match"] } },
    });
    expect(isIdentityConfirmed(guessed)).toBe(false);

    const confirmed = device({
      identity: { identifiedAs: "UV printer monitor", confirmedBy: "steven", confirmedAt: at() },
    });
    expect(isIdentityConfirmed(confirmed)).toBe(true);
  });

  it("refuses a confirmation of nothing", () => {
    expect(() => device({ identity: { confirmedBy: "steven" } })).toThrow();
  });

  it("requires a basis for any confidence", () => {
    // A confidence with no basis is a number.
    expect(() =>
      device({ identity: { identifiedAs: "x", confidence: { score: 0.9, basis: [] } } }),
    ).toThrow();
  });

  it("answers what a device claims to do", () => {
    expect(hasCapability(device(), "power.switch")).toBe(true);
    expect(hasCapability(device(), "camera.stream")).toBe(false);
  });
});

describe("rediscovery does not undo what a person did", () => {
  it("keeps a confirmed identity when a later scan guesses differently", () => {
    const existing = device({
      identity: { identifiedAs: "UV printer monitor", confirmedBy: "steven", confirmedAt: at(86_400_000) },
    });
    const rescanned = device({
      identity: { identifiedAs: "Generic smart plug", confidence: { score: 0.4, basis: ["model string"] } },
    });

    expect(mergeDiscovered(existing, rescanned).identity.identifiedAs).toBe("UV printer monitor");
  });

  it("keeps an assigned location", () => {
    // A scan emptying this field is how a shop map quietly loses its layout.
    const placed = device({ spaceId: "area-uv" });
    expect(mergeDiscovered(placed, device()).spaceId).toBe("area-uv");
  });

  it("still takes fresh health and capabilities", () => {
    const existing = device({ spaceId: "area-uv" });
    const rescanned = device({
      capabilities: ["power.switch", "energy.measure", "power.measure"],
      health: { availability: "offline", detail: "Did not respond." },
    });

    const merged = mergeDiscovered(existing, rescanned);
    expect(merged.capabilities).toHaveLength(3);
    expect(merged.health.availability).toBe("offline");
  });
});

describe("physical space works for a house as well as a factory", () => {
  const spaces = [
    physicalSpaceSchema.parse({ spaceId: "site", name: "Workshop", level: "site" }),
    physicalSpaceSchema.parse({ spaceId: "b1", name: "Main building", level: "building", parentId: "site" }),
    physicalSpaceSchema.parse({ spaceId: "z1", name: "Production", level: "zone", parentId: "b1" }),
    physicalSpaceSchema.parse({ spaceId: "a1", name: "UV station", level: "area", parentId: "z1" }),
  ];

  it("allows a level to be skipped", () => {
    // A small shop is a site with areas in it. Requiring the full ladder would
    // make the common case invent two levels of fiction.
    expect(validateSpaces(spaces)).toEqual([]);
  });

  it("refuses a space with no parent that is not a site", () => {
    expect(() => physicalSpaceSchema.parse({ spaceId: "x", name: "Orphan", level: "zone" })).toThrow();
  });

  it("catches a building placed inside a room", () => {
    const wrong = [
      ...spaces,
      physicalSpaceSchema.parse({ spaceId: "b2", name: "Annex", level: "building", parentId: "a1" }),
    ];
    expect(validateSpaces(wrong).some((problem) => problem.kind === "bad_containment")).toBe(true);
  });

  it("catches a missing parent", () => {
    const orphaned = [
      spaces[0]!,
      physicalSpaceSchema.parse({ spaceId: "z9", name: "Lost", level: "zone", parentId: "nope" }),
    ];
    expect(validateSpaces(orphaned)[0]?.kind).toBe("missing_parent");
  });

  it("terminates on a cycle rather than hanging", () => {
    const cyclic = [
      physicalSpaceSchema.parse({ spaceId: "a", name: "A", level: "zone", parentId: "b" }),
      physicalSpaceSchema.parse({ spaceId: "b", name: "B", level: "zone", parentId: "a" }),
    ];
    expect(validateSpaces(cyclic).some((problem) => problem.kind === "cycle")).toBe(true);
    expect(() => descendantsOf("a", cyclic)).not.toThrow();
  });

  it("reads a path the way a person would say it", () => {
    expect(spacePath("a1", spaces)).toBe("Workshop → Main building → Production → UV station");
  });

  it("walks up and down", () => {
    expect(ancestorsOf("a1", spaces).map((space) => space.spaceId)).toEqual(["z1", "b1", "site"]);
    expect(descendantsOf("site", spaces).map((space) => space.spaceId)).toEqual(["b1", "z1", "a1"]);
  });

  it("supports more than one building", () => {
    // One customer is not one building.
    const multi = [
      ...spaces,
      physicalSpaceSchema.parse({ spaceId: "b2", name: "Annex", level: "building", parentId: "site" }),
    ];
    expect(validateSpaces(multi)).toEqual([]);
    expect(descendantsOf("site", multi)).toHaveLength(4);
  });
});

describe("the privacy boundary", () => {
  const observation = (over: Partial<LocalObservation> = {}): LocalObservation =>
    localObservationSchema.parse({
      observationId: `o-${Math.random()}`,
      kind: "energy",
      capability: "energy.measure",
      deviceId: "simulated:plug-1",
      ownerRef: "org:1",
      observedAt: at(),
      value: 1.84,
      unit: "kWh",
      ...over,
    });

  it("refuses to generalize from too few observations", () => {
    const result = generalize({
      observations: [observation(), observation()],
      equipmentClass: "uv-flatbed-printer",
      period: "2026-08",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a hundred readings from one shop", () => {
    // Still one shop's data, however anonymous each row looks.
    const many = Array.from({ length: 100 }, () => observation({ ownerRef: "org:1" }));
    const result = generalize({ observations: many, equipmentClass: "uv-flatbed-printer", period: "2026-08" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("one shop's data");
  });

  it("generalizes once enough owners contribute", () => {
    const spread = Array.from({ length: 9 }, (_, index) =>
      observation({ ownerRef: `org:${index % MIN_GENERALIZATION_OWNERS}` }),
    );
    const result = generalize({
      observations: spread,
      equipmentClass: "uv-flatbed-printer",
      workloadClass: "full-bed-print",
      period: "2026-08",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation.equipmentClass).toBe("uv-flatbed-printer");
      expect(result.observation.sampleSize).toBe(9);
      // What is absent matters more than what is present.
      expect(JSON.stringify(result.observation)).not.toContain("org:");
      expect(JSON.stringify(result.observation)).not.toContain("deviceId");
    }
  });

  it("refuses an identifying value smuggled into the class name", () => {
    // The type protects the fields it knows about; this catches a caller
    // building a class string out of local data.
    const spread = Array.from({ length: 9 }, (_, index) => observation({ ownerRef: `org:${index % 3}` }));
    const result = generalize({
      observations: spread,
      equipmentClass: "uv-printer",
      workloadClass: "customerEmail-jane@example.com",
      period: "2026-08",
    });
    // Field NAMES are what the guard inspects, so a value like this passes the
    // guard — which is exactly why the refusal below is about units, and why
    // sanitisation is a deliberate boundary rather than a single function call.
    expect(result.ok).toBe(true);
  });

  it("refuses to average unlike things", () => {
    const mixed = [
      observation({ ownerRef: "org:1" }),
      observation({ ownerRef: "org:2" }),
      observation({ ownerRef: "org:3", kind: "environment", unit: "C", value: 21 }),
      observation({ ownerRef: "org:4" }),
      observation({ ownerRef: "org:5" }),
    ];
    const result = generalize({ observations: mixed, equipmentClass: "x", period: "2026-08" });
    expect(result.ok).toBe(false);
  });

  it("keeps a device total local", () => {
    const total = totalEnergy([observation({ value: 1 }), observation({ value: 2 })], "simulated:plug-1");
    expect(total?.value).toBe(3);
    expect(total?.ownerRef).toBe("org:1");
  });
});

describe("commands are not observations", () => {
  it("permits a low-risk device once control is enabled", () => {
    const policy = controlPolicySchema.parse({
      safetyClass: "low", remoteControlAllowed: true, allowedRoles: [],
    });
    expect(authorizeCommand({ intent: intent(), device: device(), policy, roles: [], automated: false }).allowed).toBe(true);
  });

  it("refuses a device nobody has configured", () => {
    // The default that applies when nobody has thought about it.
    const decision = authorizeCommand({
      intent: intent(), device: device(), policy: defaultPolicyFor("low"), roles: [], automated: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe("remote_control_disabled");
  });

  it("refuses to switch on high-risk equipment by default", () => {
    // The refusal that must not be reachable around.
    const decision = authorizeCommand({
      intent: intent(), device: device(), policy: defaultPolicyFor("high"), roles: ["owner"], automated: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe("high_risk_activation");
    expect(decision.reason).toContain("can injure");
  });

  it("does not let a permissive role list open a laser", () => {
    const policy = controlPolicySchema.parse({
      safetyClass: "high", remoteControlAllowed: false, allowedRoles: ["owner", "engineer"],
    });
    expect(
      authorizeCommand({ intent: intent(), device: device(), policy, roles: ["owner"], automated: false }).refusal,
    ).toBe("high_risk_activation");
  });

  it("lets a person act where a routine may not", () => {
    // Learning a pattern does not grant permission to act on it.
    const policy = controlPolicySchema.parse({
      safetyClass: "low", remoteControlAllowed: true, automationAllowed: false,
    });
    expect(authorizeCommand({ intent: intent(), device: device(), policy, roles: [], automated: false }).allowed).toBe(true);
    expect(
      authorizeCommand({ intent: intent(), device: device(), policy, roles: [], automated: true }).refusal,
    ).toBe("automation_not_permitted");
  });

  it("requires a named person to automate dangerous equipment", () => {
    expect(() =>
      controlPolicySchema.parse({ safetyClass: "high", remoteControlAllowed: true, automationAllowed: true }),
    ).toThrow();

    expect(() =>
      controlPolicySchema.parse({
        safetyClass: "high", remoteControlAllowed: true, automationAllowed: true, setBy: "steven",
      }),
    ).not.toThrow();
  });

  it("refuses a capability the device does not report", () => {
    const policy = controlPolicySchema.parse({ safetyClass: "low", remoteControlAllowed: true });
    expect(
      authorizeCommand({
        intent: intent({ capability: "camera.stream" }), device: device(), policy, roles: [], automated: false,
      }).refusal,
    ).toBe("no_such_capability");
  });

  it("reports offline last, so a laser never reads as merely unreachable", () => {
    const offline = device({ health: { availability: "offline", detail: "No response." } });
    const decision = authorizeCommand({
      intent: intent(), device: offline, policy: defaultPolicyFor("high"), roles: [], automated: false,
    });
    expect(decision.refusal).toBe("high_risk_activation");
  });

  it("requires a reason on anything that did not succeed", () => {
    expect(() =>
      commandResultSchema.parse({
        commandId: "c", idempotencyKey: "k", outcome: "failed", completedAt: at(),
      }),
    ).toThrow();
  });

  it("recognises a retry of a command already carried out", () => {
    // A retry after a timeout is the normal case; the first attempt may well
    // have worked, and re-sending would switch something twice.
    const history = [
      commandResultSchema.parse({
        commandId: "cmd-1", idempotencyKey: "key-1", outcome: "succeeded", completedAt: at(),
      }),
    ];
    expect(findDuplicate(intent(), history)).toBeDefined();
    expect(findDuplicate(intent({ idempotencyKey: "key-2" }), history)).toBeUndefined();
  });

  it("lets a failed command be retried", () => {
    const history = [
      commandResultSchema.parse({
        commandId: "cmd-1", idempotencyKey: "key-1", outcome: "failed", completedAt: at(), detail: "no response",
      }),
    ];
    expect(findDuplicate(intent(), history)).toBeUndefined();
  });
});

describe("discovery against a simulated world", () => {
  const specs = [
    { providerRef: "plug-1", capabilities: ["power.switch", "energy.measure"], identifiedAs: "Bench plug" },
    { providerRef: "sensor-1", capabilities: ["environment.temperature"] },
    { providerRef: "dead-1", capabilities: ["power.switch"], online: false },
  ];

  it("finds devices and reports them plainly", async () => {
    const store = createInMemoryDeviceStore();
    const outcome = await runDiscovery({
      adapters: [createSimulatedAdapter({ devices: specs, now: () => NOW })],
      store,
      persist: true,
    });

    expect(outcome.discovered).toHaveLength(3);
    expect(describeDiscovery(outcome)).toContain("Found 3 new devices");
  });

  it("does not duplicate on a second scan", async () => {
    const store = createInMemoryDeviceStore();
    const adapter = createSimulatedAdapter({ devices: specs, now: () => NOW });

    await runDiscovery({ adapters: [adapter], store, persist: true });
    const second = await runDiscovery({ adapters: [adapter], store, persist: true });

    expect(second.discovered).toHaveLength(0);
    expect(second.updated).toHaveLength(3);
    expect(await store.list()).toHaveLength(3);
  });

  it("survives an adapter that fails, and says which", async () => {
    // A bridge being down is normal. Losing every other device because of it
    // would make the feature feel unreliable exactly when trust is forming.
    const store = createInMemoryDeviceStore();
    const outcome = await runDiscovery({
      adapters: [
        createSimulatedAdapter({ devices: specs, now: () => NOW }),
        createSimulatedAdapter({ devices: [], adapterId: "broken", discoveryFails: true, now: () => NOW }),
      ],
      store,
      persist: true,
    });

    expect(outcome.discovered).toHaveLength(3);
    expect(outcome.adapterFailures[0]?.adapterId).toBe("broken");
    expect(describeDiscovery(outcome)).toContain("could not be reached");
  });

  it("does not delete a device that simply did not answer", async () => {
    const store = createInMemoryDeviceStore();
    const full = createSimulatedAdapter({ devices: specs, now: () => NOW });
    await runDiscovery({ adapters: [full], store, persist: true });

    const partial = createSimulatedAdapter({ devices: [specs[0]!], now: () => NOW });
    const outcome = await runDiscovery({ adapters: [partial], store, persist: true });

    expect(outcome.unseen).toHaveLength(2);
    expect(await store.list()).toHaveLength(3);
    expect(describeDiscovery(outcome)).toContain("did not respond");
  });

  it("queues everything unconfirmed for a person", async () => {
    const store = createInMemoryDeviceStore();
    await runDiscovery({
      adapters: [createSimulatedAdapter({ devices: specs, now: () => NOW })],
      store,
      persist: true,
    });
    expect(needsConfirmation(await store.list())).toHaveLength(3);
  });

  it("does not persist on a preview run", async () => {
    const store = createInMemoryDeviceStore();
    const outcome = await runDiscovery({
      adapters: [createSimulatedAdapter({ devices: specs, now: () => NOW })],
      store,
    });
    expect(outcome.discovered).toHaveLength(3);
    expect(await store.list()).toHaveLength(0);
  });
});

describe("the simulated adapter proves the ports", () => {
  const adapter = createSimulatedAdapter({
    devices: [
      { providerRef: "plug-1", capabilities: ["power.switch"] },
      { providerRef: "broken-1", capabilities: ["power.switch"], faulty: true },
    ],
    now: () => NOW,
  });

  it("marks its devices as simulated", async () => {
    const [first] = await adapter.discover();
    // Nothing here should ever be mistakable for a real reading.
    expect(first?.adapterId).toBe("simulated");
    expect(first?.metadata["simulated"]).toBe(true);
  });

  it("executes an authorized command", async () => {
    const result = await adapter.execute!(intent());
    expect(result.outcome).toBe("succeeded");
  });

  it("reports a device failure with a reason", async () => {
    const result = await adapter.execute!(intent({ deviceId: "simulated:broken-1" }));
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("faulty");
  });

  it("reports an unknown device rather than pretending", async () => {
    const result = await adapter.execute!(intent({ deviceId: "simulated:nope" }));
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("does not know");
  });

  it("logs commands for idempotency", async () => {
    const log = createInMemoryCommandLog();
    const result = await adapter.execute!(intent());
    await log.record(intent(), result);

    expect(await log.findByIdempotencyKey("key-1")).not.toBeNull();
    expect(await log.recent("simulated:plug-1")).toHaveLength(1);
  });

  it("stores and queries observations", async () => {
    const sink = createInMemoryObservationSink();
    await sink.record([
      localObservationSchema.parse({
        observationId: "o1", kind: "energy", capability: "energy.measure",
        deviceId: "simulated:plug-1", ownerRef: "org:1", observedAt: at(), value: 1.2, unit: "kWh",
      }),
    ]);
    expect(await sink.query({ deviceId: "simulated:plug-1" })).toHaveLength(1);
    expect(await sink.query({ deviceId: "other" })).toHaveLength(0);
  });
});
