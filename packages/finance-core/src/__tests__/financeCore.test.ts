// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@proworks-hub/contracts";

import { createFinanceCoordinator, financeRequest } from "../coordinator.js";
import { createFinanceRegistry, type FinanceSpecialist } from "../registry.js";

const context = {
  requestId: "req-1",
  receivedAt: "2026-08-28T09:00:00.000Z",
} as unknown as RequestContext;

const ask = (capability: Parameters<typeof financeRequest>[0]["capability"]) =>
  financeRequest({ capability, input: { widthIn: 24 }, context, correlationId: "corr-1" });

const specialist = (
  id: string,
  capabilities: FinanceSpecialist["capabilities"],
  handle: FinanceSpecialist["handle"],
  extra: Partial<FinanceSpecialist> = {},
): FinanceSpecialist => ({ id, capabilities, handle, ...extra });

const costiq = (output: unknown = { totalCents: 41_200 }) =>
  specialist("costiq", ["calculate_cost", "estimate_margin"], async () => output);

describe("a Core coordinates specialists it does not import", () => {
  it("answers a domain question through whoever claims the capability", async () => {
    const registry = createFinanceRegistry([costiq()]);
    const coordinator = createFinanceCoordinator({ registry });

    const outcome = await coordinator.ask(ask("calculate_cost"));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.answer.output).toEqual({ totalCents: 41_200 });
      expect(outcome.answer.servedBy).toBe("costiq");
    }
  });

  it("derives its capabilities from what is registered", async () => {
    // A Core that DECLARED its capabilities would keep claiming to answer
    // questions after the specialist that answered them was removed.
    const registry = createFinanceRegistry();
    expect(registry.capabilities()).toEqual([]);

    registry.register(costiq());
    expect(registry.capabilities()).toEqual(["calculate_cost", "estimate_margin"]);
  });

  it("says plainly when this installation has no specialist for something", async () => {
    // Not an error. A host with no BudgetIQ genuinely cannot forecast, and
    // saying so beats a stack trace.
    const coordinator = createFinanceCoordinator({ registry: createFinanceRegistry([costiq()]) });
    const outcome = await coordinator.ask(ask("forecast_spend"));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.failure).toBe("no_specialist");
      expect(outcome.refusal.reason).toContain("No registered specialist");
    }
  });

  it("replaces a specialist by id rather than accumulating copies", () => {
    // A host re-registering after a reconnect should not end up with two, one
    // of them dead.
    const registry = createFinanceRegistry([costiq()]);
    registry.register(specialist("costiq", ["calculate_cost"], async () => ({ v: 2 })));
    expect(registry.registered()).toHaveLength(1);
  });

  it("prefers the better-ranked specialist when two claim one capability", async () => {
    const registry = createFinanceRegistry([
      specialist("legacy", ["calculate_cost"], async () => ({ from: "legacy" }), { preference: 200 }),
      specialist("costiq", ["calculate_cost"], async () => ({ from: "costiq" }), { preference: 10 }),
    ]);
    const outcome = await createFinanceCoordinator({ registry }).ask(ask("calculate_cost"));
    expect(outcome.ok && outcome.answer.servedBy).toBe("costiq");
  });
});

describe("one failing specialist does not collapse the Hive", () => {
  it("returns a typed refusal rather than throwing", async () => {
    const registry = createFinanceRegistry([
      specialist("costiq", ["calculate_cost"], async () => {
        throw new Error("database unreachable");
      }),
    ]);
    const outcome = await createFinanceCoordinator({ registry }).ask(ask("calculate_cost"));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.failure).toBe("specialist_error");
      expect(outcome.refusal.reason).toContain("database unreachable");
    }
  });

  it("times out a specialist that hangs", async () => {
    // A hung specialist must not hold Prime open.
    const registry = createFinanceRegistry([
      specialist("costiq", ["calculate_cost"], () => new Promise(() => {})),
    ]);
    const outcome = await createFinanceCoordinator({ registry, timeoutMs: 20 }).ask(ask("calculate_cost"));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("timeout");
  });

  it("does not fall back unless the host asked for it", async () => {
    // A silent substitution changes which engine answered, and a caller
    // comparing two results deserves to know they came from different places.
    const backup = vi.fn(async () => ({ from: "backup" }));
    const registry = createFinanceRegistry([
      specialist("primary", ["calculate_cost"], async () => {
        throw new Error("down");
      }, { preference: 10 }),
      specialist("backup", ["calculate_cost"], backup, { preference: 20 }),
    ]);

    const outcome = await createFinanceCoordinator({ registry }).ask(ask("calculate_cost"));
    expect(outcome.ok).toBe(false);
    expect(backup).not.toHaveBeenCalled();
  });

  it("falls back when it was", async () => {
    const registry = createFinanceRegistry([
      specialist("primary", ["calculate_cost"], async () => {
        throw new Error("down");
      }, { preference: 10 }),
      specialist("backup", ["calculate_cost"], async () => ({ from: "backup" }), { preference: 20 }),
    ]);

    const outcome = await createFinanceCoordinator({ registry, allowFallback: true }).ask(ask("calculate_cost"));
    expect(outcome.ok && outcome.answer.servedBy).toBe("backup");
  });
});

describe("partial is a first-class answer", () => {
  it("returns what worked alongside what did not", async () => {
    // "Cost is £412; margin could not be computed" is more useful than an
    // error, and it is the shape somebody can act on.
    const registry = createFinanceRegistry([
      specialist("costiq", ["calculate_cost"], async () => ({ totalCents: 41_200 })),
      specialist("budgetiq", ["forecast_spend"], async () => {
        throw new Error("unavailable");
      }),
    ]);

    const result = await createFinanceCoordinator({ registry }).askAll([
      ask("calculate_cost"),
      ask("forecast_spend"),
      ask("allocate_budget"),
    ]);

    expect(result.answers).toHaveLength(1);
    expect(result.refusals).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.refusals.map((refusal) => refusal.failure).sort()).toEqual([
      "no_specialist", "specialist_error",
    ]);
  });

  it("reports complete only when nothing was refused", async () => {
    const registry = createFinanceRegistry([costiq()]);
    const result = await createFinanceCoordinator({ registry }).askAll([
      ask("calculate_cost"), ask("estimate_margin"),
    ]);
    expect(result.complete).toBe(true);
  });

  it("does not fire several requests at one tenant's data at once", async () => {
    // A coordinator running six concurrent queries against one shop is how it
    // becomes the cause of the timeouts it then reports.
    let concurrent = 0;
    let peak = 0;
    const registry = createFinanceRegistry([
      specialist("costiq", ["calculate_cost", "estimate_margin", "compare_cost_scenarios"], async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return {};
      }),
    ]);

    await createFinanceCoordinator({ registry }).askAll([
      ask("calculate_cost"), ask("estimate_margin"), ask("compare_cost_scenarios"),
    ]);
    expect(peak).toBe(1);
  });
});

describe("what the Core reports about itself", () => {
  it("distinguishes unhealthy from not reporting", async () => {
    // A specialist that does not report health has not said it is unwell.
    // Rendering it red would fill a console with alarm for engines that are
    // fine.
    const registry = createFinanceRegistry([
      specialist("quiet", ["calculate_cost"], async () => ({})),
      specialist("loud", ["normalize_receipt"], async () => ({}), {
        health: async () => ({ healthy: true, detail: "Fine." }),
      }),
      specialist("sick", ["detect_purchase"], async () => ({}), {
        health: async () => ({ healthy: false, detail: "Cannot reach storage." }),
      }),
    ]);

    const status = await createFinanceCoordinator({ registry }).status();
    const byId = Object.fromEntries(status.specialists.map((entry) => [entry.id, entry]));

    expect(byId["quiet"]!.healthy).toBeNull();
    expect(byId["loud"]!.healthy).toBe(true);
    expect(byId["sick"]!.healthy).toBe(false);
  });

  it("treats a health check that hangs as unhealthy", async () => {
    const registry = createFinanceRegistry([
      specialist("stuck", ["calculate_cost"], async () => ({}), {
        health: () => new Promise(() => {}),
      }),
    ]);
    const status = await createFinanceCoordinator({ registry, timeoutMs: 20 }).status();
    expect(status.specialists[0]!.healthy).toBe(false);
  });

  it("reports the capabilities it can currently answer", async () => {
    const status = await createFinanceCoordinator({
      registry: createFinanceRegistry([costiq()]),
    }).status();
    expect(status.core).toBe("finance");
    expect(status.capabilities).toContain("calculate_cost");
  });
});

describe("observability", () => {
  it("reports every attempt, successes and failures alike", async () => {
    const onAttempt = vi.fn();
    const registry = createFinanceRegistry([
      specialist("primary", ["calculate_cost"], async () => {
        throw new Error("down");
      }, { preference: 10 }),
      specialist("backup", ["calculate_cost"], async () => ({}), { preference: 20 }),
    ]);

    await createFinanceCoordinator({ registry, allowFallback: true, onAttempt }).ask(ask("calculate_cost"));

    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt.mock.calls[0]![0]).toMatchObject({ outcome: "failure", specialist: "primary" });
    expect(onAttempt.mock.calls[1]![0]).toMatchObject({ outcome: "success", specialist: "backup" });
  });

  it("carries the correlation id through", async () => {
    const onAttempt = vi.fn();
    await createFinanceCoordinator({
      registry: createFinanceRegistry([costiq()]),
      onAttempt,
    }).ask(financeRequest({
      capability: "calculate_cost", input: {}, context, correlationId: "ord-99",
    }));
    expect(onAttempt.mock.calls[0]![0]).toMatchObject({ correlationId: "ord-99" });
  });

  it("keeps causation separate from correlation", () => {
    // One trace, many causes. Collapsing them loses the shape of a workflow
    // that fanned out.
    const request = financeRequest({
      capability: "calculate_cost", input: {}, context,
      correlationId: "ord-99", causationId: "plan-generated",
    });
    expect(request.correlationId).toBe("ord-99");
    expect(request.causationId).toBe("plan-generated");
  });
});
