import { useRef, useState } from "react";
import type { SurfaceElement } from "../../core/schemas/configuration.js";
import type { UploadFn } from "../types.js";
import { traceImageCutContour } from "../export/contour.js";

const btn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #d4d4d8",
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};

let elementCounter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${elementCounter++}`;

// Web-safe display faces that read well cut from metal. Production text is
// re-set in LightBurn, so these only need to exist on the customer's machine.
const FONTS = [
  "Arial",
  "Arial Black",
  "Impact",
  "Georgia",
  "Palatino Linotype",
  "Trebuchet MS",
  "Verdana",
  "Courier New",
];

export function ElementControls(props: {
  surfaceId: string;
  allowedTypes: ("text" | "image")[];
  selectedElement: SurfaceElement | null;
  uploadFile: UploadFn;
  onAdd: (element: SurfaceElement) => void;
  onUpdate: (elementId: string, patch: Partial<SurfaceElement>) => void;
  onRemove: (elementId: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const sel = props.selectedElement;

  async function handleFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const { url } = await props.uploadFile(file);
      // Natural pixel size feeds the DPI validation rule.
      const img = new Image();
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("Could not read the uploaded image"));
        img.src = url;
      });
      // Trace the silhouette once at upload to count enclosed islands — the
      // artwork-islands validation rule reads this. Best-effort.
      let interiorIslands: number | undefined;
      try {
        const traced = await traceImageCutContour(url);
        if (traced) interiorIslands = traced.holes.length;
      } catch {
        // untraceable — leave undefined
      }
      const widthIn = 6;
      props.onAdd({
        id: nextId("img"),
        type: "image",
        url,
        naturalWidthPx: dims.w,
        naturalHeightPx: dims.h,
        interiorIslands,
        xIn: 2,
        yIn: 2,
        widthIn,
        heightIn: Math.round(((widthIn * dims.h) / dims.w) * 100) / 100,
        rotationDeg: 0,
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {props.allowedTypes.includes("text") && (
          <button
            type="button"
            style={btn}
            onClick={() =>
              props.onAdd({
                id: nextId("txt"),
                type: "text",
                text: "YOUR TEXT",
                fontFamily: "Arial",
                xIn: 2,
                yIn: 2,
                heightIn: 2,
                rotationDeg: 0,
              })
            }
          >
            + Add text
          </button>
        )}
        {props.allowedTypes.includes("image") && (
          <>
            <button type="button" style={btn} disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "Uploading…" : "+ Upload image"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </>
        )}
        {sel && (
          <button type="button" style={{ ...btn, color: "#dc2626" }} onClick={() => props.onRemove(sel.id)}>
            Delete selected
          </button>
        )}
      </div>
      {uploadError && <div style={{ color: "#dc2626", fontSize: 12 }}>{uploadError}</div>}
      {sel && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          {sel.type === "text" && (
            <>
              <input
                value={sel.text}
                maxLength={200}
                onChange={(e) => props.onUpdate(sel.id, { text: e.target.value })}
                style={{ padding: "5px 8px", border: "1px solid #d4d4d8", borderRadius: 6, width: 180 }}
              />
              <select
                value={sel.fontFamily}
                onChange={(e) => props.onUpdate(sel.id, { fontFamily: e.target.value })}
                style={{ padding: "5px 6px", border: "1px solid #d4d4d8", borderRadius: 6, fontFamily: sel.fontFamily }}
              >
                {FONTS.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>
                    {f}
                  </option>
                ))}
              </select>
              <label>
                Height (in){" "}
                <input
                  type="number"
                  step={0.125}
                  min={0.125}
                  value={sel.heightIn}
                  onChange={(e) => props.onUpdate(sel.id, { heightIn: Number(e.target.value) || sel.heightIn })}
                  style={{ width: 64, padding: "5px 6px", border: "1px solid #d4d4d8", borderRadius: 6 }}
                />
              </label>
            </>
          )}
          {sel.type === "image" && (
            <label>
              Width (in){" "}
              <input
                type="number"
                step={0.25}
                min={0.5}
                value={sel.widthIn}
                onChange={(e) => {
                  const widthIn = Number(e.target.value);
                  if (!widthIn) return;
                  const ratio = sel.naturalHeightPx / sel.naturalWidthPx;
                  props.onUpdate(sel.id, { widthIn, heightIn: Math.round(widthIn * ratio * 100) / 100 });
                }}
                style={{ width: 64, padding: "5px 6px", border: "1px solid #d4d4d8", borderRadius: 6 }}
              />
            </label>
          )}
          <label>
            Rotate°{" "}
            <input
              type="number"
              step={5}
              value={sel.rotationDeg}
              onChange={(e) => props.onUpdate(sel.id, { rotationDeg: Number(e.target.value) || 0 })}
              style={{ width: 60, padding: "5px 6px", border: "1px solid #d4d4d8", borderRadius: 6 }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
