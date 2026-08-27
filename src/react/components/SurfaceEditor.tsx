import { useRef } from "react";
import type { SurfaceElement } from "../../core/schemas/configuration";
import type { ProductSurface } from "../../core/schemas/productDefinition";
import type { SurfaceDims } from "../../core/resolve";
import type { ValidationIssue } from "../../core/validation/types";

const EDITOR_WIDTH_PX = 560;

// Minimal 2D surface editor: a scaled panel with absolutely-positioned,
// pointer-draggable elements — the same idiom the host's hand-built builders
// use, without any canvas library.
export function SurfaceEditor(props: {
  surface: ProductSurface;
  dims: SurfaceDims;
  elements: SurfaceElement[];
  issues: ValidationIssue[];
  selectedElementId: string | null;
  onSelect: (elementId: string | null) => void;
  onMove: (elementId: string, xIn: number, yIn: number) => void;
}) {
  const { surface, dims } = props;
  const pxPerIn = EDITOR_WIDTH_PX / dims.widthIn;
  const heightPx = dims.heightIn * pxPerIn;
  const safePx = surface.safeAreaIn * pxPerIn;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; baseXIn: number; baseYIn: number } | null>(null);

  const issueFor = (elementId: string) =>
    props.issues.find((i) => i.elementId === elementId);

  const startDrag = (el: SurfaceElement) => (e: React.PointerEvent) => {
    e.preventDefault();
    props.onSelect(el.id);
    dragRef.current = { id: el.id, startX: e.clientX, startY: e.clientY, baseXIn: el.xIn, baseYIn: el.yIn };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxIn = (e.clientX - drag.startX) / pxPerIn;
    const dyIn = (e.clientY - drag.startY) / pxPerIn;
    props.onMove(drag.id, Math.round((drag.baseXIn + dxIn) * 16) / 16, Math.round((drag.baseYIn + dyIn) * 16) / 16);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div>
      <div
        ref={containerRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerDown={(e) => {
          if (e.target === containerRef.current) props.onSelect(null);
        }}
        style={{
          position: "relative",
          width: EDITOR_WIDTH_PX,
          height: heightPx,
          background: "linear-gradient(135deg, #3f3f46 0%, #52525b 50%, #3f3f46 100%)",
          borderRadius: 6,
          border: "1px solid #27272a",
          overflow: "hidden",
          touchAction: "none",
        }}
      >
        {/* Safe area */}
        {surface.safeAreaIn > 0 && (
          <div
            style={{
              position: "absolute",
              inset: safePx,
              border: "1px dashed rgba(255,255,255,0.45)",
              borderRadius: 2,
              pointerEvents: "none",
            }}
          />
        )}
        {props.elements.map((el) => {
          const issue = issueFor(el.id);
          const selected = el.id === props.selectedElementId;
          const outline = issue
            ? `2px solid ${issue.severity === "error" ? "#ef4444" : "#f59e0b"}`
            : selected
              ? "2px solid #38bdf8"
              : "1px dashed rgba(255,255,255,0.35)";
          const common: React.CSSProperties = {
            position: "absolute",
            left: el.xIn * pxPerIn,
            top: el.yIn * pxPerIn,
            transform: `rotate(${el.rotationDeg}deg)`,
            transformOrigin: "center",
            cursor: "grab",
            outline,
            outlineOffset: 2,
            userSelect: "none",
          };
          if (el.type === "text") {
            return (
              <div
                key={el.id}
                onPointerDown={startDrag(el)}
                style={{
                  ...common,
                  fontFamily: el.fontFamily,
                  fontWeight: 800,
                  fontSize: el.heightIn * pxPerIn,
                  lineHeight: 1,
                  color: "#fbbf24",
                  whiteSpace: "nowrap",
                }}
              >
                {el.text}
              </div>
            );
          }
          return (
            <img
              key={el.id}
              src={el.url}
              alt=""
              draggable={false}
              onPointerDown={startDrag(el)}
              style={{
                ...common,
                width: el.widthIn * pxPerIn,
                height: el.heightIn * pxPerIn,
                objectFit: "fill",
              }}
            />
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: "#71717a", marginTop: 4 }}>
        {surface.name}: {dims.widthIn}" × {dims.heightIn}" — dashed line is the safe area
      </div>
    </div>
  );
}
