import { useRef, useState } from "react";
import type { SurfaceElement } from "../../core/schemas/configuration";
import type { ProductDefinition } from "../../core/schemas/productDefinition";
import type { SurfaceDims } from "../../core/resolve";
import { CUT_TEXT_COLOR, CUT_TEXT_SHADOW, panelBackground } from "./panelStyle";

// CSS-3D assembled view: the four customized panels arranged as an open box
// the customer can drag to spin. Pure CSS transforms — no 3D library.

const PREVIEW_WIDTH_PX = 280;

function PanelFace(props: {
  elements: SurfaceElement[];
  dims: SurfaceDims;
  widthPx: number;
  materialPreview?: string;
  transform: string;
}) {
  const pxPerIn = props.widthPx / props.dims.widthIn;
  const heightPx = props.dims.heightIn * pxPerIn;
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: props.widthPx,
        height: heightPx,
        margin: `${-heightPx / 2}px 0 0 ${-props.widthPx / 2}px`,
        transform: props.transform,
        background: panelBackground(props.materialPreview),
        border: "1px solid rgba(0,0,0,0.5)",
        overflow: "hidden",
        backfaceVisibility: "hidden",
      }}
    >
      {props.elements.map((el) =>
        el.type === "text" ? (
          <div
            key={el.id}
            style={{
              position: "absolute",
              left: el.xIn * pxPerIn,
              top: el.yIn * pxPerIn,
              transform: `rotate(${el.rotationDeg}deg)`,
              transformOrigin: "center",
              fontFamily: el.fontFamily,
              fontWeight: 800,
              fontSize: el.heightIn * pxPerIn,
              lineHeight: 1,
              color: CUT_TEXT_COLOR,
              textShadow: CUT_TEXT_SHADOW,
              whiteSpace: "nowrap",
            }}
          >
            {el.text}
          </div>
        ) : (
          <img
            key={el.id}
            src={el.url}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              left: el.xIn * pxPerIn,
              top: el.yIn * pxPerIn,
              width: el.widthIn * pxPerIn,
              height: el.heightIn * pxPerIn,
              transform: `rotate(${el.rotationDeg}deg)`,
              transformOrigin: "center",
              objectFit: "fill",
              opacity: 0.9,
            }}
          />
        ),
      )}
    </div>
  );
}

export function AssembledPreview(props: {
  definition: ProductDefinition;
  surfaces: Record<string, SurfaceElement[]>;
  surfaceDims: Map<string, SurfaceDims>;
  materialPreview?: string;
}) {
  const [angle, setAngle] = useState(-24);
  const dragRef = useRef<{ startX: number; baseAngle: number } | null>(null);

  const panelIds = props.definition.surfaces.map((s) => s.id);
  const [frontId, backId, leftId, rightId] = [
    panelIds[0] ?? "front",
    panelIds[1] ?? "back",
    panelIds[2] ?? "left",
    panelIds[3] ?? "right",
  ];
  const dims = props.surfaceDims.get(frontId);
  if (!dims) return null;

  const widthPx = Math.min(PREVIEW_WIDTH_PX, 280);
  const half = widthPx / 2;
  const heightPx = (dims.heightIn / dims.widthIn) * widthPx;

  const face = (id: string, transform: string) => (
    <PanelFace
      elements={props.surfaces[id] ?? []}
      dims={props.surfaceDims.get(id) ?? dims}
      widthPx={widthPx}
      materialPreview={props.materialPreview}
      transform={transform}
    />
  );

  return (
    <div>
      <div
        onPointerDown={(e) => {
          dragRef.current = { startX: e.clientX, baseAngle: angle };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragRef.current) {
            setAngle(dragRef.current.baseAngle + (e.clientX - dragRef.current.startX) * 0.5);
          }
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerLeave={() => (dragRef.current = null)}
        style={{
          width: "100%",
          height: heightPx + 90,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          perspective: 900,
          cursor: "grab",
          background: "radial-gradient(ellipse at 50% 85%, #d4d4d8 0%, #fafafa 70%)",
          borderRadius: 12,
          border: "1px solid #e4e4e7",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        <div
          style={{
            position: "relative",
            width: widthPx,
            height: heightPx,
            transformStyle: "preserve-3d",
            transform: `rotateX(-12deg) rotateY(${angle}deg)`,
          }}
        >
          {face(frontId, `translateZ(${half}px)`)}
          {face(backId, `rotateY(180deg) translateZ(${half}px)`)}
          {face(leftId, `rotateY(-90deg) translateZ(${half}px)`)}
          {face(rightId, `rotateY(90deg) translateZ(${half}px)`)}
          {/* Rim + coals hint */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: 0,
              width: widthPx,
              height: widthPx,
              margin: `0 0 0 ${-half}px`,
              transform: `rotateX(90deg) translateZ(0px)`,
              background:
                "radial-gradient(circle at 50% 50%, rgba(251,146,60,0.85) 0%, rgba(220,38,38,0.5) 40%, rgba(24,24,27,0.9) 75%)",
              border: "1px solid rgba(0,0,0,0.5)",
            }}
          />
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#71717a", marginTop: 4, textAlign: "center" }}>
        Drag to spin — assembled preview
      </div>
    </div>
  );
}
