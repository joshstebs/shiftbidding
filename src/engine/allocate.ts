/**
 * The shift allocation engine.
 *
 * Deterministic: candidates are evaluated in a total order derived from the
 * configured policy plus stable tie-breakers (no randomness anywhere), so the
 * same input always produces the same roster.
 *
 * Explainable: every candidate examined for every shift gets an outcome with
 * machine-readable reason codes and a human-readable explanation, so an
 * allocation can be audited line by line after the fact.
 *
 * Configurable: all workplace policy (ordering, deadlines, multiple-shift
 * rules) comes from AllocationConfig — nothing about a specific collective
 * agreement is baked in.
 *
 * Allocation proceeds shift by shift in chronological order (earliest start
 * first, shift id as the final stable tie-break), which mirrors how a
 * scheduler fills a roster day and keeps results stable when shifts are added.
 */

import {
  type AllocationConfig,
  type AllocationResult,
  type Bid,
  type CandidateOutcome,
  type Employee,
  type RejectedBid,
  type Shift,
  type ShiftAllocation,
  type TimeOff
} from "./types.js";
import {
  assertNoDuplicateBids,
  overlaps,
  validateBid,
  validateConfig,
  validateEmployee,
  validateShift,
  validateTimeOff,
  ValidationError
} from "./validate.js";

const DEFAULT_CONFIG: AllocationConfig = {
  ordering: "seniority",
  allowMultipleShifts: false
};

function explanationFor(reasons: string[]): string {
  if (reasons.length === 0) return "";
  return reasons.join("; ");
}

export interface AllocateInput {
  shifts: Shift[];
  employees: Employee[];
  bids: Bid[];
  timeOff?: TimeOff[];
  config?: Partial<AllocationConfig>;
}

export function allocate(input: AllocateInput): AllocationResult {
  const config: AllocationConfig = { ...DEFAULT_CONFIG, ...input.config };
  validateConfig(config);

  const shifts = [...input.shifts];
  const employees = input.employees;
  const timeOff = input.timeOff ?? [];

  for (const shift of shifts) validateShift(shift);
  for (const employee of employees) validateEmployee(employee);
  for (const window of timeOff) validateTimeOff(window);

  const shiftsById = new Map(shifts.map(shift => [shift.id, shift]));
  const employeesById = new Map(employees.map(employee => [employee.id, employee]));

  assertNoDuplicateBids(input.bids);
  for (const bid of input.bids) validateBid(bid, shiftsById, employeesById);

  // Chronological shift order, id as the stable tie-break.
  const orderedShifts = [...shifts].sort((a, b) => {
    const byStart = Date.parse(a.start) - Date.parse(b.start);
    return byStart !== 0 ? byStart : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const allocations: ShiftAllocation[] = [];
  const rejectedBids: RejectedBid[] = [];
  const assignmentsByEmployee: Record<string, string[]> = {};
  const allocatedCount = new Map<string, number>();
  const bidIndex = new Map<string, Bid>();
  for (const bid of input.bids) bidIndex.set(`${bid.employeeId}\u0000${bid.shiftId}`, bid);

  // Reject bids that fall outside the configured submission window.
  if (config.bidDeadline !== undefined) {
    const deadline = Date.parse(config.bidDeadline);
    for (const bid of input.bids) {
      if (Date.parse(bid.submittedAt) > deadline) {
        rejectedBids.push({
          shiftId: bid.shiftId,
          employeeId: bid.employeeId,
          reasons: ["bid_after_deadline"],
          explanation: explanationFor(["bid_after_deadline"])
        });
      }
    }
  }
  const rejectedKeys = new Set(rejectedBids.map(rejected => `${rejected.employeeId}\u0000${rejected.shiftId}`));

  // Group the still-eligible bids by shift, then evaluate each shift in order.
  const bidsByShift = new Map<string, Bid[]>();
  for (const bid of input.bids) {
    if (rejectedKeys.has(`${bid.employeeId}\u0000${bid.shiftId}`)) continue;
    const list = bidsByShift.get(bid.shiftId) ?? [];
    list.push(bid);
    bidsByShift.set(bid.shiftId, list);
  }

  /** Held allocations so far — used for cross-shift conflict detection. */
  const heldShiftsByEmployee = new Map<string, Shift[]>();

  for (const shift of orderedShifts) {
    const bidsForShift = (bidsByShift.get(shift.id) ?? []).slice();
    const candidates: CandidateOutcome[] = [];
    const allocatedTo: string[] = [];

    // Candidate order: primary policy, then stable tie-breakers.
    //   seniority ordering: rank -> seniorityDate -> submittedAt -> employeeId
    //   submittedAt ordering: submittedAt -> rank/seniorityDate -> employeeId
    bidsForShift.sort((a, b) => {
      const employeeA = employeesById.get(a.employeeId)!;
      const employeeB = employeesById.get(b.employeeId)!;
      if (config.ordering === "submittedAt") {
        const byTime = Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
        if (byTime !== 0) return byTime;
      }
      const rankA = employeeA.seniorityRank ?? Number.MAX_SAFE_INTEGER;
      const rankB = employeeB.seniorityRank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      const bySeniority = Date.parse(employeeA.seniorityDate) - Date.parse(employeeB.seniorityDate);
      if (bySeniority !== 0) return bySeniority;
      if (config.ordering === "seniority") {
        const byTime = Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
        if (byTime !== 0) return byTime;
      }
      return a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0;
    });

    let order = 0;
    for (const bid of bidsForShift) {
      order += 1;
      const employee = employeesById.get(bid.employeeId)!;
      const reasons: string[] = [];

      if (!employee.active) reasons.push("employee_inactive");
      if (allocatedTo.includes(employee.id)) reasons.push("already_allocated_this_shift");
      if (!config.allowMultipleShifts && (heldShiftsByEmployee.get(employee.id)?.length ?? 0) > 0) {
        reasons.push("already_allocated_other_shift");
      }
      if (config.allowMultipleShifts) {
        const held = heldShiftsByEmployee.get(employee.id)?.length ?? 0;
        const limit = config.maxShiftsPerEmployee;
        if (limit !== undefined && held >= limit) reasons.push("max_shifts_reached");
      }
      for (const required of shift.requiredQualifications) {
        if (!employee.qualifications.includes(required)) reasons.push(`missing_qualification:${required}`);
      }
      for (const window of timeOff) {
        if (window.employeeId !== employee.id) continue;
        if (overlaps(window.start, window.end, shift.start, shift.end)) {
          reasons.push(`time_off_conflict${window.reason ? `:${window.reason}` : ""}`);
        }
      }
      for (const held of heldShiftsByEmployee.get(employee.id) ?? []) {
        if (overlaps(held.start, held.end, shift.start, shift.end)) {
          reasons.push(`overlapping_shift:${held.id}`);
        }
      }
      if (shift.requiredCount - allocatedTo.length <= 0) reasons.push("shift_full");

      const outcome: CandidateOutcome = reasons.length
        ? { employeeId: employee.id, order, outcome: "rejected", reasons, explanation: explanationFor(reasons) }
        : { employeeId: employee.id, order, outcome: "allocated", reasons: [], explanation: "" };

      candidates.push(outcome);
      if (outcome.outcome === "allocated") {
        allocatedTo.push(employee.id);
        const held = heldShiftsByEmployee.get(employee.id) ?? [];
        held.push(shift);
        heldShiftsByEmployee.set(employee.id, held);
        allocatedCount.set(employee.id, (allocatedCount.get(employee.id) ?? 0) + 1);
        (assignmentsByEmployee[employee.id] ??= []).push(shift.id);
      }
    }

    allocations.push({
      shiftId: shift.id,
      filled: allocatedTo.length,
      requiredCount: shift.requiredCount,
      allocatedTo: [...allocatedTo],
      candidates,
      status:
        allocatedTo.length >= shift.requiredCount
          ? "filled"
          : allocatedTo.length > 0
            ? "partially_filled"
            : "unfilled"
    });
  }

  return {
    allocations,
    rejectedBids,
    assignmentsByEmployee,
    deterministic: true
  };
}

export { ValidationError };
