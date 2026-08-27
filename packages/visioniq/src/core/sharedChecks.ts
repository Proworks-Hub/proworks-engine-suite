// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio (InvoFlowHub/src/modules/ksix-prep-studio/core)
// without behavioural change. Only import paths were rewritten: the suite is ESM
// and resolves relative specifiers with explicit .js extensions, where the host
// used a bundler alias. The logic below is the host's, unmodified.

import type { PrepIngestInput, PrepIssue, PrepRecommendation } from "./types.js";

export function issue(type: string, severity: PrepIssue["severity"], message: string): PrepIssue {
  return { type, severity, message };
}

export function recommendation(type: string, message: string): PrepRecommendation {
  return { type, message };
}

export function baseQualityChecks(input: PrepIngestInput): PrepIssue[] {
  const issues: PrepIssue[] = [];
  if ((input.dpi ?? 0) > 0 && (input.dpi ?? 0) < 150) {
    issues.push(issue("low_resolution", "critical", "File DPI is too low for reliable production output."));
  } else if ((input.dpi ?? 0) > 0 && (input.dpi ?? 0) < 300) {
    issues.push(issue("medium_resolution", "warning", "DPI is acceptable but below ideal production target."));
  }
  if (!input.widthIn || !input.heightIn) {
    issues.push(issue("missing_dimensions", "warning", "Artwork dimensions are missing."));
  }
  return issues;
}

export function computeReadiness(issues: PrepIssue[]): number {
  let score = 100;
  for (const item of issues) {
    if (item.severity === "critical") score -= 25;
    else if (item.severity === "warning") score -= 10;
    else score -= 3;
  }
  return Math.max(0, Math.min(100, score));
}
