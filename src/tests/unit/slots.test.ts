import { describe, expect, it } from "vitest";
import {
  computeRescheduleTargets,
  findNextAvailableSlot,
  findSlotOnDate,
  leastLoadedDay,
} from "@/lib/scheduling/slots";
import type { ScheduleBlock } from "@/types/domain";

const hours = { dayStartMinutes: 540, dayEndMinutes: 1140, breakMinutes: 0, workingDays: [1, 2, 3, 4, 5] };
const block = (id: string, date: string, start: number, dur: number): ScheduleBlock => ({
  id, taskId: id, date, startMinutes: start, durationMinutes: dur, status: "planned", actualMinutes: null,
  originalDate: date, rescheduleCount: 0, occurrenceDate: null, completedAt: null, createdAt: "", updatedAt: "",
});

describe("slot finding", () => {
  it("finds the first gap", () => {
    const blocks = [block("a", "2026-09-24", 540, 60), block("b", "2026-09-24", 660, 60)];
    expect(findSlotOnDate(blocks, "2026-09-24", 60, hours)).toBe(600);
    expect(findSlotOnDate(blocks, "2026-09-24", 90, hours)).toBe(720);
  });

  it("skips non-working days when searching forward", () => {
    const blocks = [block("a", "2026-09-25", 540, 600)]; // Fri full
    const slot = findNextAvailableSlot(blocks, "2026-09-25", 0, 60, hours);
    expect(slot).toEqual({ date: "2026-09-28", startMinutes: 540 }); // Mon
  });

  it("returns null when no day in the range is a working day", () => {
    // Sat 2026-09-26 + Sun 2026-09-27 with Mon–Fri working days: previously
    // this fell back to days[0] (a Saturday) instead of null.
    expect(leastLoadedDay([], ["2026-09-26", "2026-09-27"], [1, 2, 3, 4, 5])).toBeNull();
    expect(leastLoadedDay([], [], [1, 2, 3, 4, 5])).toBeNull();
  });

  it("omits later_this_week when the rest of the week has no working day", () => {
    const b = block("x", "2026-09-24", 600, 60); // Thu; rest of week is Sat/Sun only
    const targets = computeRescheduleTargets(b, [b], { date: "2026-09-24", minutes: 700 }, hours, 1);
    const options = targets.map((t) => t.option);
    expect(options).not.toContain("later_this_week");
    expect(options).toContain("next_week");
  });

  it("computes reschedule targets for each option", () => {
    const b = block("x", "2026-09-22", 600, 60); // Tue
    const targets = computeRescheduleTargets(b, [b], { date: "2026-09-22", minutes: 700 }, hours, 1);
    const byOption = Object.fromEntries(targets.map((t) => [t.option, t]));
    expect(byOption.tomorrow).toMatchObject({ date: "2026-09-23", startMinutes: 600 });
    expect(byOption.next_slot).toMatchObject({ date: "2026-09-22", startMinutes: 705 });
    expect(byOption.later_this_week.date >= "2026-09-24").toBe(true);
    expect(byOption.next_week.date).toBe("2026-09-28");
  });
});
