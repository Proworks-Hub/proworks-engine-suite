import type { ValidationResult } from "../../core/validation/types";
import type { RepairSuggestion } from "../../core/repair/designRepair";

export function ValidationPanel(props: {
  validation: ValidationResult | undefined;
  repairs: RepairSuggestion[];
  onFocusIssue: (surfaceId: string | undefined, elementId: string | undefined) => void;
  onApplyRepair: (repair: RepairSuggestion) => void;
  onApplyAllRepairs: () => void;
}) {
  const v = props.validation;
  if (!v || v.issues.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "#16a34a", padding: "8px 0" }}>
        ✓ Manufacturable — no issues found
      </div>
    );
  }

  const repairFor = (rule: string, elementId?: string) =>
    props.repairs.find(
      (r) => r.rule === rule && (elementId === undefined || r.elementId === elementId || r.elementId === undefined),
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {props.repairs.length > 1 && (
        <button
          type="button"
          onClick={props.onApplyAllRepairs}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "none",
            background: "#0f766e",
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          ✨ Fix all {props.repairs.length} automatically
        </button>
      )}
      {v.issues.map((issue, i) => {
        const repair = repairFor(issue.rule, issue.elementId);
        return (
          <div
            key={i}
            style={{
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${issue.severity === "error" ? "#fca5a5" : "#fcd34d"}`,
              background: issue.severity === "error" ? "#fef2f2" : "#fffbeb",
              color: "#18181b",
            }}
          >
            <button
              type="button"
              onClick={() => props.onFocusIssue(issue.surfaceId, issue.elementId)}
              style={{
                textAlign: "left",
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: "inherit",
                cursor: issue.surfaceId ? "pointer" : "default",
              }}
            >
              <strong>{issue.severity === "error" ? "⚠ " : "ℹ "}</strong>
              {issue.message}
              {issue.suggestedFix && (
                <span style={{ display: "block", color: "#52525b", marginTop: 2 }}>
                  {issue.suggestedFix}
                </span>
              )}
            </button>
            {repair && (
              <button
                type="button"
                onClick={() => props.onApplyRepair(repair)}
                title={repair.description}
                style={{
                  marginTop: 8,
                  padding: "5px 10px",
                  borderRadius: 6,
                  border: "1px solid #0f766e",
                  background: "#fff",
                  color: "#0f766e",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                ✨ {repair.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
