import {
  dayOfMonth,
  daysInMonth,
  daysInRange,
  diffDays,
  monthsBetween,
  weekdayName,
  weekdayOf,
  type DateKey,
  type DateRange,
} from "@/lib/date";
import type { Recurrence } from "@/types/domain";

/** Dates within `range` on which the recurrence produces an occurrence. */
export function occurrencesInRange(recurrence: Recurrence, range: DateRange): DateKey[] {
  const from = range.from > recurrence.startDate ? range.from : recurrence.startDate;
  const to = recurrence.endDate && recurrence.endDate < range.to ? recurrence.endDate : range.to;
  if (from > to) return [];
  return daysInRange({ from, to }).filter((day) => occursOn(recurrence, day));
}

export function occursOn(recurrence: Recurrence, day: DateKey): boolean {
  if (day < recurrence.startDate) return false;
  if (recurrence.endDate && day > recurrence.endDate) return false;
  const interval = Math.max(1, recurrence.interval);
  switch (recurrence.frequency) {
    case "daily":
      return diffDays(day, recurrence.startDate) % interval === 0;
    case "weekly": {
      const weekdays = recurrence.weekdays.length ? recurrence.weekdays : [weekdayOf(recurrence.startDate)];
      if (!weekdays.includes(weekdayOf(day))) return false;
      const weeks = Math.floor(diffDays(day, recurrence.startDate) / 7);
      return weeks % interval === 0;
    }
    case "monthly": {
      // Month arithmetic follows the active calendar (Gregorian or Shamsi).
      const months = monthsBetween(recurrence.startDate, day);
      if (months % interval !== 0) return false;
      const wanted = recurrence.dayOfMonth ?? dayOfMonth(recurrence.startDate);
      // Clamp to month length so "31st" still happens in short months.
      const effective = Math.min(wanted, daysInMonth(day));
      return dayOfMonth(day) === effective;
    }
  }
}

export function describeRecurrence(recurrence: Recurrence): string {
  const names = [0, 1, 2, 3, 4, 5, 6].map((d) => weekdayName(d, "short"));
  const every = recurrence.interval > 1 ? `Every ${recurrence.interval} ` : "Every ";
  switch (recurrence.frequency) {
    case "daily":
      return recurrence.interval > 1 ? `${every}days` : "Daily";
    case "weekly": {
      const days = recurrence.weekdays.length
        ? [...recurrence.weekdays].sort().map((d) => names[d]).join(", ")
        : names[weekdayOf(recurrence.startDate)];
      return `${recurrence.interval > 1 ? `${every}weeks` : "Weekly"} · ${days}`;
    }
    case "monthly": {
      const day = recurrence.dayOfMonth ?? dayOfMonth(recurrence.startDate);
      // occursOn clamps to the last day of shorter months, so the label must
      // say so when the wanted day can exceed a month's length.
      const clampNote = day > 28 ? " (last day in shorter months)" : "";
      return `${recurrence.interval > 1 ? `${every}months` : "Monthly"} · day ${day}${clampNote}`;
    }
  }
}
