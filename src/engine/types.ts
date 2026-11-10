/**
 * Core domain types for the shift-bidding allocation engine.
 *
 * The engine is pure: it consumes plain data and returns plain data. All
 * workplace policy (seniority rules, qualification requirements, deadlines)
 * arrives as configuration, so no collective agreement or workplace rule is
 * hardcoded here.
 */

export type ISODateTime = string;

export interface Employee {
  id: string;
  /** Canonical seniority instant (e.g., hire date at 00:00 in the site timezone). */
  seniorityDate: ISODateTime;
  /**
   * Optional explicit rank override. Lower number = more senior. When present
   * it wins over seniorityDate, so a workplace whose seniority list is not
   * plain hire-date order can still be modeled.
   */
  seniorityRank?: number;
  /** Qualification codes the employee holds (e.g., "dispatch", "supervisor"). */
  qualifications: string[];
  /** Inactive employees are never allocated. */
  active: boolean;
}

export interface Shift {
  id: string;
  start: ISODateTime;
  end: ISODateTime;
  /** How many employees this shift needs. Must be >= 1. */
  requiredCount: number;
  /** Qualification codes an employee must hold to be eligible. */
  requiredQualifications: string[];
  /** Stable label for reports (e.g., "Day shift", "Patrol 4"). */
  label?: string;
}

/** A bid placed during the submission window. One per employee per shift. */
export interface Bid {
  shiftId: string;
  employeeId: string;
  /** Instant the bid was received. Used as a tie-breaker within equal seniority. */
  submittedAt: ISODateTime;
}

/** A time-off window during which an employee cannot be allocated. */
export interface TimeOff {
  employeeId: string;
  start: ISODateTime;
  end: ISODateTime;
  reason?: string;
}

/**
 * Workplace policy configuration. Every field is explicit so different
 * workplaces (or a renegotiated agreement) can be modeled without code
 * changes. See docs/AUDIT.md for the policy questions that must be
 * confirmed by management before operational use.
 */
export interface AllocationConfig {
  /**
   * Primary ordering for bidders on a shift:
   *  - "seniority": seniorityRank (if present) then seniorityDate, oldest first.
   *  - "submittedAt": first accepted bid wins (for workplaces without seniority).
   * A secondary tie-break always applies after the primary (see below).
   */
  ordering: "seniority" | "submittedAt";
  /** Bids submitted strictly after this instant are rejected. Omit = open window. */
  bidDeadline?: ISODateTime;
  /**
   * When true, an employee may hold multiple non-overlapping allocations in
   * one run. When false (default), the first allocation excludes the employee
   * from the rest of the round.
   */
  allowMultipleShifts: boolean;
  /**
   * Maximum shifts one employee can hold per run (checked when
   * allowMultipleShifts is true). Omit = unlimited.
   */
  maxShiftsPerEmployee?: number;
}

/** Outcome for one candidate examined during allocation. */
export interface CandidateOutcome {
  employeeId: string;
  /** Position of this candidate in the evaluation order (1 = first examined). */
  order: number;
  outcome: "allocated" | "rejected";
  /** Machine-readable reason codes. */
  reasons: string[];
  /** Human-readable explanation assembled from the reasons. */
  explanation: string;
}

/** Result of allocating one shift. */
export interface ShiftAllocation {
  shiftId: string;
  filled: number;
  requiredCount: number;
  allocatedTo: string[];
  /** Every candidate examined, in evaluation order, with explanations. */
  candidates: CandidateOutcome[];
  /** "filled" | "partially_filled" | "unfilled" */
  status: "filled" | "partially_filled" | "unfilled";
}

/** A bid that could not participate, with the reason. */
export interface RejectedBid {
  shiftId: string;
  employeeId: string;
  reasons: string[];
  explanation: string;
}

export interface AllocationResult {
  allocations: ShiftAllocation[];
  rejectedBids: RejectedBid[];
  /** Employees and the shifts they ended up holding (stable order). */
  assignmentsByEmployee: Record<string, string[]>;
  /** True when running the same input again produces the identical result. */
  deterministic: true;
}
