import type { ValidationIssue, ValidationRule } from "../types";

// Letters with enclosed counters (the middle of an O, the loops of a B) lose
// those centers when text is cut through solid material — the classic reason
// stencil fonts exist. Warn so the customer isn't surprised; the shop bridges
// them during production.
const COUNTER_CHARS = /[ABDOPQRabdegopq04689@#&%]/;

export const textCountersRule: ValidationRule = {
  id: "text-enclosed-counters",
  run(ctx) {
    if (!ctx.definition.manufacturingProcess.includes("cut")) return [];
    const issues: ValidationIssue[] = [];
    for (const [surfaceId, elements] of Object.entries(ctx.configuration.surfaces)) {
      for (const el of elements) {
        if (el.type !== "text" || !COUNTER_CHARS.test(el.text)) continue;
        issues.push({
          severity: "warning",
          rule: "text-enclosed-counters",
          surfaceId,
          elementId: el.id,
          message: `Letters in "${el.text.slice(0, 24)}" have enclosed centers (like the middle of an O) that fall out when cut through.`,
          suggestedFix:
            "We'll bridge those letters stencil-style during production — no action needed unless you'd prefer different wording.",
        });
      }
    }
    return issues;
  },
};
