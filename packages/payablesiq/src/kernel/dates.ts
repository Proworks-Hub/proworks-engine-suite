// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { BusinessCalendar, BusinessDayAdjustment } from "../model.js";

// ─────────────────────────────────────────────────────────────────────────────
// Calendar-date arithmetic — pure, proleptic Gregorian, integer days.
// Domain dates are DATES (`YYYY-MM-DD`), never timestamps, never zone-bearing:
// a due date is a date in a jurisdiction, not an instant. There is no now().
// ─────────────────────────────────────────────────────────────────────────────

export type ISODate = string;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
}

export function parts(date: ISODate): { year: number; month: number; day: number } {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

export function fromParts(year: number, month: number, day: number): ISODate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Days since 0001-01-01 on the proleptic Gregorian calendar. Pure integer arithmetic. */
export function toOrdinal(date: ISODate): number {
  const { year, month, day } = parts(date);
  const y = year - 1;
  let ordinal = y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
  for (let m = 1; m < month; m++) ordinal += daysInMonth(year, m);
  return ordinal + day;
}

export function fromOrdinal(ordinal: number): ISODate {
  // Coarse year guess, then correct — exact for the supported range.
  let year = Math.max(1, Math.floor(ordinal / 365.2425));
  while (toOrdinal(fromParts(year + 1, 1, 1)) <= ordinal) year++;
  while (toOrdinal(fromParts(year, 1, 1)) > ordinal) year--;
  let remaining = ordinal - toOrdinal(fromParts(year, 1, 1)) + 1;
  let month = 1;
  while (remaining > daysInMonth(year, month)) {
    remaining -= daysInMonth(year, month);
    month++;
  }
  return fromParts(year, month, remaining);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromOrdinal(toOrdinal(date) + days);
}

/** asOf − basis, integer calendar days. Due today = 0 = NOT past due. */
export function daysBetween(basis: ISODate, asOf: ISODate): number {
  return toOrdinal(asOf) - toOrdinal(basis);
}

/** First day of the month `monthsAhead` after date's month. */
export function monthStartPlus(date: ISODate, monthsAhead: number): { year: number; month: number } {
  const { year, month } = parts(date);
  const total = (year * 12 + (month - 1)) + monthsAhead;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/**
 * Day 31 means last-day-of-month, stated explicitly. February is where
 * day-of-month terms break — a rule of day 31 applied to February yields 28
 * or 29 (GC-08/GC-09).
 */
export function clampToMonthEnd(year: number, month: number, dayOfMonth: number): ISODate {
  return fromParts(year, month, Math.min(dayOfMonth, daysInMonth(year, month)));
}

/** 0=Sunday..6=Saturday, from the ordinal. 0001-01-01 was a Monday. */
export function dayOfWeek(date: ISODate): number {
  return toOrdinal(date) % 7; // ordinal 1 → 1 (Monday)
}

function isBusinessDay(date: ISODate, calendar: BusinessCalendar): boolean {
  return !calendar.weekendDays.includes(dayOfWeek(date)) && !calendar.holidays.includes(date);
}

/**
 * Business-day adjustment against a SUPPLIED calendar. With no calendar,
 * only "none" is legal — a business-day rule with no calendar is a rule that
 * silently means nothing, and the caller hears that as a refusal upstream.
 */
export function applyBusinessDayAdjustment(
  date: ISODate,
  adjustment: BusinessDayAdjustment,
  calendar: BusinessCalendar,
): ISODate {
  if (adjustment === "none") return date;
  const step = adjustment === "preceding" ? -1 : 1;
  let candidate = date;
  while (!isBusinessDay(candidate, calendar)) candidate = addDays(candidate, step);
  if (adjustment === "modified-following" && parts(candidate).month !== parts(date).month) {
    // Following crossed the month boundary: fall back to preceding.
    candidate = date;
    while (!isBusinessDay(candidate, calendar)) candidate = addDays(candidate, -1);
  }
  return candidate;
}
