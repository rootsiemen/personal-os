import { describe, expect, it } from "vitest";
import { setupServices } from "../helpers";

describe("task + schedule services", () => {
  it("creates a task, schedules it and syncs status", async () => {
    const { services, store } = setupServices();
    const task = await services.tasks.create({ title: "Learn React", estimatedMinutes: 120 });
    expect(task.status).toBe("inbox");
    const block = await services.schedule.scheduleTask(task.id, { date: "2026-09-24", startMinutes: 540 });
    expect(block.durationMinutes).toBe(120);
    expect((await store.tasks.get(task.id))!.status).toBe("planned");
    await services.schedule.unscheduleBlock(block.id);
    expect((await store.tasks.get(task.id))!.status).toBe("inbox");
  });

  it("moving to another day keeps the task and counts the reschedule", async () => {
    const { services, store } = setupServices();
    const task = await services.tasks.create({ title: "Gym" }, { date: "2026-09-24", startMinutes: 1080 });
    const [block] = await store.blocks.listBy("taskId", task.id);
    const moved = await services.schedule.moveBlock(block.id, { date: "2026-09-25", startMinutes: 1080 });
    expect(moved).toMatchObject({ date: "2026-09-25", originalDate: "2026-09-24", rescheduleCount: 1 });
    // Time-only moves are not reschedules
    const timeMoved = await services.schedule.moveBlock(block.id, { date: "2026-09-25", startMinutes: 600 });
    expect(timeMoved.rescheduleCount).toBe(1);
    expect(await store.tasks.list()).toHaveLength(1);
  });

  it("splits a block into two segments of the same task and merges them back", async () => {
    const { services, store } = setupServices();
    const task = await services.tasks.create({ title: "Frontend Learning", estimatedMinutes: 120 }, { date: "2026-09-24", startMinutes: 540 });
    const [block] = await store.blocks.listBy("taskId", task.id);
    const [a, b] = await services.schedule.splitBlock(block.id, 60, { date: "2026-09-25", startMinutes: 540 });
    expect(a.durationMinutes).toBe(60);
    expect(b).toMatchObject({ taskId: task.id, date: "2026-09-25", durationMinutes: 60 });
    expect(await store.tasks.list()).toHaveLength(1);
    const merged = await services.schedule.mergeBlocks([a.id, b.id]);
    expect(merged.durationMinutes).toBe(120);
    expect(await store.blocks.listBy("taskId", task.id)).toHaveLength(1);
  });

  it("completing the last block completes the task and records actual time", async () => {
    const { services, store, clock } = setupServices();
    const task = await services.tasks.create({ title: "Deep work", estimatedMinutes: 60 }, { date: "2026-09-24", startMinutes: 600 });
    const [block] = await store.blocks.listBy("taskId", task.id);
    await services.time.start(task.id, block.id);
    expect((await store.tasks.get(task.id))!.status).toBe("in_progress");
    clock.advance(85);
    const done = await services.schedule.completeBlock(block.id);
    expect(done.actualMinutes).toBe(85);
    const saved = await store.tasks.get(task.id);
    expect(saved!.status).toBe("completed");
    expect(saved!.completedAt).not.toBeNull();
    expect(await services.time.running()).toBeUndefined();
  });

  it("completing one of two segments keeps the task open", async () => {
    const { services, store } = setupServices();
    const task = await services.tasks.create({ title: "Split", estimatedMinutes: 120 }, { date: "2026-09-24", startMinutes: 540 });
    const [block] = await store.blocks.listBy("taskId", task.id);
    const [a] = await services.schedule.splitBlock(block.id, 60, { date: "2026-09-25", startMinutes: 540 });
    await services.schedule.completeBlock(a.id);
    expect((await store.tasks.get(task.id))!.status).toBe("planned");
  });

  it("recurring tasks materialise instances idempotently without back-filling", async () => {
    const { services, store } = setupServices(new Date(2026, 8, 24, 10)); // Thu
    const task = await services.tasks.create({
      title: "Gym",
      estimatedMinutes: 60,
      recurrence: { frequency: "weekly", interval: 1, weekdays: [1, 4], dayOfMonth: null, startDate: "2026-09-01", endDate: null, startMinutes: 1080 },
    });
    const first = await store.blocks.listBy("taskId", task.id);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((b) => b.date >= "2026-09-24")).toBe(true);
    await services.schedule.materializeRecurring();
    expect(await store.blocks.listBy("taskId", task.id)).toHaveLength(first.length);
    // Moving an occurrence does not regenerate it
    await services.schedule.moveBlock(first[0].id, { date: "2026-09-25", startMinutes: 1080 });
    await services.schedule.materializeRecurring();
    expect(await store.blocks.listBy("taskId", task.id)).toHaveLength(first.length);
  });

  it("scheduleNextSlot schedules the remaining estimate, floored at 15m", async () => {
    const { services } = setupServices(new Date(2026, 8, 24, 10));
    await services.data.saveSettings({ dayStartMinutes: 540, dayEndMinutes: 1140, defaultBreakMinutes: 0 });
    // Fully scheduled task: "schedule in next slot" must add a small 15m
    // top-up, not another full-estimate block.
    const full = await services.tasks.create({ title: "Full", estimatedMinutes: 60 });
    await services.schedule.scheduleTask(full.id, { date: "2026-09-24", startMinutes: 540 });
    const topUp = await services.schedule.scheduleInNextSlot(full.id, "2026-09-24");
    expect(topUp.durationMinutes).toBe(15);
    // Partially scheduled task: schedules the true remaining amount.
    const partial = await services.tasks.create({ title: "Partial", estimatedMinutes: 90 });
    await services.schedule.scheduleTask(partial.id, { date: "2026-09-24", startMinutes: 900, durationMinutes: 60 });
    const rest = await services.schedule.scheduleInNextSlot(partial.id, "2026-09-24");
    expect(rest.durationMinutes).toBe(30);
  });

  it("rollover proposes moves and only applies after confirmation", async () => {
    const { services, store } = setupServices(new Date(2026, 8, 24, 20));
    await services.data.saveSettings({ dayStartMinutes: 540, dayEndMinutes: 1140, defaultBreakMinutes: 0 });
    const t1 = await services.tasks.create({ title: "A", estimatedMinutes: 60 }, { date: "2026-09-24", startMinutes: 540 });
    await services.tasks.create({ title: "B", estimatedMinutes: 60 }, { date: "2026-09-24", startMinutes: 660 });
    const changes = await services.schedule.proposeRollover("2026-09-24", "2026-09-25");
    expect(changes).toHaveLength(2);
    // Nothing moved yet
    const [b1] = await store.blocks.listBy("taskId", t1.id);
    expect(b1.date).toBe("2026-09-24");
    await services.schedule.applyChanges(changes);
    const blocks = await store.blocks.list();
    expect(blocks.every((b) => b.date === "2026-09-25")).toBe(true);
    const starts = blocks.map((b) => b.startMinutes).sort();
    expect(starts).toEqual([540, 600]);
  });
});

describe("time tracking", () => {
  it("start / pause / resume / stop accumulate entries", async () => {
    const { services, store, clock } = setupServices();
    const task = await services.tasks.create({ title: "Timer task" });
    await services.time.start(task.id);
    clock.advance(30);
    await services.time.pause();
    expect(await services.time.lastPaused()).toBeDefined();
    clock.advance(10);
    await services.time.resume();
    clock.advance(15);
    await services.time.stop();
    const entries = await store.timeEntries.listBy("taskId", task.id);
    expect(entries.map((e) => e.durationMinutes).sort()).toEqual([15, 30]);
    expect(await services.time.lastPaused()).toBeUndefined();
  });

  it("starting a new timer stops the running one", async () => {
    const { services, clock } = setupServices();
    const a = await services.tasks.create({ title: "A" });
    const b = await services.tasks.create({ title: "B" });
    await services.time.start(a.id);
    clock.advance(20);
    await services.time.start(b.id);
    const running = await services.time.running();
    expect(running!.taskId).toBe(b.id);
  });

  it("manual entries can be added and edited", async () => {
    const { services } = setupServices();
    const task = await services.tasks.create({ title: "Manual" });
    const entry = await services.time.addManual({ taskId: task.id, date: "2026-09-24", minutes: 45 });
    const edited = await services.time.updateEntry(entry.id, { minutes: 50 });
    expect(edited.durationMinutes).toBe(50);
    await expect(services.time.addManual({ taskId: task.id, date: "2026-09-24", minutes: 0 })).rejects.toThrow();
  });
});
