// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import type { RequestContext } from "@proworks-hub/contracts";

import {
  answerKind,
  createResourcesCoordinator,
  createResourcesRegistry,
  isBinding,
  isStale,
  resourcesCapabilitySchema,
  type ResourcesAnswer,
  type ResourcesSpecialist,
} from "../resources.js";


import { createAllowAllGovernanceForTests } from "@proworks-hub/contracts";

// Allow-all Governance. These tests exercise coordination, not authorization;
// the authorization path is tested in tests/governedResolution.test.ts.
const testGovernance = createAllowAllGovernanceForTests({
  reason: "core coordination tests; authorization tested separately",
  env: {},
});

const context = {
  requestId: "req-1",
  tenant: { organizationId: "test-org", roles: [] },
  identity: { subject: "test-actor", kind: "user", roles: [], assertedCapabilities: [] },
  trace: { correlationId: "cor-1" },
  apiVersion: "v1",
  receivedAt: "2026-08-28T00:00:00.000Z",
} as unknown as RequestContext;

const specialist = (
  id: string,
  capabilities: ResourcesSpecialist["capabilities"],
  handle: ResourcesSpecialist["handle"],
  extra: Partial<ResourcesSpecialist> = {},
): ResourcesSpecialist => ({ id, capabilities, handle, ...extra });

const inventoryIq = () =>
  specialist(
    "inventoryiq",
    ["check_availability", "detect_shortages", "reserve_material", "consume_material"],
    async (request) => {
      if (request.capability === "check_availability") return { onHand: 4, available: 4 };
      if (request.capability === "detect_shortages") return { shortages: [] };
      if (request.capability === "reserve_material") return { reservationId: "res-1", quantity: 2 };
      return { consumed: 2 };
    },
  );

const ask = (capability: Parameters<typeof answerKind>[0], correlationId = "c1") => ({
  capability,
  input: {},
  context,
  correlationId,
});

describe("a reading is not a hold", () => {
  it("classifies every capability in the vocabulary", () => {
    // A capability with no classification would be stamped `undefined` and read
    // as neither, which is the ambiguity this Core exists to remove.
    for (const capability of resourcesCapabilitySchema.options) {
      expect(["reading", "commitment"]).toContain(answerKind(capability));
    }
  });

  it("calls checking a reading and reserving a commitment", () => {
    expect(isBinding("check_availability")).toBe(false);
    expect(isBinding("detect_shortages")).toBe(false);
    expect(isBinding("forecast_capacity")).toBe(false);

    expect(isBinding("reserve_material")).toBe(true);
    expect(isBinding("release_reservation")).toBe(true);
    expect(isBinding("consume_material")).toBe(true);
  });

  it("stamps an availability answer as a reading, not a guarantee", async () => {
    const coordinator = createResourcesCoordinator({ governance: testGovernance,
      registry: createResourcesRegistry([inventoryIq()]),
    });

    const outcome = await coordinator.ask(ask("check_availability"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.answer.kind).toBe("reading");
    expect(outcome.answer.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stamps a reservation as a commitment", async () => {
    const coordinator = createResourcesCoordinator({ governance: testGovernance,
      registry: createResourcesRegistry([inventoryIq()]),
    });

    const outcome = await coordinator.ask(ask("reserve_material"));
    expect(outcome.ok && outcome.answer.kind).toBe("commitment");
  });

  it("stamps observedAt from the Core's clock, not the specialist's claim", async () => {
    // A specialist reporting its own observation time could report a stale
    // reading as fresh. observedAt is the field a caller trusts to decide
    // whether the number still holds, so the Core owns it.
    const registry = createResourcesRegistry([
      specialist("liar", ["check_availability"], async () => ({
        observedAt: "1999-01-01T00:00:00.000Z",
        onHand: 4,
      })),
    ]);
    const coordinator = createResourcesCoordinator({ governance: testGovernance,
      registry,
      now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    });

    const outcome = await coordinator.ask(ask("check_availability"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.answer.observedAt).toBe("2026-08-28T12:00:00.000Z");
    // The specialist's own value survives inside its output, where it is data
    // rather than the Core's statement about freshness.
    expect((outcome.answer.output as { observedAt: string }).observedAt).toBe(
      "1999-01-01T00:00:00.000Z",
    );
  });
});

describe("staleness", () => {
  const reading = (observedAt: string): ResourcesAnswer => ({
    capability: "check_availability",
    output: { onHand: 4 },
    servedBy: "inventoryiq",
    latencyMs: 1,
    kind: "reading",
    observedAt,
  });

  const now = () => Date.parse("2026-08-28T12:00:00.000Z");

  it("holds a fresh reading to be usable", () => {
    expect(isStale(reading("2026-08-28T11:59:58.000Z"), 5_000, now)).toBe(false);
  });

  it("calls an old reading stale against the caller's own tolerance", () => {
    // The tolerance is the caller's, not this Core's. A number invented here
    // would be wrong for somebody: five seconds is generous for a cutting queue
    // and absurd for a monthly reorder report.
    expect(isStale(reading("2026-08-28T11:59:00.000Z"), 5_000, now)).toBe(true);
    expect(isStale(reading("2026-08-28T11:59:00.000Z"), 120_000, now)).toBe(false);
  });

  it("refuses to say whether a commitment has gone stale", () => {
    // A reservation does not expire by being read late. Answering `false` would
    // be technically true and would let the caller carry on believing a hold is
    // the kind of thing that needs re-checking.
    const held: ResourcesAnswer = {
      capability: "reserve_material",
      output: { reservationId: "res-1" },
      servedBy: "inventoryiq",
      latencyMs: 1,
      kind: "commitment",
      observedAt: "2026-08-28T11:00:00.000Z",
    };

    expect(() => isStale(held, 5_000, now)).toThrow(/commitment, not a reading/);
  });
});

describe("the machinery inherited from core-kit still holds here", () => {
  it("reports its own domain in status", async () => {
    const status = await createResourcesCoordinator({ governance: testGovernance,
      registry: createResourcesRegistry([inventoryIq()]),
    }).status();
    expect(status.core).toBe("resources");
  });

  it("refuses a capability nobody registered", async () => {
    // AssetIQ does not exist. Refusing locate_asset by name beats answering it
    // with an empty result that reads as "no assets".
    const outcome = await createResourcesCoordinator({ governance: testGovernance,
      registry: createResourcesRegistry([inventoryIq()]),
    }).ask(ask("locate_asset"));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("no_specialist");
  });

  it("times out a hung specialist", async () => {
    const registry = createResourcesRegistry([
      specialist("inventoryiq", ["check_availability"], () => new Promise(() => {})),
    ]);
    const outcome = await createResourcesCoordinator({ governance: testGovernance, registry, timeoutMs: 20 }).ask(
      ask("check_availability"),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("timeout");
  });

  it("stamps every answer in an askAll batch", async () => {
    const result = await createResourcesCoordinator({ governance: testGovernance,
      registry: createResourcesRegistry([inventoryIq()]),
    }).askAll([
      ask("check_availability", "c1"),
      ask("reserve_material", "c2"),
      // Nobody answers this one, so the batch must come back incomplete rather
      // than looking like two successes and nothing missing.
      ask("forecast_capacity", "c3"),
    ]);

    expect(result.answers.map((a) => a.kind)).toEqual(["reading", "commitment"]);
    expect(result.answers.every((a) => typeof a.observedAt === "string")).toBe(true);
    expect(result.refusals.map((r) => r.capability)).toEqual(["forecast_capacity"]);
    expect(result.complete).toBe(false);
  });

  it("distinguishes not-reporting from unhealthy", async () => {
    const registry = createResourcesRegistry([
      inventoryIq(),
      specialist("assetiq", ["locate_asset"], async () => ({}), {
        health: async () => ({ healthy: false, detail: "Asset registry unreachable." }),
      }),
    ]);
    const status = await createResourcesCoordinator({ governance: testGovernance, registry }).status();
    const byId = Object.fromEntries(status.specialists.map((s) => [s.id, s]));

    expect(byId["inventoryiq"]!.healthy).toBeNull();
    expect(byId["assetiq"]!.healthy).toBe(false);
  });

  it("does not offer a rollback it cannot perform", () => {
    // A Core cannot un-consume material. Offering it would be a lie that costs
    // somebody a second reservation against stock that is already gone.
    const coordinator = createResourcesCoordinator({ governance: testGovernance,
      registry: createResourcesRegistry([inventoryIq()]),
    });
    expect("rollback" in coordinator).toBe(false);
    expect("undo" in coordinator).toBe(false);
  });
});
