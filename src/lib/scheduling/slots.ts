import { addDaysKey, weekRange, type DateKey, type WeekdayIndex } from "@/lib/date";
import type { ScheduleBlock } from "@/types/domain";

export interface WorkingHours {
  dayStartMinutes: number;
  dayEndMinutes: number;
  breakMinutes: number;
  workingDays: number[];
}

interface Interval {
  start: number;
  end: number;
}

function busyIntervals(blocks: readonly ScheduleBlock[], date: DateKey, ignoreId?: string): Interval[] {
  return blocks
    .filter((b) => b.date === date && b.startMinutes !== null && b.id !== ignoreId && b.status !== "skipped")
    .map((b) => ({ start: b.startMinutes!, end: b.startMinutes! + b.durationMinutes }))
    .sort((a, b) => a.start - b.start);
}

/**
 * First gap on `date` within working hours that fits `duration` (respecting
 * a break buffer after existing blocks). Returns minutes or null.
 */
export function findSlotOnDate(
  blocks: readonly ScheduleBlock[],
  date: DateKey,
  duration: number,
  hours: WorkingHours,
  options: { notBefore?: number; ignoreBlockId?: string } = {},
): number | null {
  const busy = busyIntervals(blocks, date, options.ignoreBlockId);
  let cursor = Math.max(hours.dayStartMinutes, roundUp(options.notBefore ?? 0, 15));
  for (const interval of busy) {
    if (cursor + duration <= interval.start) break;
    if (interval.end + hours.breakMinutes > cursor) {
      cursor = roundUp(interval.end + hours.breakMinutes, 15);
    }
  }
  return cursor + duration <= hours.dayEndMinutes ? cursor : null;
}

function roundUp(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

/** Search forward (up to `horizonDays`) for the next free slot. */
export function findNextAvailableSlot(
  blocks: readonly ScheduleBlock[],
  fromDate: DateKey,
  fromMinutes: number,
  duration: number,
  hours: WorkingHours,
  options: { ignoreBlockId?: string; horizonDays?: number } = {},
): { date: DateKey; startMinutes: number } | null {
  const horizon = options.horizonDays ?? 14;
  for (let i = 0; i < horizon; i++) {
    const date = addDaysKey(fromDate, i);
    const weekday = new Date(`${date}T00:00:00`).getDay();
    if (i > 0 && !hours.workingDays.includes(weekday)) continue;
    const start = findSlotOnDate(blocks, date, duration, hours, {
      notBefore: i === 0 ? fromMinutes : 0,
      ignoreBlockId: options.ignoreBlockId,
    });
    if (start !== null) return { date, startMinutes: start };
  }
  return null;
}

/** Working day with the lowest planned load between from..to (inclusive). */
export function leastLoadedDay(
  blocks: readonly ScheduleBlock[],
  days: DateKey[],
  workingDays: number[],
): DateKey | null {
  const candidates = days.filter((d) => workingDays.includes(new Date(`${d}T00:00:00`).getDay()));
  if (candidates.length === 0) return days[0] ?? null;
  let best = candidates[0];
  let bestLoad = Infinity;
  for (const day of candidates) {
    const load = blocks
      .filter((b) => b.date === day && b.status === "planned")
      .reduce((s, b) => s + b.durationMinutes, 0);
    if (load < bestLoad) {
      best = day;
      bestLoad = load;
    }
  }
  return best;
}

export type RescheduleOption = "tomorrow" | "next_slot" | "later_this_week" | "next_week" | "custom";

export interface RescheduleTarget {
  option: RescheduleOption;
  label: string;
  date: DateKey;
  startMinutes: number | null;
}

/**
 * Computes concrete targets for each reschedule option so the UI can show the
 * user exactly where a block would go *before* they confirm.
 */
export function computeRescheduleTargets(
  block: ScheduleBlock,
  blocks: readonly ScheduleBlock[],
  now: { date: DateKey; minutes: number },
  hours: WorkingHours,
  weekStartsOn: WeekdayIndex,
): RescheduleTarget[] {
  const targets: RescheduleTarget[] = [];
  const tomorrow = addDaysKey(now.date, 1);
  const keepTime = block.startMinutes;

  targets.push({
    option: "tomorrow",
    label: "Tomorrow",
    date: tomorrow,
    // When tomorrow is fully booked, degrade to "anytime" (null) instead of
    // keepTime: suggesting the original time would overlap existing blocks,
    // and confirming the dialog moves the block with no overlap validation.
    startMinutes:
      keepTime !== null
        ? (findSlotOnDate(blocks, tomorrow, block.durationMinutes, hours, {
            notBefore: keepTime,
            ignoreBlockId: block.id,
          }) ??
          findSlotOnDate(blocks, tomorrow, block.durationMinutes, hours, { ignoreBlockId: block.id }))
        : null,
  });

  const next = findNextAvailableSlot(blocks, now.date, now.minutes, block.durationMinutes, hours, {
    ignoreBlockId: block.id,
  });
  if (next) targets.push({ option: "next_slot", label: "Next available slot", ...next });

  const week = weekRange(now.date, weekStartsOn);
  const remaining: DateKey[] = [];
  for (let d = addDaysKey(now.date, 2); d <= week.to; d = addDaysKey(d, 1)) remaining.push(d);
  const later = leastLoadedDay(blocks, remaining, hours.workingDays);
  if (later) {
    targets.push({
      option: "later_this_week",
      label: "Later this week",
      date: later,
      startMinutes: findSlotOnDate(blocks, later, block.durationMinutes, hours, { ignoreBlockId: block.id }),
    });
  }

  const nextWeekStart = addDaysKey(week.to, 1);
  const nextWeekDays: DateKey[] = [];
  for (let i = 0; i < 7; i++) nextWeekDays.push(addDaysKey(nextWeekStart, i));
  const nextWeekDay = hours.workingDays.length
    ? (nextWeekDays.find((d) => hours.workingDays.includes(new Date(`${d}T00:00:00`).getDay())) ?? nextWeekStart)
    : nextWeekStart;
  targets.push({
    option: "next_week",
    label: "Next week",
    date: nextWeekDay,
    startMinutes: findSlotOnDate(blocks, nextWeekDay, block.durationMinutes, hours, { ignoreBlockId: block.id }),
  });
  return targets;
}

/** Whether two blocks on the same day overlap in time. */
export function blocksOverlap(a: ScheduleBlock, b: ScheduleBlock): boolean {
  if (a.date !== b.date || a.startMinutes === null || b.startMinutes === null) return false;
  return a.startMinutes < b.startMinutes + b.durationMinutes && b.startMinutes < a.startMinutes + a.durationMinutes;
}
