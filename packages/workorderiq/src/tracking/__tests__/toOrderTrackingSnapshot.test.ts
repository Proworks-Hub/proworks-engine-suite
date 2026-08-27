// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import { assertTrackingSafeFor, redactTrackingFor, validateTrackingSnapshot } from "@proworks-hub/contracts";

import type { Milestone, WorkOrderProjection } from "../../core/tracking/trackingTypes.js";
import { toOrderTrackingSnapshot } from "../toOrderTrackingSnapshot.js";

const projection = (over: Partial<WorkOrderProjection> = {}): WorkOrderProjection => ({
  workOrderId: "wo_991",
  currentMilestone: "in_production",
  completedStepCount: 4,
  totalStepCount: 9,
  percentComplete: 44,
  estimatedCompletionAt: new Date("2026-09-04T17:00:00.000Z"),
  etaConfidence: "tentative",
  lastUpdated: new Date("2026-08-27T12:00:00.000Z"),
  ...over,
});

const snapshotFor = (over: Partial<WorkOrderProjection> = {}, branch: "ship" | "pickup" = "ship") =>
  toOrderTrackingSnapshot({
    projection: projection(over),
    orderRef: "KSX-10284",
    organizationId: "org-a",
    branch,
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });

describe("mapping a milestone to a public stage", () => {
  it("does not tell the customer about routing", () => {
    // Routing is a decision the shop makes about itself. From outside, routed
    // and not-yet-routed are the same thing: we have it, we have not started.
    expect(snapshotFor({ currentMilestone: "intake" }).stage).toBe("received");
    expect(snapshotFor({ currentMilestone: "routed" }).stage).toBe("received");
  });

  it("does not say shipped when production finishes", () => {
    // The box is packed and waiting for a carrier. Nothing has shipped until a
    // carrier says so, and "shipped" is the promise that generates the call.
    expect(snapshotFor({ currentMilestone: "completed" }, "ship").stage).toBe("packing");
  });

  it("says ready for pickup when the order is collected rather than shipped", () => {
    expect(snapshotFor({ currentMilestone: "completed" }, "pickup").stage).toBe(
      "ready_for_pickup",
    );
  });

  it("places every stage on its own branch", () => {
    expect(snapshotFor({ currentMilestone: "completed" }, "pickup").stageIndex).toBeGreaterThan(-1);
    expect(snapshotFor({ currentMilestone: "in_production" }, "ship").stageIndex).toBeGreaterThan(-1);
  });

  it("maps every milestone to something", () => {
    // The compiler enforces exhaustiveness; this catches a mapping that
    // compiles and produces a stage nobody meant.
    const milestones: Milestone[] = [
      "intake",
      "routed",
      "in_production",
      "quality_check",
      "ready_for_pickup",
      "completed",
    ];
    for (const currentMilestone of milestones) {
      expect(() => validateTrackingSnapshot(snapshotFor({ currentMilestone }))).not.toThrow();
    }
  });
});

describe("what crosses into the public snapshot", () => {
  it("keeps the work-order id out of the customer's hands", () => {
    // An internal key handed to a customer is a key they will quote at someone
    // who cannot resolve it.
    const customerView = redactTrackingFor(snapshotFor(), "customer");
    expect(customerView.orderRef).toBe("KSX-10284");
    expect(JSON.stringify(customerView)).not.toContain("wo_991");
  });

  it("tells the customer they are behind without saying why", () => {
    const snapshot = snapshotFor({
      etaConfidence: "at_risk",
      etaRiskReason: "dependency_blocked",
    });

    expect(snapshot.runningBehind).toBe(true);
    expect(snapshot.internal?.riskReason).toBe("dependency_blocked");

    const customerView = redactTrackingFor(snapshot, "customer");
    expect(customerView.runningBehind).toBe(true);
    expect(JSON.stringify(customerView)).not.toContain("dependency_blocked");
  });

  it("counts a past-due order as behind even when the ETA looks firm", () => {
    // The two are different failures. A firm ETA that is already past the
    // promised date is still late.
    const snapshot = toOrderTrackingSnapshot({
      projection: projection({ etaConfidence: "firm" }),
      orderRef: "KSX-1",
      organizationId: "org-a",
      branch: "ship",
      pastDue: true,
    });

    expect(snapshot.confidence).toBe("firm");
    expect(snapshot.runningBehind).toBe(true);
  });

  it("carries the engine's confidence through unchanged", () => {
    for (const etaConfidence of ["firm", "tentative", "at_risk"] as const) {
      expect(snapshotFor({ etaConfidence }).confidence).toBe(etaConfidence);
    }
  });

  it("returns null rather than a fabricated date when there is no ETA", () => {
    const { estimatedCompletionAt: _drop, ...rest } = projection();
    const snapshot = toOrderTrackingSnapshot({
      projection: rest as WorkOrderProjection,
      orderRef: "KSX-1",
      organizationId: "org-a",
      branch: "ship",
    });

    expect(snapshot.estimatedCompletionAt).toBeNull();
  });

  it("produces something the contract accepts and redaction clears", () => {
    const snapshot = snapshotFor();
    expect(() => validateTrackingSnapshot(snapshot)).not.toThrow();
    expect(() => assertTrackingSafeFor(redactTrackingFor(snapshot, "customer"), "customer"))
      .not.toThrow();
  });
});
