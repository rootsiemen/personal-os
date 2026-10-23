import { describe, expect, it } from "vitest";
import { describeRecurrence, occurrencesInRange } from "@/lib/recurrence";
import type { Recurrence } from "@/types/domain";

const base: Recurrence = {
  frequency: "daily",
  interval: 1,
  weekdays: [],
  dayOfMonth: null,
  startDate: "2026-09-01",
  endDate: null,
  startMinutes: null,
};

describe("occurrencesInRange", () => {
  it("daily with interval", () => {
    expect(occurrencesInRange({ ...base, interval: 2 }, { from: "2026-09-01", to: "2026-09-07" })).toEqual([
      "2026-09-01",
      "2026-09-03",
      "2026-09-05",
      "2026-09-07",
    ]);
  });

  it("weekly on custom days (Mon + Thu)", () => {
    const days = occurrencesInRange({ ...base, frequency: "weekly", weekdays: [1, 4] }, { from: "2026-09-21", to: "2026-09-27" });
    expect(days).toEqual(["2026-09-21", "2026-09-24"]);
  });

  it("monthly clamps to month length", () => {
    const days = occurrencesInRange(
      { ...base, frequency: "monthly", dayOfMonth: 31, startDate: "2026-01-31" },
      { from: "2026-02-01", to: "2026-04-30" },
    );
    expect(days).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("respects start and end dates", () => {
    const days = occurrencesInRange({ ...base, startDate: "2026-09-05", endDate: "2026-09-06" }, { from: "2026-09-01", to: "2026-09-30" });
    expect(days).toEqual(["2026-09-05", "2026-09-06"]);
  });
});

describe("describeRecurrence", () => {
  it("monthly day 31 notes the clamp to shorter months", () => {
    expect(describeRecurrence({ ...base, frequency: "monthly", dayOfMonth: 31 })).toBe(
      "Monthly · day 31 (last day in shorter months)",
    );
  });

  it("monthly day 15 has no clamp note", () => {
    expect(describeRecurrence({ ...base, frequency: "monthly", dayOfMonth: 15 })).toBe("Monthly · day 15");
  });
});
