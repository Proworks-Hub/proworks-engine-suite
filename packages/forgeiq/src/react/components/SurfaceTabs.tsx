// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ProductSurface } from "../../core/schemas/productDefinition.js";

export function SurfaceTabs(props: {
  surfaces: ProductSurface[];
  activeSurfaceId: string | null;
  issueCounts: Record<string, number>;
  onSelect: (surfaceId: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {props.surfaces
        .filter((s) => s.editable)
        .map((s) => {
          const active = s.id === props.activeSurfaceId;
          const issues = props.issueCounts[s.id] ?? 0;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => props.onSelect(s.id)}
              style={{
                padding: "7px 14px",
                borderRadius: "8px 8px 0 0",
                border: "1px solid #d4d4d8",
                borderBottom: active ? "1px solid #fff" : "1px solid #d4d4d8",
                background: active ? "#fff" : "#f4f4f5",
                fontWeight: active ? 600 : 400,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {s.name}
              {issues > 0 && (
                <span style={{ marginLeft: 6, background: "#dc2626", color: "#fff", borderRadius: 999, padding: "0 6px", fontSize: 11 }}>
                  {issues}
                </span>
              )}
            </button>
          );
        })}
    </div>
  );
}
