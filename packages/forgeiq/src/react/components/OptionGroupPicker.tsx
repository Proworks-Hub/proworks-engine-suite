// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { OptionGroup } from "../../core/schemas/productDefinition.js";

const chip = (active: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 8,
  border: active ? "2px solid #d97706" : "1px solid #d4d4d8",
  background: active ? "#fffbeb" : "#fff",
  color: "#18181b",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: active ? 600 : 400,
});

export function OptionGroupPicker(props: {
  groups: OptionGroup[];
  selections: Record<string, string>;
  onSelect: (groupId: string, valueId: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {props.groups.map((group) => (
        <div key={group.id}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "#52525b", marginBottom: 6 }}>
            {group.label}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {group.values.map((value) => (
              <button
                key={value.id}
                type="button"
                title={value.description}
                style={chip(props.selections[group.id] === value.id)}
                onClick={() => props.onSelect(group.id, value.id)}
              >
                {value.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
