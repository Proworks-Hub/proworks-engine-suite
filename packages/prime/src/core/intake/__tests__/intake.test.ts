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

import { beforeEach, describe, expect, it } from "vitest";
import type { EventActor } from "../../../models/events.js";
import { createInMemoryEventLog } from "../../logging/inMemoryEventLog.js";
import type { EventLog } from "../../logging/eventLog.js";
import { validateIntakeInput } from "../intakeValidator.js";
import type {
  IntakeCreatedPayload,
  IntakeInput,
  IntakeValidationFailedPayload,
} from "../intakeTypes.js";
import { createCreateWorkOrderUseCase } from "../createWorkOrderUseCase.js";

// ---------- Fixtures ----------

const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");

function validInput(overrides: Partial<IntakeInput> = {}): IntakeInput {
  return {
    customerId: "cust-1",
    customerName: "Acme Signs",
    source: "manual",
    lineItems: [
      { id: "li-1", label: "24x36 acrylic sign", quantity: 2 },
    ],
    dueDate: "2026-05-01",
    priority: "high",
    ...overrides,
  };
}

// ============================================================
//  Validator
// ============================================================

describe("validateIntakeInput", () => {
  it("accepts a valid input", () => {
    const result = validateIntakeInput(validInput(), FIXED_NOW);
    expect(result.valid).toBe(true);
  });

  it("accepts input without a dueDate (optional)", () => {
    const result = validateIntakeInput(
      validInput({ dueDate: undefined }),
      FIXED_NOW
    );
    expect(result.valid).toBe(true);
  });

  it("flags missing customerId", () => {
    const result = validateIntakeInput(
      validInput({ customerId: "" }),
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((e) => e.code)).toContain("customer_id_missing");
    expect(result.errors.find((e) => e.code === "customer_id_missing")?.path).toBe(
      "customerId"
    );
  });

  it("flags whitespace-only customerName", () => {
    const result = validateIntakeInput(
      validInput({ customerName: "   " }),
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((e) => e.code)).toContain("customer_name_missing");
  });

  it("flags empty lineItems", () => {
    const result = validateIntakeInput(
      validInput({ lineItems: [] }),
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((e) => e.code)).toContain("line_items_empty");
  });

  it("flags line item with missing id / label and reports indexed path", () => {
    const result = validateIntakeInput(
      validInput({
        lineItems: [
          { id: "", label: "", quantity: 1 },
          { id: "li-2", label: "ok", quantity: 1 },
        ],
      }),
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("line_item_id_missing");
    expect(codes).toContain("line_item_label_missing");
    expect(
      result.errors.find((e) => e.code === "line_item_id_missing")?.path
    ).toBe("lineItems[0].id");
    expect(
      result.errors.find((e) => e.code === "line_item_label_missing")?.path
    ).toBe("lineItems[0].label");
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("flags invalid line item quantity: %s", (badQty) => {
    const result = validateIntakeInput(
      validInput({
        lineItems: [{ id: "li-1", label: "x", quantity: badQty as number }],
      }),
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((e) => e.code)).toContain(
      "line_item_quantity_invalid"
    );
  });

  it("flags unparseable dueDate", () => {
    const result = validateIntakeInput(
      validInput({ dueDate: "not-a-date" }),
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((e) => e.code)).toContain("due_date_invalid");
  });

  it("flags dueDate before today", () => {
    const result = validateIntakeInput(
      validInput({ dueDate: "2026-04-19" }),
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((e) => e.code)).toContain("due_date_in_past");
  });

  it("accepts dueDate equal to today regardless of clock time", () => {
    const result = validateIntakeInput(
      validInput({ dueDate: "2026-04-20" }),
      new Date("2026-04-20T23:59:59.000Z")
    );
    expect(result.valid).toBe(true);
  });

  it("aggregates multiple errors rather than bailing on first", () => {
    const result = validateIntakeInput(
      {
        customerId: "",
        customerName: "",
        source: "manual",
        lineItems: [],
      },
      FIXED_NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
//  createWorkOrderUseCase
// ============================================================

describe("createWorkOrderUseCase", () => {
  let log: EventLog;
  let nextId: number;

  beforeEach(() => {
    log = createInMemoryEventLog({
      clock: () => FIXED_NOW,
    });
    nextId = 0;
  });

  const useCase = () =>
    createCreateWorkOrderUseCase({
      eventLog: log,
      workOrderIdGenerator: () => `wo-${++nextId}`,
      clock: () => FIXED_NOW,
    });

  it("returns a draft and appends a single intake.created event on happy path", async () => {
    const result = await useCase().execute(validInput(), SUPERVISOR);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.workOrderId).toBe("wo-1");
    expect(result.draft.status).toBe("draft");
    expect(result.draft.priority).toBe("high");
    expect(result.draft.createdAt).toBe(FIXED_NOW.toISOString());
    expect(result.draft.lineItems).toHaveLength(1);

    const events = await log.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.intake.created");
    expect(events[0].actor).toEqual(SUPERVISOR);

    const payload = events[0].payload as IntakeCreatedPayload;
    expect(payload.source).toBe("manual");
    expect(payload.customerId).toBe("cust-1");
    expect(payload.priority).toBe("high");
    expect(payload.lineItemCount).toBe(1);
    expect(payload.dueDate).toBe("2026-05-01");
  });

  it("defaults priority to 'medium' when omitted", async () => {
    const result = await useCase().execute(
      validInput({ priority: undefined }),
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.priority).toBe("medium");

    const events = await log.listByWorkOrder("wo-1");
    const payload = events[0].payload as IntakeCreatedPayload;
    expect(payload.priority).toBe("medium");
  });

  it("freezes the returned draft", async () => {
    const result = await useCase().execute(validInput(), SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.draft)).toBe(true);
    expect(() => {
      (result.draft as any).status = "completed";
    }).toThrow();
  });

  it("emits intake.validation_failed on invalid input and does NOT emit intake.created", async () => {
    const result = await useCase().execute(
      validInput({ customerId: "", lineItems: [] }),
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attemptedWorkOrderId).toBe("wo-1");
    expect(result.errors.length).toBeGreaterThan(0);

    const events = await log.listSince(0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.intake.validation_failed");

    // The failure event carries the attempted WO id so ops can trace it.
    expect(events[0].workOrderId).toBe("wo-1");

    const payload = events[0].payload as IntakeValidationFailedPayload;
    expect(payload.source).toBe("manual");
    expect(payload.errors.length).toBeGreaterThan(0);
    // customerId was empty → omitted from payload
    expect(payload.attemptedCustomerId).toBeUndefined();
  });

  it("records attemptedCustomerId on validation failure when customerId was supplied", async () => {
    const result = await useCase().execute(
      validInput({ customerId: "cust-xyz", lineItems: [] }),
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const events = await log.listByType("work_order.intake.validation_failed");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as IntakeValidationFailedPayload;
    expect(payload.attemptedCustomerId).toBe("cust-xyz");
  });

  it("assigns independent WO ids across successive calls", async () => {
    const uc = useCase();
    const a = await uc.execute(validInput(), SUPERVISOR);
    const b = await uc.execute(validInput(), SUPERVISOR);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.draft.workOrderId).toBe("wo-1");
    expect(b.draft.workOrderId).toBe("wo-2");

    expect(await log.size()).toBe(2);
  });

  it("uses the default id generator when one isn't injected", async () => {
    const uc = createCreateWorkOrderUseCase({
      eventLog: log,
      clock: () => FIXED_NOW,
    });
    const result = await uc.execute(validInput(), SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.workOrderId).toMatch(/^wo_/);
  });
});
