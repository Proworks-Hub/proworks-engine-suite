// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { motionStyle } from "../motion.js";
import { activityLevel, idleDuration, type EngineSceneProps } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engines, drawn.
//
// Each has its own object, its own geometry and its own way of moving, so an
// operator recognises one across a room. They share a box, a palette mechanism
// and a motion vocabulary, so they still look like one product.
//
// Colour comes from `var(--engine-base)` and friends, set by the card. No scene
// knows which engine it is drawing, which is what makes them interchangeable.
// ─────────────────────────────────────────────────────────────────────────────

const CENTRE_X = 100;
const CENTRE_Y = 60;

/**
 * The activity overlay every scene shares.
 *
 * One expanding ring per real event. Nothing here runs on a timer: no event, no
 * ring. That equivalence is the reason to trust the console at a glance, and it
 * is why these are keyed by the pulse rather than driven by an interval.
 */
function Pulses({ props, x = CENTRE_X, y = CENTRE_Y }: { props: EngineSceneProps; x?: number; y?: number }) {
  if (props.motion.reducedMotion) return null;
  return (
    <>
      {props.activity.pulses.map((pulse) => (
        <circle
          key={pulse.key}
          cx={x}
          cy={y}
          r={10 + pulse.intensity * 12}
          fill="none"
          stroke={pulse.effect === "alert" ? "var(--engine-status)" : "var(--engine-bright)"}
          strokeWidth={pulse.effect === "alert" ? 2 : 1.2}
          style={{
            transformOrigin: `${x}px ${y}px`,
            ...motionStyle(props.motion, "pw-pulse 1.4s ease-out forwards"),
          }}
        />
      ))}
    </>
  );
}

/**
 * What the scene shows instead of motion when motion is not allowed.
 *
 * §9: reduced motion removes movement, never information. A static arc, filled
 * in proportion to recent throughput, says what the moving version said.
 */
function StaticActivity({ props }: { props: EngineSceneProps }) {
  if (!props.motion.reducedMotion || props.activity.recentCount === 0) return null;
  const fraction = Math.max(0.04, props.activity.level);
  const circumference = 2 * Math.PI * 46;
  return (
    <g aria-hidden="true">
      <circle
        cx={CENTRE_X}
        cy={CENTRE_Y}
        r={46}
        fill="none"
        stroke="var(--engine-dim)"
        strokeWidth={2}
      />
      <circle
        cx={CENTRE_X}
        cy={CENTRE_Y}
        r={46}
        fill="none"
        stroke="var(--engine-bright)"
        strokeWidth={2}
        strokeDasharray={`${circumference * fraction} ${circumference}`}
        transform={`rotate(-90 ${CENTRE_X} ${CENTRE_Y})`}
      />
    </g>
  );
}

// ── Prime: an orchestrator, visibly delegating ───────────────────────────────

export function OrchestrationCoreScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  // Six spokes rather than a busy machine at the centre. Prime routes; a scene
  // that showed it grinding away would misdescribe the architecture to anyone
  // learning the system from this screen.
  const spokes = Array.from({ length: 6 }, (_, i) => (i * Math.PI) / 3);

  return (
    <g>
      {spokes.map((angle, i) => {
        const x = CENTRE_X + Math.cos(angle) * 74;
        const y = CENTRE_Y + Math.sin(angle) * 42;
        return (
          <g key={i}>
            <line x1={CENTRE_X} y1={CENTRE_Y} x2={x} y2={y} stroke="var(--engine-dim)" strokeWidth={1} />
            <circle
              cx={x}
              cy={y}
              r={3}
              fill="var(--engine-base)"
              opacity={0.35 + level * 0.5}
              style={motionStyle(props.motion, `pw-breathe ${idleDuration(props.idle, 3 + i * 0.4)} ease-in-out infinite`)}
            />
          </g>
        );
      })}

      {[34, 25, 17].map((r, i) => (
        <circle
          key={r}
          cx={CENTRE_X}
          cy={CENTRE_Y}
          r={r}
          fill="none"
          stroke="var(--engine-base)"
          strokeWidth={1}
          strokeDasharray={i === 1 ? "5 7" : "3 9"}
          opacity={0.5}
          style={{
            transformOrigin: `${CENTRE_X}px ${CENTRE_Y}px`,
            ...motionStyle(
              props.motion,
              `${i % 2 === 0 ? "pw-spin" : "pw-spin-reverse"} ${idleDuration(props.idle, 18 + i * 6)} linear infinite`,
            ),
          }}
        />
      ))}

      <circle cx={CENTRE_X} cy={CENTRE_Y} r={9} fill="var(--engine-dim)" stroke="var(--engine-base)" strokeWidth={1.5} />
      <circle
        cx={CENTRE_X}
        cy={CENTRE_Y}
        r={4}
        fill="var(--engine-bright)"
        opacity={0.6 + level * 0.4}
        style={motionStyle(props.motion, `pw-breathe ${idleDuration(props.idle, 2.6)} ease-in-out infinite`)}
      />
      <StaticActivity props={props} />
      <Pulses props={props} />
    </g>
  );
}

// ── ForgeIQ: a fabrication cell ──────────────────────────────────────────────

export function FabricationCellScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const working = props.activity.pulses.length > 0;

  return (
    <g>
      <rect x={52} y={86} width={96} height={4} fill="var(--engine-dim)" />
      <rect x={70} y={74} width={60} height={12} fill="var(--engine-dim)" stroke="var(--engine-base)" strokeWidth={1} />

      {/* Small, deliberate movement. A robot arm swinging across the card would
          be a cartoon; a few degrees of travel reads as a machine working. */}
      <g
        style={{
          transformOrigin: "60px 82px",
          ...motionStyle(props.motion, `pw-rise ${idleDuration(props.idle, 5)} ease-in-out infinite`),
        }}
      >
        <rect x={54} y={78} width={12} height={8} fill="var(--engine-base)" opacity={0.7} />
        <line x1={60} y1={78} x2={78} y2={44} stroke="var(--engine-base)" strokeWidth={4} strokeLinecap="round" />
        <line x1={78} y1={44} x2={104} y2={40} stroke="var(--engine-base)" strokeWidth={3.5} strokeLinecap="round" />
        <line x1={104} y1={40} x2={112} y2={54} stroke="var(--engine-bright)" strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={78} cy={44} r={3} fill="var(--engine-dim)" stroke="var(--engine-base)" strokeWidth={1.2} />
        <circle cx={104} cy={40} r={2.5} fill="var(--engine-dim)" stroke="var(--engine-base)" strokeWidth={1.2} />
      </g>

      {/* The tool path, drawn only while a plan is actually being generated. */}
      <path
        d="M76 70 L124 70"
        stroke="var(--engine-bright)"
        strokeWidth={1}
        strokeDasharray="4 4"
        opacity={working ? 0.9 : 0.25}
        style={
          working
            ? motionStyle(props.motion, `pw-flash 1.2s ease-out forwards`)
            : undefined
        }
      />

      {props.activity.pulses.slice(0, 4).map((pulse, i) => (
        <circle
          key={pulse.key}
          cx={112}
          cy={56}
          r={2 + i}
          fill="var(--engine-bright)"
          style={{
            transformOrigin: "112px 56px",
            ...motionStyle(props.motion, `pw-spark ${0.6 + i * 0.15}s ease-out forwards`),
          }}
        />
      ))}

      <rect
        x={86}
        y={62}
        width={28}
        height={10}
        fill="var(--engine-base)"
        opacity={0.25 + level * 0.5}
        stroke="var(--engine-base)"
        strokeWidth={1}
      />
      <StaticActivity props={props} />
    </g>
  );
}

// ── CostIQ: layers assembling into a number ──────────────────────────────────

export function CostStackScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const layers = [0, 1, 2, 3];

  return (
    <g>
      {layers.map((i) => {
        const y = 84 - i * 13;
        const inset = i * 6;
        return (
          <g
            key={i}
            style={motionStyle(
              props.motion,
              `pw-rise ${idleDuration(props.idle, 4 + i * 0.7)} ease-in-out infinite`,
            )}
          >
            {/* Isometric plates: cost as something built up, layer by layer. */}
            <path
              d={`M${64 + inset} ${y} L100 ${y - 10} L${136 - inset} ${y} L100 ${y + 10} Z`}
              fill="var(--engine-dim)"
              stroke="var(--engine-base)"
              strokeWidth={1.2}
              opacity={0.4 + (i / layers.length) * (0.3 + level * 0.3)}
            />
          </g>
        );
      })}

      {/* Values travelling up the stack as a calculation completes. */}
      {props.activity.pulses.slice(0, 3).map((pulse, i) => (
        <circle
          key={pulse.key}
          cx={100}
          cy={84 - i * 13}
          r={2.4}
          fill="var(--engine-bright)"
          style={{
            transformOrigin: `100px ${84 - i * 13}px`,
            ...motionStyle(props.motion, `pw-spark ${0.5 + i * 0.2}s ease-out forwards`),
          }}
        />
      ))}

      <StaticActivity props={props} />
      <Pulses props={props} y={40} />
    </g>
  );
}

// ── VisionIQ: something actively looking ─────────────────────────────────────

export function VisionLensScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const scanning = props.activity.pulses.length > 0;
  const clip = `${props.uid}-lens-clip`;

  return (
    <g>
      <defs>
        <clipPath id={clip}>
          <rect x={54} y={26} width={92} height={68} />
        </clipPath>
      </defs>

      {[30, 23, 16, 9].map((r, i) => (
        <ellipse
          key={r}
          cx={CENTRE_X}
          cy={CENTRE_Y}
          rx={r}
          ry={r * 0.92}
          fill="none"
          stroke="var(--engine-base)"
          strokeWidth={1.2}
          opacity={0.35 + i * 0.12}
          style={{
            transformOrigin: `${CENTRE_X}px ${CENTRE_Y}px`,
            ...motionStyle(
              props.motion,
              `${i % 2 === 0 ? "pw-spin" : "pw-spin-reverse"} ${idleDuration(props.idle, 22 - i * 3)} linear infinite`,
            ),
          }}
        />
      ))}

      {/* The aperture, opening a little as the engine gets busier. */}
      <circle cx={CENTRE_X} cy={CENTRE_Y} r={5 + level * 2} fill="var(--engine-bright)" opacity={0.5 + level * 0.4} />

      <g clipPath={`url(#${clip})`}>
        <line
          x1={54}
          y1={CENTRE_Y}
          x2={146}
          y2={CENTRE_Y}
          stroke="var(--engine-bright)"
          strokeWidth={1.5}
          opacity={scanning ? 0.9 : 0.2}
          style={motionStyle(
            props.motion,
            `pw-scan-y ${scanning ? "1.4s" : idleDuration(props.idle, 7)} ease-in-out infinite alternate`,
          )}
        />
      </g>

      {/* Detection points appear only when there is something to detect. */}
      {scanning &&
        !props.motion.reducedMotion &&
        [
          [76, 42],
          [124, 46],
          [82, 78],
          [122, 76],
        ].map(([x, y], i) => (
          <rect
            key={i}
            x={x! - 3}
            y={y! - 3}
            width={6}
            height={6}
            fill="none"
            stroke="var(--engine-bright)"
            strokeWidth={1}
            style={motionStyle(props.motion, `pw-flash ${0.9 + i * 0.12}s ease-out forwards`)}
          />
        ))}

      <StaticActivity props={props} />
    </g>
  );
}

// ── WorkOrderIQ: a production line ───────────────────────────────────────────

export function ProductionLineScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const stations = [58, 88, 118, 148];

  return (
    <g>
      <line x1={48} y1={78} x2={158} y2={78} stroke="var(--engine-dim)" strokeWidth={3} />

      {stations.map((x, i) => {
        // Stations light in sequence, so the eye reads direction — work moves
        // left to right, which is what a routing change actually looks like.
        const lit = props.activity.pulses.length > 0 && i <= props.activity.pulses.length;
        return (
          <g key={x}>
            <rect
              x={x - 10}
              y={52}
              width={20}
              height={24}
              fill="var(--engine-dim)"
              stroke="var(--engine-base)"
              strokeWidth={1.2}
              opacity={lit ? 0.95 : 0.4 + level * 0.2}
            />
            <rect
              x={x - 6}
              y={46}
              width={12}
              height={5}
              fill="var(--engine-base)"
              opacity={lit ? 1 : 0.35}
              style={motionStyle(
                props.motion,
                `pw-breathe ${idleDuration(props.idle, 3.4 + i * 0.5)} ease-in-out infinite`,
              )}
            />
          </g>
        );
      })}

      {/* One workpiece travelling the line. */}
      <rect
        x={48}
        y={72}
        width={9}
        height={6}
        fill="var(--engine-bright)"
        opacity={0.9}
        style={motionStyle(
          props.motion,
          `pw-drift ${idleDuration(props.idle, 6)} linear infinite`,
        )}
      />

      <StaticActivity props={props} />
    </g>
  );
}

// ── ReceiptIQ: a document being read ─────────────────────────────────────────

export function DocumentScannerScene(props: EngineSceneProps) {
  const extracting = props.activity.pulses.length > 0;
  const clip = `${props.uid}-doc-clip`;

  return (
    <g>
      <defs>
        <clipPath id={clip}>
          <rect x={68} y={24} width={44} height={72} />
        </clipPath>
      </defs>

      <rect x={60} y={94} width={80} height={4} fill="var(--engine-dim)" />

      <g transform="rotate(-6 90 60)">
        <rect x={68} y={26} width={44} height={68} fill="var(--engine-dim)" stroke="var(--engine-base)" strokeWidth={1.2} />
        {[36, 44, 52, 60, 68, 76, 84].map((y, i) => (
          <line
            key={y}
            x1={74}
            y1={y}
            x2={i % 3 === 0 ? 100 : 106}
            y2={y}
            stroke="var(--engine-base)"
            strokeWidth={1}
            opacity={0.5}
          />
        ))}
        <g clipPath={`url(#${clip})`}>
          <line
            x1={68}
            y1={60}
            x2={112}
            y2={60}
            stroke="var(--engine-bright)"
            strokeWidth={1.6}
            style={motionStyle(
              props.motion,
              `pw-scan-y ${extracting ? "1.2s" : idleDuration(props.idle, 6)} ease-in-out infinite alternate`,
            )}
          />
        </g>
      </g>

      {/* Extracted fields leaving the document as structured records. */}
      {[38, 52, 66, 80].map((y, i) => (
        <rect
          key={y}
          x={126}
          y={y}
          width={20}
          height={7}
          rx={1.5}
          fill="none"
          stroke="var(--engine-base)"
          strokeWidth={1}
          opacity={extracting ? 1 : 0.3}
          style={
            extracting
              ? motionStyle(props.motion, `pw-flash ${0.8 + i * 0.18}s ease-out forwards`)
              : undefined
          }
        />
      ))}

      <StaticActivity props={props} />
    </g>
  );
}

// ── InventoryIQ: material on shelves ─────────────────────────────────────────

export function InventoryRacksScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const columns = [64, 84, 104, 124, 144];
  const rows = [40, 58, 76];

  return (
    <g>
      {rows.map((y) => (
        <line key={y} x1={56} y1={y + 14} x2={152} y2={y + 14} stroke="var(--engine-dim)" strokeWidth={2} />
      ))}

      {rows.flatMap((y, rowIndex) =>
        columns.map((x, colIndex) => {
          const index = rowIndex * columns.length + colIndex;
          // Which bins light is deterministic, so the picture is stable between
          // renders. A shelf that reshuffles on every repaint is unreadable.
          const lit = props.activity.pulses.length > index % 4;
          return (
            <rect
              key={`${x}-${y}`}
              x={x - 7}
              y={y}
              width={14}
              height={13}
              fill="var(--engine-dim)"
              stroke="var(--engine-base)"
              strokeWidth={1}
              opacity={lit ? 0.95 : 0.35 + level * 0.25}
              style={
                lit && !props.motion.reducedMotion
                  ? motionStyle(props.motion, `pw-flash 1.1s ease-out forwards`)
                  : motionStyle(
                      props.motion,
                      `pw-breathe ${idleDuration(props.idle, 4 + (index % 5))} ease-in-out infinite`,
                    )
              }
            />
          );
        }),
      )}

      <StaticActivity props={props} />
    </g>
  );
}

// ── Order Ingestion: many channels, one order ────────────────────────────────

export function ChannelFunnelScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const channels = [24, 42, 60, 78, 96];

  return (
    <g>
      {channels.map((y, i) => (
        <g key={y}>
          <rect x={30} y={y - 5} width={14} height={10} rx={2} fill="var(--engine-dim)" stroke="var(--engine-base)" strokeWidth={1} />
          <path
            d={`M46 ${y} Q ${74} ${y} ${96} 60`}
            fill="none"
            stroke="var(--engine-base)"
            strokeWidth={1}
            opacity={0.3 + level * 0.35}
            strokeDasharray="3 6"
            style={motionStyle(
              props.motion,
              `pw-breathe ${idleDuration(props.idle, 3 + i * 0.6)} ease-in-out infinite`,
            )}
          />
        </g>
      ))}

      {/* The normalized order, assembled and heading onwards to Prime. */}
      <path
        d="M104 46 L124 52 L124 70 L104 76 L104 46 Z"
        fill="var(--engine-dim)"
        stroke="var(--engine-base)"
        strokeWidth={1.4}
        opacity={0.6 + level * 0.4}
      />
      <line x1={126} y1={61} x2={158} y2={61} stroke="var(--engine-base)" strokeWidth={1} strokeDasharray="4 5" opacity={0.5} />

      <StaticActivity props={props} />
      <Pulses props={props} x={114} y={61} />
    </g>
  );
}
