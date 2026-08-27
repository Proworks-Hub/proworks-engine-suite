import type { ValidationResult } from "../../core/validation/types";

export function ValidationPanel(props: {
  validation: ValidationResult | undefined;
  onFocusIssue: (surfaceId: string | undefined, elementId: string | undefined) => void;
}) {
  const v = props.validation;
  if (!v || v.issues.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "#16a34a", padding: "8px 0" }}>
        ✓ Manufacturable — no issues found
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {v.issues.map((issue, i) => (
        <button
          key={i}
          type="button"
          onClick={() => props.onFocusIssue(issue.surfaceId, issue.elementId)}
          style={{
            textAlign: "left",
            fontSize: 13,
            padding: "8px 10px",
            borderRadius: 8,
            cursor: issue.surfaceId ? "pointer" : "default",
            border: `1px solid ${issue.severity === "error" ? "#fca5a5" : "#fcd34d"}`,
            background: issue.severity === "error" ? "#fef2f2" : "#fffbeb",
            color: "#18181b",
          }}
        >
          <strong>{issue.severity === "error" ? "⚠ " : "ℹ "}</strong>
          {issue.message}
          {issue.suggestedFix && (
            <span style={{ display: "block", color: "#52525b", marginTop: 2 }}>{issue.suggestedFix}</span>
          )}
        </button>
      ))}
    </div>
  );
}
