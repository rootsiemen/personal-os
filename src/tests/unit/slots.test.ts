import { describe, expect, it } from "vitest";
import { computeRescheduleTargets, findNextAvailableSlot, findSlotOnDate } from "@/lib/scheduling/slots";
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

  it("computes reschedule targets for each option", () => {
    const b = block("x", "2026-09-22", 600, 60); // Tue
    const targets = computeRescheduleTargets(b, [b], { date: "2026-09-22", minutes: 700 }, hours, 1);
    const byOption = Object.fromEntries(targets.map((t) => [t.option, t]));
    expect(byOption.tomorrow).toMatchObject({ date: "2026-09-23", startMinutes: 600 });
    expect(byOption.next_slot).toMatchObject({ date: "2026-09-22", startMinutes: 705 });
    expect(byOption.later_this_week.date >= "2026-09-24").toBe(true);
    expect(byOption.next_week.date).toBe("2026-09-28");
  });

  it("falls back to 'anytime' instead of an overlapping time when tomorrow is full", () => {
    const b = block("x", "2026-09-22", 600, 60); // Tue 10:00
    const fullDay = block("busy", "2026-09-23", 540, 600); // Wed 09:00-19:00 fully booked
    const targets = computeRescheduleTargets(b, [b, fullDay], { date: "2026-09-22", minutes: 700 }, hours, 1);
    const tomorrow = targets.find((t) => t.option === "tomorrow")!;
    expect(tomorrow.date).toBe("2026-09-23");
    // Must not suggest the block's original time: it overlaps the full-day block.
    expect(tomorrow.startMinutes).toBeNull();
  });
});
