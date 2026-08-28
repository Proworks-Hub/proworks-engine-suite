// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineManifest } from "../packages/control-plane/src/core/manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// A stand-in for the platform event bus.
//
// This is the ONLY fake thing in the harness. It produces platform events in
// the real envelope shape, using event types the manifests actually declare,
// and hands them to the real adapter, the real heartbeat collector, the real
// health derivation and the real alert registry.
//
// It exists because no engine emits telemetry yet. When they do, this file is
// deleted and a subscription replaces it — nothing downstream changes, which is
// the point of the port being a port.
//
// The banner in the UI says this out loud. A demo that looks like a live
// console is how a screenshot ends up in a deck as evidence of uptime.
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulatedEvent {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  publishedAt: string;
  source: { service: string };
  trace: { correlationId: string; traceId: string };
  aggregate?: { type: string; id: string };
  payload: Record<string, unknown>;
}

let sequence = 0;

/**
 * One realistic run of work through the ecosystem.
 *
 * Ordered the way the manifests say it flows — an order arrives, Prime routes
 * it, ForgeIQ plans, CostIQ prices — so the hive animates along edges that
 * genuinely exist rather than at random.
 */
const FLOW: Array<{ service: string; eventType: string; gapMs: number }> = [
  { service: "order-ingestion", eventType: "shop.order.received", gapMs: 0 },
  { service: "order-ingestion", eventType: "shop.order.deduplicated", gapMs: 60 },
  { service: "order-ingestion", eventType: "shop.order.product.resolved", gapMs: 90 },
  { service: "order-ingestion", eventType: "shop.order.normalized", gapMs: 120 },
  { service: "prime", eventType: "workflow.started", gapMs: 40 },
  { service: "prime", eventType: "manufacturing.request.routed", gapMs: 60 },
  { service: "visioniq", eventType: "artwork.submitted", gapMs: 110 },
  { service: "visioniq", eventType: "artwork.scanned", gapMs: 260 },
  { service: "visioniq", eventType: "artwork.prepared", gapMs: 300 },
  { service: "forgeiq", eventType: "configurator.rules.evaluated", gapMs: 90 },
  { service: "forgeiq", eventType: "manufacturability.checked", gapMs: 140 },
  { service: "forgeiq", eventType: "manufacturing.plan.generated", gapMs: 220 },
  { service: "costiq", eventType: "cost.calculation.completed", gapMs: 180 },
  { service: "inventoryiq", eventType: "inventory.availability.checked", gapMs: 90 },
  { service: "inventoryiq", eventType: "inventory.reserved", gapMs: 70 },
  { service: "workorderiq", eventType: "work.order.created", gapMs: 130 },
  { service: "workorderiq", eventType: "work.order.step.completed", gapMs: 400 },
  { service: "tracking", eventType: "shipment.dispatched", gapMs: 300 },
];

/** Occasional independent traffic, so the hive is not one lockstep parade. */
const BACKGROUND: Array<{ service: string; eventType: string }> = [
  { service: "receiptiq", eventType: "receipt.ingested" },
  { service: "receiptiq", eventType: "receipt.normalized" },
  { service: "receiptiq", eventType: "material.purchase.detected" },
  { service: "costiq", eventType: "cost.variance.evaluated" },
  { service: "inventoryiq", eventType: "inventory.level.changed" },
  { service: "prime", eventType: "workflow.step.awaiting" },
  { service: "visioniq", eventType: "vision.correction.captured" },
  { service: "ai-intelligence", eventType: "model.request.completed" },
  { service: "notifications", eventType: "notification.sent" },
];

function makeEvent(
  service: string,
  eventType: string,
  correlationId: string,
): SimulatedEvent {
  sequence += 1;
  const at = new Date().toISOString();
  return {
    eventId: `sim-${sequence}`,
    eventType,
    eventVersion: 1,
    occurredAt: at,
    publishedAt: at,
    source: { service },
    trace: { correlationId, traceId: correlationId },
    aggregate: { type: "order", id: correlationId },
    // Deliberately carries customer-shaped fields, so the redaction in the
    // trace view has something real to refuse to show.
    payload: {
      orderId: correlationId,
      customerName: "Jane Doe",
      shippingAddress: { line1: "1 High Street", postcode: "AB1 2CD" },
      lines: [{ sku: "SKU-4KX9M2QD", qty: 2, widthIn: 24 }],
    },
  };
}

export interface SimulatorOptions {
  manifests: readonly EngineManifest[];
  emit(event: SimulatedEvent): void;
  /** Fires when a simulated fault is toggled, so the UI can label it. */
  onFaultChange?(engineId: string | null): void;
}

export interface Simulator {
  start(): void;
  stop(): void;
  /** Break an engine on purpose, to show degradation and alerting. */
  setFault(engineId: string | null): void;
  faultedEngine(): string | null;
}

export function createSimulator(options: SimulatorOptions): Simulator {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;
  let faulted: string | null = null;

  const alertTypeFor = (engineId: string): string | undefined =>
    options.manifests
      .find((m) => m.id === engineId)
      ?.eventMappings.find((m) => m.effect === "alert")?.eventType;

  const runFlow = (): void => {
    if (!running) return;
    const correlationId = `ord-${Math.random().toString(36).slice(2, 8)}`;
    let delay = 0;
    for (const step of FLOW) {
      delay += step.gapMs;
      timers.push(
        setTimeout(() => {
          if (!running) return;
          // A faulted engine publishes its own alert event instead of its
          // normal one. That is how the fault reaches health: through the same
          // path a real failure would take, not by setting a status field.
          if (faulted === step.service) {
            const alertType = alertTypeFor(step.service);
            if (alertType) {
              options.emit(makeEvent(step.service, alertType, correlationId));
              return;
            }
          }
          options.emit(makeEvent(step.service, step.eventType, correlationId));
        }, delay),
      );
    }
    timers.push(setTimeout(runFlow, delay + 600 + Math.random() * 900));
  };

  const runBackground = (): void => {
    if (!running) return;
    const pick = BACKGROUND[Math.floor(Math.random() * BACKGROUND.length)]!;
    options.emit(makeEvent(pick.service, pick.eventType, `bg-${Math.random().toString(36).slice(2, 8)}`));
    timers.push(setTimeout(runBackground, 250 + Math.random() * 700));
  };

  return {
    start() {
      if (running) return;
      running = true;
      runFlow();
      runBackground();
    },
    stop() {
      running = false;
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    },
    setFault(engineId) {
      faulted = engineId;
      options.onFaultChange?.(engineId);
    },
    faultedEngine() {
      return faulted;
    },
  };
}
