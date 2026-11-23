/**
 * Input validation for the allocation engine.
 *
 * The engine fails closed: any structurally invalid input produces explicit
 * errors before allocation runs, so a malformed schedule can never silently
 * produce a plausible-looking roster.
 */

import type { AllocationConfig, Bid, Employee, Shift, TimeOff } from "./types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function parseInstant(value: string, field: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ValidationError(`${field} is not a valid ISO datetime: ${JSON.stringify(value)}`);
  }
  return time;
}

function requireNonEmptyId(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
}

export function validateShift(shift: Shift): void {
  requireNonEmptyId(shift.id, "shift.id");
  const start = parseInstant(shift.start, `shift ${shift.id} start`);
  const end = parseInstant(shift.end, `shift ${shift.id} end`);
  if (end <= start) {
    throw new ValidationError(`shift ${shift.id} ends at or before it starts`);
  }
  if (!Number.isInteger(shift.requiredCount) || shift.requiredCount < 1) {
    throw new ValidationError(`shift ${shift.id} requiredCount must be an integer >= 1`);
  }
  if (!Array.isArray(shift.requiredQualifications)) {
    throw new ValidationError(`shift ${shift.id} requiredQualifications must be an array`);
  }
}

export function validateEmployee(employee: Employee): void {
  requireNonEmptyId(employee.id, "employee.id");
  parseInstant(employee.seniorityDate, `employee ${employee.id} seniorityDate`);
  if (!Array.isArray(employee.qualifications)) {
    throw new ValidationError(`employee ${employee.id} qualifications must be an array`);
  }
  if (typeof employee.active !== "boolean") {
    throw new ValidationError(`employee ${employee.id} active must be a boolean`);
  }
  if (
    employee.seniorityRank !== undefined &&
    (!Number.isInteger(employee.seniorityRank) || employee.seniorityRank < 1)
  ) {
    throw new ValidationError(`employee ${employee.id} seniorityRank must be an integer >= 1 when present`);
  }
}

export function validateBid(bid: Bid, shifts: Map<string, Shift>, employees: Map<string, Employee>): void {
  requireNonEmptyId(bid.shiftId, "bid.shiftId");
  requireNonEmptyId(bid.employeeId, "bid.employeeId");
  parseInstant(bid.submittedAt, `bid (${bid.employeeId} -> ${bid.shiftId}) submittedAt`);
  if (!shifts.has(bid.shiftId)) {
    throw new ValidationError(`bid references unknown shift ${bid.shiftId}`);
  }
  if (!employees.has(bid.employeeId)) {
    throw new ValidationError(`bid references unknown employee ${bid.employeeId}`);
  }
}

export function validateTimeOff(window: TimeOff): void {
  requireNonEmptyId(window.employeeId, "timeOff.employeeId");
  const start = parseInstant(window.start, `timeOff ${window.employeeId} start`);
  const end = parseInstant(window.end, `timeOff ${window.employeeId} end`);
  if (end <= start) {
    throw new ValidationError(`timeOff ${window.employeeId} ends at or before it starts`);
  }
}

export function validateConfig(config: AllocationConfig): void {
  if (config.ordering !== "seniority" && config.ordering !== "submittedAt") {
    throw new ValidationError(`config.ordering must be "seniority" or "submittedAt"`);
  }
  if (config.bidDeadline !== undefined) parseInstant(config.bidDeadline, "config.bidDeadline");
  if (typeof config.allowMultipleShifts !== "boolean") {
    throw new ValidationError("config.allowMultipleShifts must be a boolean");
  }
  if (
    config.maxShiftsPerEmployee !== undefined &&
    (!Number.isInteger(config.maxShiftsPerEmployee) || config.maxShiftsPerEmployee < 1)
  ) {
    throw new ValidationError("config.maxShiftsPerEmployee must be an integer >= 1 when present");
  }
}

/** Duplicate bids (same employee + shift) are ambiguous — reject the input. */
export function assertNoDuplicateBids(bids: Bid[]): void {
  const seen = new Set<string>();
  for (const bid of bids) {
    const key = `${bid.employeeId}\u0000${bid.shiftId}`;
    if (seen.has(key)) {
      throw new ValidationError(`duplicate bid: employee ${bid.employeeId} bid twice on shift ${bid.shiftId}`);
    }
    seen.add(key);
  }
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}
