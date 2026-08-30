// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { progressMayFollow, workProgressSchema } from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// The return direction, where the privacy risk reverses.
//
// Sending work out, the danger is the sender over-sharing about the customer.
// Sending progress back, the danger is the MANUFACTURER over-sharing about
// themselves: which operator, which machine, what it cost, how far behind they
// are. A status update is exactly where that leaks, because all of it is
// genuinely useful to whoever is chasing a late order.
//
// These tests pin the absence of those fields, and the ordering rule that
// stops a retrying transport from walking a customer's tracking page
// backwards.
// ─────────────────────────────────────────────────────────────────────────────

const progress = (over: Record<string, unknown> = {}) => ({
  correlationId: "ksix-order-26",
  status: "IN_PROGRESS",
  observedAt: "2026-08-30T12:00:00.000Z",
  ...over,
});

describe("a progress report says where the work is and nothing else", () => {
  it("accepts the minimum a tracker needs", () => {
    expect(workProgressSchema.safeParse(progress()).success).toBe(true);
  });

  it("refuses an operator, a machine, or a cost", () => {
    // Each of these is something ProWorks knows and KSix has no business
    // storing. Strict mode is what makes the refusal automatic rather than
    // dependent on somebody noticing.
    for (const leak of [
      { operatorName: "Bob" },
      { operatorUserId: 7 },
      { machineId: "fiber-1" },
      { internalCost: 210.5 },
      { queuePosition: 4 },
    ]) {
      expect(workProgressSchema.safeParse(progress(leak)).success).toBe(false);
    }
  });

  it("refuses a free-text note", () => {
    // The field that would eventually contain "Bob's out sick and the fiber
    // laser is down", on a page a customer can read.
    expect(workProgressSchema.safeParse(progress({ note: "running late" })).success).toBe(false);
    expect(workProgressSchema.safeParse(progress({ message: "running late" })).success).toBe(false);
  });

  it("carries progress as a ratio, not as the manufacturer's step names", () => {
    const ok = workProgressSchema.safeParse(progress({ completedSteps: 3, totalSteps: 7 }));
    expect(ok.success).toBe(true);
    // A step NAME would couple KSix's tracking page to ProWorks' shop process.
    expect(workProgressSchema.safeParse(progress({ currentStepName: "powder coat" })).success).toBe(false);
  });
});

describe("a report cannot describe an impossible state", () => {
  it("refuses more steps done than exist", () => {
    // Renders as over 100% on a progress bar.
    const bad = progress({ completedSteps: 9, totalSteps: 7 });
    expect(workProgressSchema.safeParse(bad).success).toBe(false);
  });

  it("allows steps done to equal steps total", () => {
    expect(workProgressSchema.safeParse(progress({ completedSteps: 7, totalSteps: 7 })).success).toBe(true);
  });

  it("refuses COMPLETED while steps remain", () => {
    // Completed-but-partway is two answers to one question.
    const bad = progress({ status: "COMPLETED", completedSteps: 3, totalSteps: 7 });
    expect(workProgressSchema.safeParse(bad).success).toBe(false);
  });

  it("allows COMPLETED with no steps stated at all", () => {
    // A manufacturer that does not share step counts can still say it is done.
    expect(workProgressSchema.safeParse(progress({ status: "COMPLETED" })).success).toBe(true);
  });

  it("refuses a status nobody defined", () => {
    expect(workProgressSchema.safeParse(progress({ status: "ALMOST_DONE" })).success).toBe(false);
  });

  it("requires an observation time", () => {
    const { observedAt, ...without } = progress();
    void observedAt;
    expect(workProgressSchema.safeParse(without).success).toBe(false);
  });
});

describe("work does not move backwards on a customer's page", () => {
  it("accepts the first report whatever it says", () => {
    expect(progressMayFollow(null, "IN_PROGRESS").permitted).toBe(true);
    expect(progressMayFollow(null, "COMPLETED").permitted).toBe(true);
  });

  it("refuses anything after COMPLETED", () => {
    // Out-of-order delivery is NORMAL on a retrying transport, so this is a
    // situation that will happen rather than one that might.
    const verdict = progressMayFollow("COMPLETED", "IN_PROGRESS");
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("terminal");
  });

  it("refuses anything after CANCELLED", () => {
    expect(progressMayFollow("CANCELLED", "IN_PROGRESS").permitted).toBe(false);
    expect(progressMayFollow("CANCELLED", "COMPLETED").permitted).toBe(false);
  });

  it("allows ordinary forward movement", () => {
    expect(progressMayFollow("ACCEPTED", "SCHEDULED").permitted).toBe(true);
    expect(progressMayFollow("SCHEDULED", "IN_PROGRESS").permitted).toBe(true);
    expect(progressMayFollow("IN_PROGRESS", "COMPLETED").permitted).toBe(true);
  });

  it("allows a hold and a resume", () => {
    // ON_HOLD is not terminal: work stops and starts, and a tracker that could
    // not represent that would show stale progress instead.
    expect(progressMayFollow("IN_PROGRESS", "ON_HOLD").permitted).toBe(true);
    expect(progressMayFollow("ON_HOLD", "IN_PROGRESS").permitted).toBe(true);
  });

  it("names what it refused, for whoever reads the log", () => {
    const verdict = progressMayFollow("COMPLETED", "ON_HOLD");
    expect(verdict.reason).toContain("COMPLETED");
    expect(verdict.reason).toContain("ON_HOLD");
  });
});
