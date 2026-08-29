// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import type { EventActor } from "../../../models/events.js";
import { createInMemoryEventLog } from "../../logging/inMemoryEventLog.js";
import {
  createCreateWorkOrderUseCase,
  type CreateWorkOrderUseCaseDeps,
} from "../createWorkOrderUseCase.js";
import {
  createInMemoryIdempotencyStore,
  fingerprintIntake,
  IDEMPOTENCY_CONFLICT,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "../idempotency.js";
import type { IntakeInput } from "../intakeTypes.js";

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent work-order creation — the E2E-03 fix.
// ─────────────────────────────────────────────────────────────────────────────

const actor: EventActor = { kind: "system", source: "test" };

const input = (over: Partial<IntakeInput> = {}): IntakeInput => ({
  customerId: "cus_1",
  customerName: "KSix Designs",
  source: "manual",
  lineItems: [{ id: "li_1", label: "24in fire pit", quantity: 1 }],
  ...over,
});

let seq = 0;
const useCase = (over: Partial<CreateWorkOrderUseCaseDeps> = {}) => {
  seq = 0;
  return createCreateWorkOrderUseCase({
    eventLog: createInMemoryEventLog(),
    workOrderIdGenerator: () => `wo_${(seq += 1)}`,
    clock: () => new Date("2026-08-29T10:00:00.000Z"),
    idempotencyStore: createInMemoryIdempotencyStore(),
    ...over,
  });
};

const claim = { organizationId: "ksix", key: "order-388" };

describe("repeating a create with one key yields one work order", () => {
  it("returns the same work order on a replay", async () => {
    const create = useCase();
    const first = await create.execute(input(), actor, claim);
    const second = await create.execute(input(), actor, claim);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.workOrderId).toBe(first.draft.workOrderId);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBeUndefined();
  });

  it("appends the created event exactly once", async () => {
    // The guarantee is not just "same id back" — nothing downstream may see a
    // second creation.
    const log = createInMemoryEventLog();
    const create = useCase({ eventLog: log });
    await create.execute(input(), actor, claim);
    await create.execute(input(), actor, claim);

    const created = await log.listByType("work_order.intake.created");
    expect(created).toHaveLength(1);
  });

  it("creates separately without a key, as before", async () => {
    // The change is additive. An existing caller passing no key is unaffected.
    const create = useCase();
    const first = await create.execute(input(), actor);
    const second = await create.execute(input(), actor);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.workOrderId).not.toBe(first.draft.workOrderId);
  });
});

describe("the same key with a different payload conflicts", () => {
  it("refuses rather than silently replaying", async () => {
    // Returning the original would silently discard this request's change;
    // overwriting would change a work order under whoever created it.
    const create = useCase();
    const first = await create.execute(input(), actor, claim);
    const second = await create.execute(
      input({ lineItems: [{ id: "li_1", label: "30in fire pit", quantity: 2 }] }),
      actor,
      claim,
    );

    expect(second.ok).toBe(false);
    if (second.ok || !("conflict" in second)) throw new Error("expected a conflict");
    expect(second.conflict.code).toBe(IDEMPOTENCY_CONFLICT);
    expect(first.ok && second.conflict.existingWorkOrderId).toBe("wo_1");
    expect(second.conflict.message).toContain("silently discard");
  });

  it("treats any changed field as material", async () => {
    // Deciding which fields are immaterial is a judgement this module cannot
    // make for every caller, and being wrong means silently dropping a change.
    const create = useCase();
    await create.execute(input(), actor, claim);

    for (const changed of [
      input({ customerName: "Someone Else" }),
      input({ source: "portal" }),
      input({ dueDate: "2027-01-01" }),
      input({ shopNotes: "rush" }),
    ]) {
      const result = await create.execute(changed, actor, claim);
      expect(result.ok, JSON.stringify(changed).slice(0, 40)).toBe(false);
    }
  });

  it("fingerprints identically regardless of key order", async () => {
    // A caller retrying with a differently-ordered object must not get a
    // spurious conflict.
    const forward = { customerId: "cus_1", customerName: "KSix", source: "manual" as const, lineItems: [{ id: "li_1", label: "x", quantity: 1 }] };
    const reversed = { lineItems: [{ quantity: 1, label: "x", id: "li_1" }], source: "manual" as const, customerName: "KSix", customerId: "cus_1" };
    expect(fingerprintIntake(forward as IntakeInput)).toBe(fingerprintIntake(reversed as IntakeInput));
  });

  it("keeps line-item order material", async () => {
    // Arrays keep their order, because the order of line items is meaningful.
    const a = input({ lineItems: [{ id: "a", label: "A", quantity: 1 }, { id: "b", label: "B", quantity: 1 }] });
    const b = input({ lineItems: [{ id: "b", label: "B", quantity: 1 }, { id: "a", label: "A", quantity: 1 }] });
    expect(fingerprintIntake(a)).not.toBe(fingerprintIntake(b));
  });
});

describe("concurrent duplicates create one work order", () => {
  it("joins two simultaneous calls onto one result", async () => {
    const log = createInMemoryEventLog();
    const create = useCase({ eventLog: log });

    const [first, second] = await Promise.all([
      create.execute(input(), actor, claim),
      create.execute(input(), actor, claim),
    ]);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.workOrderId).toBe(first.draft.workOrderId);

    const created = await log.listByType("work_order.intake.created");
    expect(created).toHaveLength(1);
  });

  it("holds under a burst of ten", async () => {
    const log = createInMemoryEventLog();
    const create = useCase({ eventLog: log });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => create.execute(input(), actor, claim)),
    );

    const ids = new Set(results.filter((r) => r.ok).map((r) => (r.ok ? r.draft.workOrderId : "")));
    expect(ids.size).toBe(1);
    expect(await log.listByType("work_order.intake.created")).toHaveLength(1);
  });
});

describe("claims obey tenant boundaries", () => {
  it("lets two tenants use the same key string", async () => {
    // Correct: the key is scoped to a tenant. One tenant reusing its own key
    // gets one work order; two tenants using the same string get two.
    const create = useCase();
    const ksix = await create.execute(input(), actor, { organizationId: "ksix", key: "order-388" });
    const other = await create.execute(input(), actor, { organizationId: "other-shop", key: "order-388" });

    expect(ksix.ok && other.ok).toBe(true);
    if (!ksix.ok || !other.ok) return;
    expect(other.draft.workOrderId).not.toBe(ksix.draft.workOrderId);
  });

  it("does not resolve one tenant's key from another's claim", async () => {
    const store = createInMemoryIdempotencyStore();
    const create = useCase({ idempotencyStore: store });
    await create.execute(input(), actor, { organizationId: "ksix", key: "k" });

    expect(await store.get("ksix", "k")).not.toBeNull();
    expect(await store.get("other-shop", "k")).toBeNull();
  });
});

describe("the store is a port, so persistence is the host's", () => {
  it("refuses a key when no store is configured", async () => {
    // A caller that passed a key and silently got no guarantee is worse off
    // than one that got an error.
    const create = createCreateWorkOrderUseCase({
      eventLog: createInMemoryEventLog(),
      workOrderIdGenerator: () => "wo_1",
    });
    const result = await create.execute(input(), actor, claim);
    expect(result.ok).toBe(false);
    if (result.ok || !("conflict" in result)) throw new Error("expected a conflict");
    expect(result.conflict.message).toContain("no idempotencyStore is configured");
  });

  it("survives a restart when the store does", async () => {
    // The store is host-supplied exactly as StockLedger and EventLog are, so
    // "survives restart" means "bind a durable one". A store that outlives the
    // use case demonstrates the property without inventing a database here.
    const store = createInMemoryIdempotencyStore();

    const before = createCreateWorkOrderUseCase({
      eventLog: createInMemoryEventLog(),
      workOrderIdGenerator: () => "wo_original",
      clock: () => new Date("2026-08-29T10:00:00.000Z"),
      idempotencyStore: store,
    });
    const first = await before.execute(input(), actor, claim);

    // A completely new use case, new event log, new id generator — the process
    // restarted. Only the store survived.
    const after = createCreateWorkOrderUseCase({
      eventLog: createInMemoryEventLog(),
      workOrderIdGenerator: () => "wo_would_be_new",
      clock: () => new Date("2026-08-29T11:00:00.000Z"),
      idempotencyStore: store,
    });
    const second = await after.execute(input(), actor, claim);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.workOrderId).toBe("wo_original");
    expect(second.replayed).toBe(true);
  });

  it("claims atomically", async () => {
    // The contract the port must honour. A host implementation that checks and
    // inserts in two round trips reopens the window this closes.
    const store: IdempotencyStore = createInMemoryIdempotencyStore();
    const record: IdempotencyRecord = {
      organizationId: "ksix",
      key: "k",
      workOrderId: "wo_1",
      fingerprint: "f",
      claimedAt: "2026-08-29T10:00:00.000Z",
    };

    const [a, b] = await Promise.all([
      store.claim(record),
      store.claim({ ...record, workOrderId: "wo_2" }),
    ]);

    const winners = [a, b].filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((r) => !r.claimed);
    expect(loser && !loser.claimed && loser.existing.workOrderId).toBe("wo_1");
  });
});

describe("a rejected payload does not burn the key", () => {
  it("lets a corrected retry use the same key", async () => {
    // Otherwise a caller who fixed their data and retried would conflict
    // against a work order that was never created.
    const create = useCase();
    const bad = await create.execute(input({ lineItems: [] }), actor, claim);
    expect(bad.ok).toBe(false);

    const good = await create.execute(input(), actor, claim);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.replayed).toBeUndefined();
  });
});
