// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  EVENT_TYPES,
  PermanentError,
  TransientError,
  backoffDelayMs,
  isTransient,
  newCorrelationId,
  type PlatformEvent,
} from "@proworks-hub/contracts";
import {
  createInMemoryDeadLetterQueue,
  deliverWithResilience,
} from "../resilientDelivery.js";
import { createInMemoryEventBus } from "../inMemoryEventBus.js";

const event = (): PlatformEvent => ({
  eventId: "evt_1",
  eventType: EVENT_TYPES.receiptIngested,
  eventVersion: 1,
  occurredAt: "2026-08-27T00:00:00.000Z",
  publishedAt: "2026-08-27T00:00:00.000Z",
  source: { service: "receiptiq" },
  trace: { correlationId: "cor_1" },
  payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
});

/** No real waiting; the backoff arithmetic is tested separately. */
const noSleep = () => Promise.resolve();

describe("classifying failures", () => {
  it("treats an explicit permanent error as permanent", () => {
    expect(isTransient(new PermanentError("payload will never validate"))).toBe(false);
  });

  it("treats an explicit transient error as transient", () => {
    expect(isTransient(new TransientError("broker unreachable"))).toBe(true);
  });

  it("treats validation failures as permanent without being told", () => {
    const zodish = new Error("invalid");
    zodish.name = "ZodError";
    expect(isTransient(zodish)).toBe(false);
    expect(isTransient(new TypeError("x is not a function"))).toBe(false);
  });

  it("defaults an unknown error to transient", () => {
    // Guessing permanent loses work that would have succeeded next attempt.
    // Guessing transient costs a few retries and dead-letters it anyway.
    expect(isTransient(new Error("something odd"))).toBe(true);
  });
});

describe("backoff", () => {
  it("grows exponentially", () => {
    const fixed = () => 0.5; // no jitter offset
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 100, jitter: 0 };
    expect(backoffDelayMs(1, policy, fixed)).toBe(100);
    expect(backoffDelayMs(2, policy, fixed)).toBe(200);
    expect(backoffDelayMs(3, policy, fixed)).toBe(400);
  });

  it("respects the ceiling, so a backoff does not become an outage", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, maxDelayMs: 3000, jitter: 0 };
    expect(backoffDelayMs(10, policy, () => 0.5)).toBe(3000);
  });

  it("spreads retries so everything that failed together does not return together", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, jitter: 0.5 };
    const low = backoffDelayMs(1, policy, () => 0);
    const high = backoffDelayMs(1, policy, () => 1);
    expect(low).toBeLessThan(high);
  });
});

describe("delivery", () => {
  it("succeeds first time without retrying", async () => {
    const handler = vi.fn();
    const outcome = await deliverWithResilience(event(), "c", handler, { sleep: noSleep });
    expect(outcome).toMatchObject({ delivered: true, attempts: 1 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("retries a transient failure and can still succeed", async () => {
    let calls = 0;
    const handler = () => {
      calls += 1;
      if (calls < 3) throw new TransientError("broker blip");
    };
    const outcome = await deliverWithResilience(event(), "c", handler, { sleep: noSleep });
    expect(outcome).toMatchObject({ delivered: true, attempts: 3 });
  });

  it("does NOT retry a permanent failure", async () => {
    const handler = vi.fn(() => {
      throw new PermanentError("this payload will never validate");
    });
    const dlq = createInMemoryDeadLetterQueue();
    const outcome = await deliverWithResilience(event(), "c", handler, {
      sleep: noSleep,
      deadLetters: dlq,
    });
    // Retrying it would burn the budget the transient failures behind it need.
    expect(handler).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ delivered: false, attempts: 1, deadLettered: true });
  });

  it("gives up after the attempt budget and dead-letters", async () => {
    const dlq = createInMemoryDeadLetterQueue();
    const handler = vi.fn(() => {
      throw new TransientError("still down");
    });
    const outcome = await deliverWithResilience(event(), "inventory", handler, {
      sleep: noSleep,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
      deadLetters: dlq,
    });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(outcome.deadLettered).toBe(true);
    expect(dlq.size()).toBe(1);
  });

  it("converts a hanging handler into an ordinary transient failure", async () => {
    const dlq = createInMemoryDeadLetterQueue();
    const outcome = await deliverWithResilience(
      event(),
      "c",
      () => new Promise<void>(() => {}), // never resolves
      {
        sleep: noSleep,
        handlerTimeoutMs: 10,
        retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 },
        deadLetters: dlq,
      },
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.error?.message).toMatch(/exceeded 10ms/);
  });
});

describe("dead letters", () => {
  it("keep everything an operator needs to act", async () => {
    const dlq = createInMemoryDeadLetterQueue();
    await deliverWithResilience(
      event(),
      "costiq-price-history",
      () => {
        throw new PermanentError("unknown material reference");
      },
      { sleep: noSleep, deadLetters: dlq },
    );

    const [letter] = (await dlq.list()) as Awaited<ReturnType<typeof dlq.list>>;
    expect(letter).toMatchObject({
      eventId: "evt_1",
      eventType: EVENT_TYPES.receiptIngested,
      consumer: "costiq-price-history",
      attempts: 1,
      classification: "permanent",
      errorName: "PermanentError",
    });
    expect(letter!.reason).toMatch(/unknown material reference/);
    // The correlation survives, so a dead letter ties back to the work.
    expect(letter!.trace.correlationId).toBe("cor_1");
    // And the original event is kept whole, so it can be replayed unchanged.
    expect((letter!.event as PlatformEvent).payload).toEqual(event().payload);
  });

  it("can be filtered and resolved once a human has dealt with them", async () => {
    const dlq = createInMemoryDeadLetterQueue();
    const fail = (consumer: string) =>
      deliverWithResilience(event(), consumer, () => { throw new PermanentError("no"); }, {
        sleep: noSleep,
        deadLetters: dlq,
      });
    await fail("a");
    await fail("b");

    expect(await dlq.list({ consumer: "a" })).toHaveLength(1);
    const [letter] = (await dlq.list({ consumer: "a" })) as Awaited<ReturnType<typeof dlq.list>>;
    await dlq.resolve(letter!.deadLetterId);
    expect(dlq.size()).toBe(1);
  });
});

describe("the bus with resilience enabled", () => {
  it("dead-letters a consumer that keeps failing, and still serves the others", async () => {
    const dlq = createInMemoryDeadLetterQueue();
    const healthy = vi.fn();
    const bus = createInMemoryEventBus({
      resilience: {
        sleep: noSleep,
        deadLetters: dlq,
        retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 },
      },
    });

    bus.subscribe("*", () => { throw new TransientError("down"); }, { consumer: "broken" });
    bus.subscribe("*", healthy, { consumer: "healthy" });

    await bus.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source: { service: "receiptiq" },
      tenant: { organizationId: "acme", roles: [] },
      trace: { correlationId: newCorrelationId() },
      payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
    });

    expect(healthy).toHaveBeenCalledOnce();
    expect(dlq.size()).toBe(1);
    expect(bus.failures()).toHaveLength(1);
  });
});
