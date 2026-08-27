// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CapabilityError,
  createCapabilityResolver,
  expandCapabilities,
  requireCapability,
} from "@proworks-hub/contracts";
import {
  createCreateWorkOrderUseCase,
  createInMemoryEventLog,
  type EventActor,
} from "@proworks-hub/workorderiq";
import { createCostIqEngine } from "@proworks-hub/costiq";
import { createReceiptIqEngine } from "@proworks-hub/receiptiq";

// ─────────────────────────────────────────────────────────────────────────────
// The acceptance test for the split.
//
// Everything here is about what a consumer can do WITHOUT the rest of the
// ecosystem. That is the claim the architecture makes, and a claim nobody
// tests is a claim that quietly stops being true.
// ─────────────────────────────────────────────────────────────────────────────

const actor: EventActor = { kind: "user", userId: "maker-1" };

describe("a work order with no orchestrator", () => {
  it("can be created without Prime, ProWorks, or anything else", async () => {
    // This is the one-person shop: an event log, a work order, done. If this
    // ever needs a second import, MakerOps has acquired a ProWorks dependency
    // and the adoption strategy is broken.
    const log = createInMemoryEventLog();
    const createWorkOrder = createCreateWorkOrderUseCase({ eventLog: log });

    // The worked example from the directive: fifty shirts for a plumbing firm.
    const result = await createWorkOrder.execute(
      {
        customerId: "smith-plumbing",
        customerName: "Smith Plumbing",
        source: "manual",
        lineItems: [{ id: "line-1", label: "Company Shirt — DTF, left chest + full back", quantity: 50 }],
        dueDate: "2026-09-04",
        shopNotes: "Left chest + full back",
      },
      actor,
    );

    expect(result.ok).toBe(true);
    expect(await log.size()).toBeGreaterThan(0);
  });

  it("does not pull Prime in through the back door", async () => {
    // The engine's own manifest is the proof: contracts, and nothing else.
    const pkg = await import("../packages/workorderiq/package.json", { with: { type: "json" } });
    const deps = Object.keys((pkg.default as { dependencies: Record<string, string> }).dependencies);
    expect(deps.filter((d) => d.startsWith("@proworks-hub/"))).toEqual(["@proworks-hub/contracts"]);
  });
});

describe("each engine stands alone", () => {
  it("CostIQ costs without WorkOrder or Prime present", () => {
    const engine = createCostIqEngine();
    expect(engine.name).toBe("costiq");
  });

  it("ReceiptIQ reads a receipt without any of the others", async () => {
    const receipt = await createReceiptIqEngine().read(
      { kind: "text", text: "HOME DEPOT\nBrighton, CO\n08/26/2026\nBolt 4.50\nTotal 4.50" },
      { ownerRef: "maker-1", ownership: "tenant-private" },
    );
    expect(receipt.merchantName).toBe("Home Depot");
  });
});

describe("capabilities decide what a consumer may do", () => {
  const resolver = createCapabilityResolver([
    {
      organizationId: "small-maker",
      application: "makerops",
      capabilities: [CAPABILITIES.workOrder.print, CAPABILITIES.costIq.basic],
    },
    {
      organizationId: "production-shop",
      application: "proworks",
      capabilities: [CAPABILITIES.workOrder.shopFloor, CAPABILITIES.costIq.advanced],
    },
  ]);

  it("gives a maker basic work orders without a ProWorks subscription", async () => {
    await expect(
      requireCapability(resolver, "small-maker", "makerops", CAPABILITIES.workOrder.basic),
    ).resolves.toBeUndefined();
  });

  it("refuses the maker shop-floor execution", async () => {
    // Refused at the domain boundary, not hidden in a UI.
    await expect(
      requireCapability(resolver, "small-maker", "makerops", CAPABILITIES.workOrder.shopFloor),
    ).rejects.toThrow(CapabilityError);
  });

  it("gives the production shop the same work order with more of it unlocked", async () => {
    for (const capability of [
      CAPABILITIES.workOrder.basic,
      CAPABILITIES.workOrder.digital,
      CAPABILITIES.workOrder.productionTracking,
      CAPABILITIES.workOrder.shopFloor,
    ]) {
      await expect(
        requireCapability(resolver, "production-shop", "proworks", capability),
      ).resolves.toBeUndefined();
    }
  });

  it("implies what a capability depends on, so a tier cannot be half-configured", () => {
    // Granting shop_floor and forgetting basic would otherwise produce a shop
    // that can run a floor but cannot create a work order.
    const granted = expandCapabilities([CAPABILITIES.workOrder.shopFloor]);
    expect(granted.has(CAPABILITIES.workOrder.basic)).toBe(true);
    expect(granted.has(CAPABILITIES.workOrder.digital)).toBe(true);
    // But it does not over-grant: shop floor does not imply scheduling.
    expect(granted.has(CAPABILITIES.workOrder.scheduling)).toBe(false);
  });

  it("scopes grants per application, so one org can hold different sets", async () => {
    await expect(
      requireCapability(resolver, "small-maker", "proworks", CAPABILITIES.workOrder.basic),
    ).rejects.toThrow(CapabilityError);
  });

  it("grants nothing to an organization nobody has configured", async () => {
    // Absence must not read as permission.
    await expect(
      requireCapability(resolver, "unknown-org", "makerops", CAPABILITIES.workOrder.basic),
    ).rejects.toThrow(CapabilityError);
  });

  it("says what was missing, so the refusal is explicable", async () => {
    const error = await requireCapability(
      resolver, "small-maker", "makerops", CAPABILITIES.workOrder.scheduling,
    ).catch((e: unknown) => e as CapabilityError);
    expect(error.capability).toBe(CAPABILITIES.workOrder.scheduling);
    expect(error.message).toMatch(/entitlement, not a bug/);
  });
});

describe("Prime orchestrates without owning", () => {
  it("depends on contracts alone — not on the engine that owns work orders", async () => {
    const pkg = await import("../packages/prime/package.json", { with: { type: "json" } });
    const deps = Object.keys((pkg.default as { dependencies: Record<string, string> }).dependencies);
    // Prime references a workOrderId. It does not import the work order.
    expect(deps).not.toContain("@proworks-hub/workorderiq");
    expect(deps.filter((d) => d.startsWith("@proworks-hub/"))).toEqual(["@proworks-hub/contracts"]);
  });
});
