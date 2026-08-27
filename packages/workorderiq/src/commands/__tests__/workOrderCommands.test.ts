// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES,
  createCapabilityResolver,
  validateCommandEnvelope,
  type CommandEnvelope,
} from "@proworks-hub/contracts";

import type { EventActor } from "../../models/events.js";
import {
  COMMAND_CAPABILITY,
  WORK_ORDER_COMMANDS,
  createWorkOrderCommandDispatcher,
  isWorkOrderCommandType,
  type WorkOrderCommandType,
} from "../workOrderCommands.js";

const actor: EventActor = { kind: "user", userId: "op-1", role: "operator" };

const command = (
  type: WorkOrderCommandType,
  over: Partial<CommandEnvelope<WorkOrderCommandType, unknown>> = {},
): CommandEnvelope<WorkOrderCommandType, unknown> => ({
  commandId: "cmd_1",
  type,
  organizationId: "org-a",
  issuedAt: "2026-08-27T12:00:00.000Z",
  trace: { correlationId: "cor_1" },
  payload: { customerId: "c1" },
  ...over,
});

const ok = () => ({ execute: vi.fn(async () => ({ ok: true as const, draft: { id: "wo_1" } })) });

const resolverWith = (capabilities: string[], application = "proworks") =>
  createCapabilityResolver([{ organizationId: "org-a", application, capabilities }]);

describe("the boundary refuses before it delegates", () => {
  it("refuses everything when no resolver was configured", async () => {
    // Fails closed. Allowing everything when entitlements are unwired means a
    // deployment that forgot them is a deployment with none, and nothing about
    // how it behaves would say so.
    const handler = ok();
    const dispatcher = createWorkOrderCommandDispatcher({
      application: "proworks",
      handlers: { "work_order.create": handler },
    });

    const result = await dispatcher.dispatch(command("work_order.create"), actor);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal).toBe("not_entitled");
    // And the handler is never reached.
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it("refuses a command the consumer has not bought", async () => {
    const handler = ok();
    const dispatcher = createWorkOrderCommandDispatcher({
      handlers: { "work_order.route_steps": handler },
      capabilities: resolverWith([CAPABILITIES.workOrder.basic], "makerops"),
      application: "makerops",
    });

    const result = await dispatcher.dispatch(command("work_order.route_steps"), actor);

    expect(result.ok === false && result.refusal).toBe("not_entitled");
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it("lets a basic consumer do the whole of a small shop's job", async () => {
    // The concrete promise behind the tiering: MakerOps gets work orders
    // without ProWorks.
    const dispatcher = createWorkOrderCommandDispatcher({
      handlers: {
        "work_order.create": ok(),
        "work_order.resolve_template": ok(),
        "work_order.terminate": ok(),
      },
      capabilities: resolverWith([CAPABILITIES.workOrder.basic], "makerops"),
      application: "makerops",
    });

    for (const type of [
      "work_order.create",
      "work_order.resolve_template",
      "work_order.terminate",
    ] as const) {
      expect((await dispatcher.dispatch(command(type), actor)).ok).toBe(true);
    }
  });

  it("separates 'you have not bought this' from 'we have not built this'", async () => {
    // Conflating them makes a missing feature look like a billing problem, and
    // sends the customer to the wrong person.
    const dispatcher = createWorkOrderCommandDispatcher({
      application: "proworks",
      handlers: {},
      capabilities: resolverWith([CAPABILITIES.workOrder.shopFloor]),
    });

    const result = await dispatcher.dispatch(command("work_order.advance_step"), actor);

    expect(result.ok === false && result.refusal).toBe("unsupported");
    expect(result.ok === false && result.message).toMatch(/not wired in this deployment/);
  });

  it("refuses a type it has never heard of", async () => {
    const dispatcher = createWorkOrderCommandDispatcher({
      application: "proworks",
      handlers: {},
      capabilities: resolverWith([CAPABILITIES.workOrder.shopFloor]),
    });

    const result = await dispatcher.dispatch(
      command("work_order.invent_something" as WorkOrderCommandType),
      actor,
    );

    expect(result.ok === false && result.refusal).toBe("unsupported");
  });
});

describe("what happens on the way through", () => {
  it("hands the payload and actor to the use case unchanged", async () => {
    const handler = ok();
    const dispatcher = createWorkOrderCommandDispatcher({
      application: "proworks",
      handlers: { "work_order.create": handler },
      capabilities: resolverWith([CAPABILITIES.workOrder.basic]),
    });

    await dispatcher.dispatch(command("work_order.create"), actor);

    expect(handler.execute).toHaveBeenCalledWith({ customerId: "c1" }, actor);
  });

  it("turns a domain rejection into a refusal rather than an error", async () => {
    // A step that cannot advance from where it is has not crashed. It has been
    // told no, and that is a normal outcome a caller can act on.
    const dispatcher = createWorkOrderCommandDispatcher({
      application: "proworks",
      handlers: {
        "work_order.advance_step": {
          execute: async () => ({ ok: false, error: { code: "invalid_transition" } }),
        },
      },
      capabilities: resolverWith([CAPABILITIES.workOrder.shopFloor]),
    });

    const result = await dispatcher.dispatch(command("work_order.advance_step"), actor);

    expect(result.ok === false && result.refusal).toBe("conflict");
    expect(result.ok === false && result.details).toEqual({ code: "invalid_transition" });
  });

  it("records every command, refused ones included", async () => {
    // The refused ones are the interesting ones. A log that only shows what
    // succeeded cannot answer why a customer says the button does nothing.
    const onDispatch = vi.fn();
    const dispatcher = createWorkOrderCommandDispatcher({
      application: "proworks",
      handlers: { "work_order.create": ok() },
      capabilities: resolverWith([CAPABILITIES.workOrder.basic]),
      onDispatch,
    });

    await dispatcher.dispatch(command("work_order.create"), actor);
    await dispatcher.dispatch(command("work_order.route_steps"), actor);

    expect(onDispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "work_order.create",
      outcome: "accepted",
      correlationId: "cor_1",
    }));
    expect(onDispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "work_order.route_steps",
      outcome: "refused",
      refusal: "not_entitled",
    }));
  });
});

describe("the command catalogue", () => {
  it("prices every command it accepts", () => {
    // A command with no capability entry would be reachable by anyone. The map
    // is the enforcement, so a gap in it is a hole rather than a default.
    for (const type of WORK_ORDER_COMMANDS) {
      expect(COMMAND_CAPABILITY[type]).toBeTruthy();
    }
    expect(Object.keys(COMMAND_CAPABILITY).sort()).toEqual([...WORK_ORDER_COMMANDS].sort());
  });

  it("narrows an unknown string at a boundary", () => {
    expect(isWorkOrderCommandType("work_order.create")).toBe(true);
    expect(isWorkOrderCommandType("receipt.ingest")).toBe(false);
  });

  it("accepts an envelope that crossed a wire", async () => {
    // The point of the envelope: a command can be serialized, queued, and
    // dispatched by something that never held a reference to the engine.
    const wire = JSON.parse(JSON.stringify(command("work_order.create")));
    const parsed = validateCommandEnvelope(wire);

    const dispatcher = createWorkOrderCommandDispatcher({
      application: "proworks",
      handlers: { "work_order.create": ok() },
      capabilities: resolverWith([CAPABILITIES.workOrder.basic]),
    });

    const result = await dispatcher.dispatch(
      parsed as CommandEnvelope<WorkOrderCommandType, unknown>,
      actor,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an envelope carrying a field nobody declared", () => {
    expect(() =>
      validateCommandEnvelope({ ...command("work_order.create"), impersonate: "admin" }),
    ).toThrow();
  });
});
