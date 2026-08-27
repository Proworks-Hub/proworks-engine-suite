// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — Priority score + color + ordering
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.4.
 *
 * Pure functions. No I/O, no side effects. All time inputs injected so
 * tests are deterministic and replays produce identical output.
 *
 * These formulas are the Phase 1 defaults. The spec §21 "Continual Learning
 * Layer" contemplates that the learning layer will eventually propose
 * tuning to aging multipliers and urgency thresholds. When it does, the
 * tuning plugs into THIS module — everything downstream just sorts by
 * whatever number comes out of `calculatePriorityScore`.
 */

import type {
  PriorityColor,
  PriorityLevel,
  PriorityScore,
  PriorityScoreBreakdown,
  PrioritizedStep,
} from "./priorityTypes.js";

// ---------- Constants ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Base score per priority level. Spaced so aging and urgency can't overtake the next tier easily. */
const PRIORITY_BASE: Record<PriorityLevel, number> = {
  rush: 1000,
  high: 500,
  medium: 100,
  low: 10,
};

/**
 * Per-day aging multiplier. Rush ages fastest (a stuck rush should rise even
 * higher); low ages slowest (a low job sitting around shouldn't pretend to be
 * high). Tunable by the learning layer (§21).
 */
const AGING_MULTIPLIER: Record<PriorityLevel, number> = {
  rush: 5,
  high: 3,
  medium: 1,
  low: 0.5,
};

// ---------- Score ----------

export function calculatePriorityScore(
  level: PriorityLevel,
  createdAt: Date,
  dueDate: Date | null,
  now: Date
): PriorityScoreBreakdown {
  const base = PRIORITY_BASE[level];
  const agingBump = calcAgingBump(createdAt, now, level);
  const dueDateUrgency = calcDueDateUrgency(dueDate, now);
  const total = base + agingBump + dueDateUrgency;
  return { base, agingBump, dueDateUrgency, total };
}

function calcAgingBump(
  createdAt: Date,
  now: Date,
  level: PriorityLevel
): number {
  const ageMs = now.getTime() - createdAt.getTime();
  const days = Math.max(0, Math.floor(ageMs / DAY_MS));
  return Math.round(days * AGING_MULTIPLIER[level]);
}

function calcDueDateUrgency(dueDate: Date | null, now: Date): number {
  if (!dueDate) return 0;
  const remainingMs = dueDate.getTime() - now.getTime();
  if (remainingMs < 0) return 300; // overdue — urgent, above rush base delta
  if (remainingMs < DAY_MS) return 200; // <24h
  if (remainingMs < 3 * DAY_MS) return 50; // <72h
  return 0;
}

// ---------- Color ----------

/**
 * Render color per spec §3.4. Priority is evaluated from most-urgent to
 * least-urgent; first matching rule wins.
 */
export function calculatePriorityColor(
  level: PriorityLevel,
  dueDate: Date | null,
  now: Date
): PriorityColor {
  // 🔴 Red — rush, overdue, or within 24h.
  if (level === "rush") return "red";
  if (dueDate) {
    const remainingMs = dueDate.getTime() - now.getTime();
    if (remainingMs < DAY_MS) return "red";
    if (remainingMs < 3 * DAY_MS) return "yellow";
  }
  // 🟡 Yellow — high priority (buffer window).
  if (level === "high") return "yellow";
  // 🟢 Green — everything else.
  return "green";
}

// ---------- Ordering ----------

/**
 * Sort prioritized steps for queue display / Task Flow consumption.
 *
 * Order: priorityScore desc → dueDate asc (missing last) → tentativeStepId asc.
 *
 * Returns a new array — the input is not mutated.
 */
export function orderStepsByPriority(
  steps: ReadonlyArray<PrioritizedStep>
): ReadonlyArray<PrioritizedStep> {
  return [...steps].sort((a, b) => {
    if (a.priorityScore !== b.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    const aDue = a.dueDate ? new Date(a.dueDate).getTime() : null;
    const bDue = b.dueDate ? new Date(b.dueDate).getTime() : null;
    if (aDue !== null && bDue !== null && aDue !== bDue) {
      return aDue - bDue;
    }
    if (aDue !== null && bDue === null) return -1;
    if (aDue === null && bDue !== null) return 1;
    return a.tentativeStepId < b.tentativeStepId
      ? -1
      : a.tentativeStepId > b.tentativeStepId
        ? 1
        : 0;
  });
}

// ---------- Utility for score consumers ----------

export function pickScoreTotal(breakdown: PriorityScoreBreakdown): PriorityScore {
  return breakdown.total;
}
