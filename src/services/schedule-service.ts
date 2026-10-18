import { addDaysKey, toDateKey, type DateKey, type DateRange } from "@/lib/date";
import type { PlanChange } from "@/lib/planning/changes";
import { occurrencesInRange } from "@/lib/recurrence";
import { findNextAvailableSlot, type WorkingHours } from "@/lib/scheduling/slots";
import { createId } from "@/lib/utils/id";
import { scheduleBlockSchema, type ScheduleBlock, type Task } from "@/types/domain";
import { DomainError, must, type ServiceContext } from "./context";
import type { ScheduleInput, TaskService } from "./task-service";
import type { TimeService } from "./time-service";

/** How far ahead recurring tasks are materialised into blocks. */
export const RECURRENCE_HORIZON_DAYS = 35;

export function createScheduleService(
  ctx: ServiceContext,
  deps: { tasks: () => TaskService; time: () => TimeService },
) {
  const { store } = ctx;
  const iso = () => ctx.now().toISOString();
  const today = () => toDateKey(ctx.now());

  function newBlock(taskId: string, input: Required<ScheduleInput>, occurrenceDate: DateKey | null = null): ScheduleBlock {
    const now = iso();
    return scheduleBlockSchema.parse({
      id: createId("blk"),
      taskId,
      date: input.date,
      startMinutes: input.startMinutes,
      durationMinutes: Math.max(5, Math.round(input.durationMinutes)),
      status: "planned",
      actualMinutes: null,
      originalDate: input.date,
      rescheduleCount: 0,
      occurrenceDate,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Remaining unscheduled estimate for a task (never below 15m). */
  async function remainingEstimate(task: Task): Promise<number> {
    const blocks = await store.blocks.listBy("taskId", task.id);
    const scheduled = blocks.filter((b) => b.status !== "skipped").reduce((s, b) => s + b.durationMinutes, 0);
    const remaining = task.estimatedMinutes - scheduled;
    return Math.max(15, remaining);
  }

  async function scheduleTask(taskId: string, input: ScheduleInput): Promise<ScheduleBlock> {
    const task = await must(store.tasks.get(taskId), "Task");
    if (task.status === "completed" || task.status === "cancelled") {
      await store.tasks.put({ ...task, status: "planned", completedAt: null, updatedAt: iso() });
    }
    const duration = input.durationMinutes ?? (await remainingEstimate(task));
    const block = newBlock(taskId, { date: input.date, startMinutes: input.startMinutes, durationMinutes: duration });
    await store.blocks.put(block);
    await deps.tasks().syncStatus(taskId);
    return block;
  }

  /**
   * Moves a block in time and/or date. Moving to another day increments the
   * reschedule counter (informational only — never shown as failure).
   */
  async function moveBlock(blockId: string, to: { date: DateKey; startMinutes: number | null }): Promise<ScheduleBlock> {
    const block = await must(store.blocks.get(blockId), "Block");
    const dateChanged = block.date !== to.date;
    const next: ScheduleBlock = {
      ...block,
      date: to.date,
      startMinutes: to.startMinutes,
      rescheduleCount: block.rescheduleCount + (dateChanged ? 1 : 0),
      // A skipped block that gets moved becomes planned again.
      status: block.status === "skipped" ? "planned" : block.status,
      updatedAt: iso(),
    };
    await store.blocks.put(next);
    await deps.tasks().syncStatus(block.taskId);
    return next;
  }

  async function updateBlock(
    blockId: string,
    patch: Partial<Pick<ScheduleBlock, "durationMinutes" | "startMinutes" | "date" | "actualMinutes">>,
  ): Promise<ScheduleBlock> {
    const block = await must(store.blocks.get(blockId), "Block");
    if (patch.date && patch.date !== block.date) {
      await moveBlock(blockId, { date: patch.date, startMinutes: patch.startMinutes ?? block.startMinutes });
      return updateBlock(blockId, { ...patch, date: undefined, startMinutes: undefined });
    }
    const next = scheduleBlockSchema.parse({
      ...block,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      updatedAt: iso(),
    });
    await store.blocks.put(next);
    return next;
  }

  async function resizeBlock(blockId: string, durationMinutes: number) {
    return updateBlock(blockId, { durationMinutes: Math.max(15, Math.round(durationMinutes)) });
  }

  /** Removes the block; the task returns to the unscheduled pool. */
  async function unscheduleBlock(blockId: string): Promise<void> {
    const block = await must(store.blocks.get(blockId), "Block");
    await store.blocks.delete(blockId);
    await deps.tasks().syncStatus(block.taskId);
  }

  /**
   * Splits a block into two segments of the same task. The first keeps its
   * place with `firstMinutes`; the remainder goes to `second`.
   */
  async function splitBlock(
    blockId: string,
    firstMinutes: number,
    second: { date: DateKey; startMinutes: number | null },
  ): Promise<[ScheduleBlock, ScheduleBlock]> {
    const block = await must(store.blocks.get(blockId), "Block");
    if (block.status !== "planned") throw new DomainError("Only planned blocks can be split");
    const rest = block.durationMinutes - firstMinutes;
    if (firstMinutes < 5 || rest < 5) throw new DomainError("Both parts must be at least 5 minutes");
    const first: ScheduleBlock = { ...block, durationMinutes: firstMinutes, updatedAt: iso() };
    const other: ScheduleBlock = {
      ...newBlock(block.taskId, { ...second, durationMinutes: rest }),
      originalDate: block.originalDate,
    };
    await store.blocks.putMany([first, other]);
    return [first, other];
  }

  /** Merges several planned blocks of the same task into the earliest one. */
  async function mergeBlocks(blockIds: string[]): Promise<ScheduleBlock> {
    const blocks = await Promise.all(blockIds.map((id) => must(store.blocks.get(id), "Block")));
    if (blocks.length < 2) throw new DomainError("Select at least two blocks to merge");
    if (new Set(blocks.map((b) => b.taskId)).size !== 1) throw new DomainError("Blocks must belong to the same task");
    if (blocks.some((b) => b.status !== "planned")) throw new DomainError("Only planned blocks can be merged");
    const sorted = [...blocks].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.startMinutes ?? 0) - (b.startMinutes ?? 0),
    );
    const [keep, ...rest] = sorted;
    const merged: ScheduleBlock = {
      ...keep,
      durationMinutes: sorted.reduce((s, b) => s + b.durationMinutes, 0),
      updatedAt: iso(),
    };
    await store.blocks.put(merged);
    // Re-point time entries at the surviving block.
    const entries = (await store.timeEntries.listBy("taskId", keep.taskId)).filter(
      (e) => e.blockId && rest.some((r) => r.id === e.blockId),
    );
    await store.timeEntries.putMany(entries.map((e) => ({ ...e, blockId: keep.id })));
    await store.blocks.deleteMany(rest.map((b) => b.id));
    return merged;
  }

  /**
   * Marks a block done. Actual duration = explicit value, else tracked time
   * for this block, else the planned duration. When it was the task's last
   * open block (and the task isn't recurring) the task is completed too.
   */
  async function completeBlock(
    blockId: string,
    options: { actualMinutes?: number; cascade?: boolean } = {},
  ): Promise<ScheduleBlock> {
    const block = await must(store.blocks.get(blockId), "Block");
    await deps.time().stopForBlock(blockId);
    const tracked = (await store.timeEntries.listBy("taskId", block.taskId))
      .filter((e) => e.blockId === blockId)
      .reduce((s, e) => s + e.durationMinutes, 0);
    const actual = options.actualMinutes ?? (tracked > 0 ? Math.round(tracked) : block.durationMinutes);
    const next: ScheduleBlock = {
      ...block,
      status: "completed",
      actualMinutes: actual,
      completedAt: iso(),
      updatedAt: iso(),
    };
    await store.blocks.put(next);

    if (options.cascade !== false) {
      const task = await store.tasks.get(block.taskId);
      if (task && !task.recurrence && task.status !== "completed") {
        const siblings = await store.blocks.listBy("taskId", task.id);
        const open = siblings.filter((b) => b.status === "planned");
        if (open.length === 0) {
          await store.tasks.put({ ...task, status: "completed", completedAt: iso(), updatedAt: iso() });
        } else {
          await deps.tasks().syncStatus(task.id);
        }
      }
    }
    return next;
  }

  async function skipBlock(blockId: string): Promise<ScheduleBlock> {
    const block = await must(store.blocks.get(blockId), "Block");
    await deps.time().stopForBlock(blockId);
    const next: ScheduleBlock = { ...block, status: "skipped", updatedAt: iso() };
    await store.blocks.put(next);
    await deps.tasks().syncStatus(block.taskId);
    return next;
  }

  async function reopenBlock(blockId: string): Promise<ScheduleBlock> {
    const block = await must(store.blocks.get(blockId), "Block");
    const next: ScheduleBlock = { ...block, status: "planned", completedAt: null, actualMinutes: null, updatedAt: iso() };
    await store.blocks.put(next);
    const task = await store.tasks.get(block.taskId);
    if (task?.status === "completed") {
      await store.tasks.put({ ...task, status: "planned", completedAt: null, updatedAt: iso() });
    }
    await deps.tasks().syncStatus(block.taskId);
    return next;
  }

  /** Schedules a task into the first free slot on/after `date` (from `notBefore` minutes). */
  async function scheduleInNextSlot(taskId: string, date: DateKey, notBefore = 0): Promise<ScheduleBlock> {
    const task = await must(store.tasks.get(taskId), "Task");
    const duration = await remainingEstimate(task);
    const [blocks, wh] = await Promise.all([store.blocks.listByRange("date", date, addDaysKey(date, 14)), hours()]);
    const slot = findNextAvailableSlot(blocks, date, notBefore, duration, wh);
    return scheduleTask(taskId, {
      date: slot?.date ?? date,
      startMinutes: slot?.startMinutes ?? null,
      durationMinutes: duration,
    });
  }

  // ------------------------------------------------------------ recurrence

  /** Creates missing blocks for a recurring task's occurrences in range. Idempotent. */
  async function materializeTask(task: Task, range?: DateRange): Promise<number> {
    if (!task.recurrence || task.status === "cancelled") return 0;
    const t = today();
    const window = range ?? { from: t, to: addDaysKey(t, RECURRENCE_HORIZON_DAYS) };
    // Never back-fill the past: missed recurrences simply don't exist.
    const from = window.from < t ? t : window.from;
    if (from > window.to) return 0;
    const dates = occurrencesInRange(task.recurrence, { from, to: window.to });
    if (dates.length === 0) return 0;
    const existing = await store.blocks.listBy("taskId", task.id);
    const covered = new Set(existing.map((b) => b.occurrenceDate).filter(Boolean));
    const created = dates
      .filter((d) => !covered.has(d))
      .map((d) =>
        newBlock(
          task.id,
          { date: d, startMinutes: task.recurrence!.startMinutes, durationMinutes: task.estimatedMinutes },
          d,
        ),
      );
    await store.blocks.putMany(created);
    if (created.length) await deps.tasks().syncStatus(task.id);
    return created.length;
  }

  async function materializeRecurring(range?: DateRange): Promise<number> {
    const tasks = (await store.tasks.list()).filter((t) => t.recurrence);
    let total = 0;
    for (const task of tasks) total += await materializeTask(task, range);
    return total;
  }

  /** After a recurrence rule changes: drop future untouched instances and regenerate. */
  async function regenerateRecurring(task: Task): Promise<void> {
    const t = today();
    const blocks = await store.blocks.listBy("taskId", task.id);
    const stale = blocks.filter(
      (b) => b.occurrenceDate && b.date >= t && b.status === "planned" && b.rescheduleCount === 0,
    );
    await store.blocks.deleteMany(stale.map((b) => b.id));
    await materializeTask(task);
  }

  // ------------------------------------------------------------ proposals

  async function hours(): Promise<WorkingHours> {
    const s = await store.settings.get();
    return {
      dayStartMinutes: s.dayStartMinutes,
      dayEndMinutes: s.dayEndMinutes,
      breakMinutes: s.defaultBreakMinutes,
      workingDays: s.workingDays,
    };
  }

  /**
   * Proposes moving every unfinished block dated before `targetDate` (or on
   * `fromDate`) to the next free slots starting at `targetDate`.
   */
  async function proposeRollover(fromDate: DateKey, targetDate: DateKey): Promise<PlanChange[]> {
    const [all, tasks, wh] = await Promise.all([store.blocks.list(), store.tasks.list(), hours()]);
    const titles = new Map(tasks.map((t) => [t.id, t.title]));
    const pending = all
      .filter((b) => b.status === "planned" && b.date <= fromDate && b.date < targetDate)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.startMinutes ?? 0) - (b.startMinutes ?? 0));
    const working = [...all];
    const changes: PlanChange[] = [];
    for (const block of pending) {
      const slot = findNextAvailableSlot(working, targetDate, 0, block.durationMinutes, wh, { ignoreBlockId: block.id });
      const to = slot ?? { date: targetDate, startMinutes: null };
      changes.push({
        kind: "move_block",
        blockId: block.id,
        title: titles.get(block.taskId) ?? "Task",
        from: { date: block.date, startMinutes: block.startMinutes },
        to,
      });
      const idx = working.findIndex((b) => b.id === block.id);
      working[idx] = { ...block, date: to.date, startMinutes: to.startMinutes };
    }
    return changes;
  }

  /** Applies confirmed changes. Returns number applied. */
  async function applyChanges(changes: PlanChange[]): Promise<number> {
    let applied = 0;
    for (const change of changes) {
      switch (change.kind) {
        case "move_block":
          await moveBlock(change.blockId, change.to);
          break;
        case "skip_block":
          await skipBlock(change.blockId);
          break;
        case "schedule_task":
          await scheduleTask(change.taskId, {
            date: change.date,
            startMinutes: change.startMinutes,
            durationMinutes: change.durationMinutes,
          });
          break;
        case "create_task":
          await deps.tasks().create(
            {
              title: change.title,
              areaId: change.areaId,
              projectId: change.projectId,
              priority: change.priority,
              estimatedMinutes: change.durationMinutes,
            },
            { date: change.date, startMinutes: change.startMinutes, durationMinutes: change.durationMinutes },
          );
          break;
      }
      applied++;
    }
    return applied;
  }

  return {
    scheduleTask,
    scheduleInNextSlot,
    moveBlock,
    updateBlock,
    resizeBlock,
    unscheduleBlock,
    splitBlock,
    mergeBlocks,
    completeBlock,
    skipBlock,
    reopenBlock,
    materializeTask,
    materializeRecurring,
    regenerateRecurring,
    proposeRollover,
    applyChanges,
    hours,
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
