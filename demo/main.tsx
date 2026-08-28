// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { StrictMode, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  BRAND,
  BRAND_COLORS,
  brandVars,
  computeHiveLayout,
  createAlertRegistry,
  createEngineRegistry,
  createHeartbeatCollector,
  createVisualizationAdapter,
  createVisualizationBudget,
  computeSystemHealth,
  deriveEngineHealth,
  deriveOperationalState,
  formatScore,
  heartbeatCaveat,
  navLabel,
  summariseFleet,
  TYPOGRAPHY,
  type Alert,
  type EngineHealth,
  type ObservedHeartbeat,
} from "../packages/control-plane/src/core/index.js";
import { SUITE_MANIFESTS } from "../packages/control-plane/src/manifests/index.js";
import {
  ConsoleStyles,
  EngineActivityProvider,
  EngineStatusBadge,
  EngineVisual,
  HiveBoard,
  HiveCell,
  MotionProvider,
  MotionToggle,
  resolvePalette,
} from "../packages/control-plane/src/react/index.js";
import { createSimulator, type SimulatedEvent } from "./simulator.js";

// ─────────────────────────────────────────────────────────────────────────────
// A harness, not the console.
//
// Every box below is the real component, fed by the real adapter, the real
// heartbeat collector, the real health derivation and the real alert registry.
// The only thing that is not real is the event source — no engine emits
// telemetry yet, so `simulator.ts` stands in for the bus.
//
// It says so at the top of the screen, permanently and in the loudest colour on
// the page, because a demo that looks like a live console is how a screenshot
// ends up in a deck as evidence of uptime.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One emitter for the whole harness.
 *
 * Module level rather than a ref inside the component, because the activity
 * provider mounts ABOVE the component that produces events and needs a stable
 * `subscribe` at mount. A ref inside would give the provider an empty set it
 * keeps forever, and every pulse would be delivered to nobody.
 */
const visualListeners = new Set<(event: never) => void>();
function subscribeToVisuals(handler: (event: never) => void): () => void {
  visualListeners.add(handler);
  return () => visualListeners.delete(handler);
}

const registry = createEngineRegistry(SUITE_MANIFESTS);
const layout = computeHiveLayout(registry, { includeServices: false });
const adapter = createVisualizationAdapter(SUITE_MANIFESTS);
const budget = createVisualizationBudget({ maxEffectsPerEnginePerSecond: 10 });

// Faster than production so a fault becomes an alert while somebody is
// watching. Production waits a minute; nobody demos for a minute.
const alerts = createAlertRegistry({
  openAfterMs: 4_000,
  resolveAfterMs: 8_000,
  latencyThresholdMs: 5_000,
  queueBacklogThreshold: 500,
});

const collector = createHeartbeatCollector({
  manifests: SUITE_MANIFESTS,
  windowMs: 120_000,
  versions: {
    prime: "3.2.0", forgeiq: "2.1.4", costiq: "1.8.2", visioniq: "1.6.0",
    workorderiq: "2.0.1", receiptiq: "1.4.0", inventoryiq: "1.2.3",
    "order-ingestion": "0.9.4",
  },
});

function App() {
  const [health, setHealth] = useState<EngineHealth[]>([]);
  const [beats, setBeats] = useState<Record<string, ObservedHeartbeat | undefined>>({});
  const [active, setActive] = useState<Alert[]>([]);
  const [faulted, setFaulted] = useState<string | null>(null);
  const [lastEvents, setLastEvents] = useState<Record<string, { eventType: string; at: string }>>({});
  const [feed, setFeed] = useState<SimulatedEvent[]>([]);

  const simulator = useMemo(
    () =>
      createSimulator({
        manifests: SUITE_MANIFESTS,
        onFaultChange: setFaulted,
        emit(event) {
          collector.observe(event);
          setLastEvents((prev) => ({
            ...prev,
            [event.source.service]: { eventType: event.eventType, at: event.occurredAt },
          }));
          setFeed((prev) => [event, ...prev].slice(0, 12));

          const visual = adapter.translate(event);
          if (!visual) return;
          const admitted = budget.admit(visual);
          if (!admitted) return;
          for (const listener of visualListeners) (listener as (v: unknown) => void)(admitted);
        },
      }),
    [],
  );

  useEffect(() => {
    simulator.start();
    const interval = setInterval(() => {
      const now = Date.now();
      const snapshot = collector.snapshot();
      const byId: Record<string, ObservedHeartbeat | undefined> = {};
      for (const beat of snapshot) byId[beat.engineId] = beat;

      const derived = registry.engines.map((manifest) =>
        deriveEngineHealth(manifest.id, byId[manifest.id], { now }),
      );
      setBeats(byId);
      setHealth(derived);
      alerts.apply(derived, byId, now);
      setActive(alerts.active());
    }, 1_000);

    return () => {
      simulator.stop();
      clearInterval(interval);
    };
  }, [simulator]);

  const fleet = summariseFleet(health);
  const score = computeSystemHealth(health, { latencyBudgetMs: 2_000 });
  const healthById = Object.fromEntries(health.map((h) => [h.engineId, h]));

  return (
    <div
      style={{
        ...brandVars(),
        minHeight: "100vh",
        background: `radial-gradient(1200px 700px at 50% 0%, #0a1424 0%, ${BRAND_COLORS.background} 60%)`,
        color: BRAND_COLORS.text,
        ...TYPOGRAPHY.body,
      }}
    >
      <ConsoleStyles />

      <SimulationBanner faulted={faulted} />

      <header
        style={{
          display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
          padding: "16px 22px", borderBottom: `1px solid ${BRAND_COLORS.border}`,
        }}
      >
        <HiveMark />
        <div>
          <div style={{ ...TYPOGRAPHY.display, fontSize: 17, lineHeight: 1.15 }}>
            PROWORKS <span style={{ color: BRAND_COLORS.primaryBright }}>HIVE</span>
          </div>
          <div style={{ ...TYPOGRAPHY.display, fontSize: 9, opacity: 0.6, letterSpacing: "0.34em" }}>
            {BRAND.tier}
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ textAlign: "right" }}>
            <Label>System health</Label>
            <div style={{ ...TYPOGRAPHY.metric, fontSize: 20 }}>{formatScore(score.overall)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <Label>Engines online</Label>
            <div style={{ ...TYPOGRAPHY.metric, fontSize: 20 }}>
              {fleet.online} / {fleet.total}
            </div>
          </div>
          <MotionToggle />
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2.1fr) minmax(300px, 1fr)", gap: 20, padding: 20 }}>
        <section>
          <SectionHeading
            title="Engine Hive"
            note="Each engine is a node. Positions are computed; edges are the manifests' own event mappings."
          />
          <div style={{ position: "relative", maxWidth: 780, margin: "0 auto" }}>
            <HiveBoard
              layout={layout}
              health={healthById}
              nodeScale={0.3}
              renderNode={(node, engineHealth) => {
                const state = engineHealth?.state ?? "unknown";
                const operational = deriveOperationalState({
                  manifest: node.manifest,
                  health:
                    engineHealth ?? deriveEngineHealth(node.engineId, undefined, { now: Date.now() }),
                  lastEvent: lastEvents[node.engineId],
                  now: Date.now(),
                });
                return (
                  <HiveCell
                    colorToken={node.manifest.colorToken}
                    attention={engineHealth?.descriptor.demandsAttention ?? true}
                  >
                    <div style={{ textAlign: "center" }}>
                      <div style={{ ...TYPOGRAPHY.display, fontSize: 10 }}>{node.manifest.name}</div>
                      <EngineVisual
                        manifest={node.manifest}
                        state={state}
                        reason={engineHealth?.reason}
                        height={62}
                      />
                      <EngineStatusBadge state={state} reason={engineHealth?.reason} compact />
                      <div style={{ ...TYPOGRAPHY.metric, fontSize: 9, opacity: 0.65, marginTop: 3 }}>
                        {operational.label}
                      </div>
                    </div>
                  </HiveCell>
                );
              }}
            />
          </div>
        </section>

        <aside style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <Panel title={`Alerts (${active.length})`}>
            {active.length === 0 ? (
              <Muted>Nothing open. Break an engine below to watch one fire.</Muted>
            ) : (
              active.map((alert) => (
                <div key={alert.alertId} style={{ marginBottom: 10 }}>
                  <EngineStatusBadge
                    state={alert.severity === "critical" ? "failed" : "warning"}
                    compact
                  />
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    <strong>{alert.source}</strong> — {alert.kind}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>{alert.reason}</div>
                </div>
              ))
            )}
          </Panel>

          <Panel title="Break something">
            <Muted>
              A faulted engine publishes its own alert event, so the fault reaches health through the
              same path a real failure would.
            </Muted>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {registry.engines.map((manifest) => (
                <button
                  key={manifest.id}
                  onClick={() => simulator.setFault(faulted === manifest.id ? null : manifest.id)}
                  style={{
                    ...TYPOGRAPHY.display,
                    fontSize: 9,
                    padding: "4px 7px",
                    cursor: "pointer",
                    background: faulted === manifest.id ? resolvePalette(manifest.colorToken).base : "transparent",
                    color: faulted === manifest.id ? "#04070d" : BRAND_COLORS.textMuted,
                    border: `1px solid ${resolvePalette(manifest.colorToken).base}66`,
                    borderRadius: 3,
                  }}
                >
                  {manifest.name}
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Event stream">
            {feed.map((event) => {
              const manifest = registry.get(event.source.service);
              return (
                <div key={event.eventId} style={{ ...TYPOGRAPHY.metric, fontSize: 10, display: "flex", gap: 8 }}>
                  <span style={{ opacity: 0.5 }}>{event.occurredAt.slice(11, 19)}</span>
                  <span style={{ color: resolvePalette(manifest?.colorToken ?? "service-slate").base, minWidth: 96 }}>
                    {manifest?.name ?? event.source.service}
                  </span>
                  <span style={{ opacity: 0.8 }}>{event.eventType}</span>
                </div>
              );
            })}
            <Muted style={{ marginTop: 8 }}>
              Payloads carry customer fields and are never shown here — inspecting one is a separate,
              permissioned action that redacts before it renders.
            </Muted>
          </Panel>
        </aside>
      </div>

      <section style={{ padding: "0 20px 30px" }}>
        <SectionHeading title="Engine states" note="Real derivation: health from heartbeats, activity from the last mapped event." />
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", ...TYPOGRAPHY.metric, fontSize: 11 }}>
            <thead>
              <tr style={{ textAlign: "left", ...TYPOGRAPHY.display, fontSize: 9, opacity: 0.55 }}>
                {["Engine", "Health", "State", "Throughput", "Errors", "Version", "Last event", "Source"].map((head) => (
                  <th key={head} style={{ padding: "7px 10px", borderBottom: `1px solid ${BRAND_COLORS.border}` }}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {registry.engines.map((manifest) => {
                const engineHealth =
                  healthById[manifest.id] ?? deriveEngineHealth(manifest.id, undefined, { now: Date.now() });
                const beat = beats[manifest.id];
                const operational = deriveOperationalState({
                  manifest, health: engineHealth, lastEvent: lastEvents[manifest.id], now: Date.now(),
                });
                return (
                  <tr key={manifest.id} style={{ borderBottom: `1px solid ${BRAND_COLORS.border}55` }}>
                    <td style={{ padding: "7px 10px", color: resolvePalette(manifest.colorToken).base }}>
                      {navLabel(manifest)}
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <EngineStatusBadge state={engineHealth.state} reason={engineHealth.reason} compact />
                    </td>
                    <td style={{ padding: "7px 10px" }}>{operational.label}</td>
                    <td style={{ padding: "7px 10px" }}>{beat?.jobsProcessed ?? "—"}</td>
                    <td style={{ padding: "7px 10px" }}>{beat?.jobsFailed ?? "—"}</td>
                    <td style={{ padding: "7px 10px" }}>{beat?.version ?? "—"}</td>
                    <td style={{ padding: "7px 10px", opacity: 0.75 }}>
                      {lastEvents[manifest.id]?.eventType ?? "—"}
                    </td>
                    <td style={{ padding: "7px 10px", opacity: 0.6 }} title={heartbeatCaveat(beat)}>
                      {beat?.source ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Muted style={{ marginTop: 8 }}>
          “derived” means the heartbeat was inferred from published events rather than reported by the
          engine. A derived heartbeat cannot tell an idle engine from a stopped one, which is why the
          distinction is a column rather than a footnote.
        </Muted>
        {score.unmeasured.length > 0 && (
          <Muted style={{ marginTop: 6 }}>
            Not measured, and therefore not scored: {score.unmeasured.join(", ")}.
          </Muted>
        )}
      </section>
    </div>
  );
}

function SimulationBanner({ faulted }: { faulted: string | null }) {
  return (
    <div
      style={{
        ...TYPOGRAPHY.display,
        fontSize: 10,
        padding: "7px 22px",
        background: "#3d2a05",
        borderBottom: "1px solid #a97a12",
        color: "#ffd479",
        display: "flex",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      <span>⚠ Simulated telemetry — demo harness, not a live console</span>
      <span style={{ opacity: 0.75, textTransform: "none", letterSpacing: 0, ...TYPOGRAPHY.body, fontSize: 11 }}>
        Components, adapter, health, states and alerts are the real ones. Only the event source is
        fake, because no engine emits telemetry yet.
      </span>
      {faulted && <span style={{ marginLeft: "auto", color: "#ff9d9d" }}>fault injected: {faulted}</span>}
    </div>
  );
}

/** The hive mark: seven cells, matching the ring the dashboard actually draws. */
function HiveMark() {
  const cells = [
    [0, 0], [0, -1], [0.87, -0.5], [0.87, 0.5], [0, 1], [-0.87, 0.5], [-0.87, -0.5],
  ];
  return (
    <svg width={38} height={38} viewBox="-2 -2 4 4" aria-label="ProWorks Hive">
      {cells.map(([x, y], i) => (
        <polygon
          key={i}
          points={Array.from({ length: 6 }, (_, k) => {
            const angle = (Math.PI / 3) * k - Math.PI / 2;
            return `${x! + Math.cos(angle) * 0.5},${y! + Math.sin(angle) * 0.5}`;
          }).join(" ")}
          fill={i === 0 ? BRAND_COLORS.primary : "none"}
          stroke={BRAND_COLORS.primary}
          strokeWidth={0.07}
          opacity={i === 0 ? 1 : 0.55}
        />
      ))}
    </svg>
  );
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...TYPOGRAPHY.display, fontSize: 12 }}>{title}</div>
      <div style={{ fontSize: 11, opacity: 0.55 }}>{note}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        background: BRAND_COLORS.surface,
        border: `1px solid ${BRAND_COLORS.border}`,
        borderRadius: 6,
        padding: 14,
      }}
    >
      <div style={{ ...TYPOGRAPHY.display, fontSize: 10, marginBottom: 9, opacity: 0.75 }}>{title}</div>
      {children}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div style={{ ...TYPOGRAPHY.display, fontSize: 8, opacity: 0.5 }}>{children}</div>;
}

function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 11, opacity: 0.55, ...style }}>{children}</div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionProvider>
      <EngineActivityProvider subscribe={subscribeToVisuals}>
        <App />
      </EngineActivityProvider>
    </MotionProvider>
  </StrictMode>,
);
