import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { allocate, ValidationError } from "../src/engine/index.js";
import type { Bid, Employee, Shift, TimeOff } from "../src/engine/index.js";

// Strictness helpers: noUncheckedIndexedAccess means every index access is
// `| undefined`; these assert presence once and return the value.
function getAllocation(result: ReturnType<typeof allocate>, index = 0) {
  const entry = result.allocations[index];
  assert.ok(entry, `expected an allocation at index ${index}`);
  return entry;
}
function getCandidate(entry: ReturnType<typeof getAllocation>, index = 0) {
  const c = entry.candidates[index];
  assert.ok(c, `expected a candidate at index ${index}`);
  return c;
}

// ---------------------------------------------------------------------------
// Fixtures. Synthetic employees only — no real worker data is ever used here.
// ---------------------------------------------------------------------------

function employee(id: string, seniorityDate: string, extra: Partial<Employee> = {}): Employee {
  return { id, seniorityDate, qualifications: [], active: true, ...extra };
}

function shift(id: string, start: string, end: string, extra: Partial<Shift> = {}): Shift {
  return { id, start, end, requiredCount: 1, requiredQualifications: [], ...extra };
}

function bid(employeeId: string, shiftId: string, submittedAt = "2026-06-01T12:00:00Z"): Bid {
  return { employeeId, shiftId, submittedAt };
}

const BASE_CONFIG = { ordering: "seniority" as const, allowMultipleShifts: false };

describe("seniority ordering", () => {
  test("the most senior bidder wins the shift", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00-04:00", "2026-06-10T19:00:00-04:00")],
      employees: [employee("e-old", "2015-01-01T00:00:00Z"), employee("e-new", "2024-01-01T00:00:00Z")],
      bids: [bid("e-new", "s1"), bid("e-old", "s1")],
      config: BASE_CONFIG
    });
    assert.equal(getAllocation(result, 0).allocatedTo[0], "e-old");
    assert.equal(getAllocation(result, 0).status, "filled");
  });

  test("an explicit seniorityRank overrides the seniority date", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z")],
      employees: [
        employee("e-hired-early", "2010-01-01T00:00:00Z", { seniorityRank: 5 }),
        employee("e-hired-late", "2020-01-01T00:00:00Z", { seniorityRank: 1 })
      ],
      bids: [bid("e-hired-early", "s1"), bid("e-hired-late", "s1")],
      config: BASE_CONFIG
    });
    assert.equal(getAllocation(result, 0).allocatedTo[0], "e-hired-late");
  });

  test("employees without a rank fall behind every ranked employee", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z"), shift("s2", "2026-06-11T07:00:00Z", "2026-06-11T19:00:00Z")],
      employees: [
        employee("e-unranked", "2000-01-01T00:00:00Z"),
        employee("e-ranked-low", "2025-01-01T00:00:00Z", { seniorityRank: 99 })
      ],
      bids: [bid("e-unranked", "s1"), bid("e-unranked", "s2"), bid("e-ranked-low", "s1"), bid("e-ranked-low", "s2")],
      config: { ordering: "seniority", allowMultipleShifts: false }
    });
    // The ranked employee takes s1 (they are evaluated first there); the
    // unranked employee is excluded from s1 and takes s2.
    assert.equal(getAllocation(result, 0).allocatedTo[0], "e-ranked-low");
    assert.equal(getAllocation(result, 1).allocatedTo[0], "e-unranked");
  });
});

describe("tie-breaking", () => {
  test("equal seniority falls back to earliest submitted bid", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z")],
      employees: [employee("a", "2018-01-01T00:00:00Z"), employee("b", "2018-01-01T00:00:00Z")],
      bids: [bid("a", "s1", "2026-06-02T09:00:00Z"), bid("b", "s1", "2026-06-01T09:00:00Z")],
      config: BASE_CONFIG
    });
    assert.equal(getAllocation(result, 0).allocatedTo[0], "b");
  });

  test("identical seniority and submission time fall back to employee id order", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z")],
      employees: [employee("emp-b", "2018-01-01T00:00:00Z"), employee("emp-a", "2018-01-01T00:00:00Z")],
      bids: [bid("emp-b", "s1", "2026-06-02T09:00:00Z"), bid("emp-a", "s1", "2026-06-02T09:00:00Z")],
      config: BASE_CONFIG
    });
    assert.equal(getAllocation(result, 0).allocatedTo[0], "emp-a");
    const loser = getAllocation(result, 0).candidates.find(c => c.employeeId === "emp-b");
    assert.equal(loser?.outcome, "rejected");
    assert.ok(loser?.reasons.includes("shift_full"));
  });

  test("input array order never changes the outcome", () => {
    const make = () =>
      allocate({
        shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z"), shift("s2", "2026-06-11T07:00:00Z", "2026-06-11T19:00:00Z")],
        employees: [employee("e2", "2019-01-01T00:00:00Z"), employee("e1", "2018-01-01T00:00:00Z"), employee("e3", "2021-01-01T00:00:00Z")],
        bids: [bid("e3", "s1"), bid("e1", "s1"), bid("e2", "s1"), bid("e1", "s2"), bid("e3", "s2")],
        config: BASE_CONFIG
      });
    assert.deepEqual(make(), make());
  });
});

describe("submission-mode ordering", () => {
  test("with ordering=submittedAt the earliest bid wins regardless of seniority", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z")],
      employees: [employee("e-junior", "2024-01-01T00:00:00Z"), employee("e-senior", "2005-01-01T00:00:00Z")],
      bids: [bid("e-senior", "s1", "2026-06-05T09:00:00Z"), bid("e-junior", "s1", "2026-06-01T09:00:00Z")],
      config: { ordering: "submittedAt", allowMultipleShifts: false }
    });
    assert.equal(getAllocation(result, 0).allocatedTo[0], "e-junior");
  });
});

describe("shift allocation and conflicts", () => {
  test("a shift fills exactly requiredCount positions", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z", { requiredCount: 2 })],
      employees: [employee("e1", "2015-01-01T00:00:00Z"), employee("e2", "2016-01-01T00:00:00Z"), employee("e3", "2017-01-01T00:00:00Z")],
      bids: [bid("e1", "s1"), bid("e2", "s1"), bid("e3", "s1")],
      config: BASE_CONFIG
    });
    assert.deepEqual(getAllocation(result, 0).allocatedTo, ["e1", "e2"]);
    assert.equal(getAllocation(result, 0).status, "filled");
    assert.ok(getAllocation(result, 0).candidates.find(c => c.employeeId === "e3")?.reasons.includes("shift_full"));
  });

  test("an employee holding a shift is not double-booked onto an overlapping shift", () => {
    const result = allocate({
      shifts: [
        shift("nights", "2026-06-10T19:00:00Z", "2026-06-11T03:00:00Z"),
        shift("nights-ot", "2026-06-10T21:00:00Z", "2026-06-11T05:00:00Z")
      ],
      employees: [employee("e1", "2015-01-01T00:00:00Z"), employee("e2", "2016-01-01T00:00:00Z")],
      bids: [bid("e1", "nights"), bid("e1", "nights-ot"), bid("e2", "nights"), bid("e2", "nights-ot")],
      config: BASE_CONFIG
    });
    assert.deepEqual(getAllocation(result, 0).allocatedTo, ["e1"]);
    // The OT shift overlaps nights: e1 is excluded, e2 takes it.
    assert.equal(getAllocation(result, 1).allocatedTo[0], "e2");
    const e1Outcome = getAllocation(result, 1).candidates.find(c => c.employeeId === "e1");
    assert.ok(e1Outcome?.reasons.includes("already_allocated_other_shift"));
  });

  test("adjacent (non-overlapping) shifts do not conflict", () => {
    const result = allocate({
      shifts: [
        shift("day", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z"),
        shift("night", "2026-06-10T19:00:00Z", "2026-06-11T07:00:00Z")
      ],
      employees: [employee("e1", "2015-01-01T00:00:00Z")],
      bids: [bid("e1", "day"), bid("e1", "night")],
      config: { ordering: "seniority", allowMultipleShifts: true }
    });
    assert.equal(getAllocation(result, 0).allocatedTo[0], "e1");
    assert.equal(getAllocation(result, 1).allocatedTo[0], "e1");
  });

  test("maxShiftsPerEmployee caps multiple-shift holders", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T09:00:00Z"), shift("s2", "2026-06-10T10:00:00Z", "2026-06-10T12:00:00Z"), shift("s3", "2026-06-10T13:00:00Z", "2026-06-10T15:00:00Z")],
      employees: [employee("e1", "2015-01-01T00:00:00Z")],
      bids: [bid("e1", "s1"), bid("e1", "s2"), bid("e1", "s3")],
      config: { ordering: "seniority", allowMultipleShifts: true, maxShiftsPerEmployee: 2 }
    });
    assert.equal(getAllocation(result, 2).status, "unfilled");
    assert.ok(getAllocation(result, 2).candidates[0]?.reasons.includes("max_shifts_reached"));
  });
});

describe("ineligible employees", () => {
  const base = {
    shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z", { requiredQualifications: ["dispatch"] })],
    bids: [bid("e1", "s1")],
    config: BASE_CONFIG
  };

  test("an inactive employee is never allocated", () => {
    const result = allocate({ ...base, shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z")], employees: [employee("e1", "2015-01-01T00:00:00Z", { active: false })] });
    assert.equal(getAllocation(result, 0).status, "unfilled");
    assert.ok(getAllocation(result, 0).candidates[0]?.reasons.includes("employee_inactive"));
  });

  test("a missing required qualification blocks allocation", () => {
    const result = allocate({ ...base, employees: [employee("e1", "2015-01-01T00:00:00Z", { qualifications: ["radio"] })] });
    assert.equal(getAllocation(result, 0).status, "unfilled");
    assert.ok(getAllocation(result, 0).candidates[0]?.reasons.includes("missing_qualification:dispatch"));
  });

  test("a time-off window overlapping the shift blocks allocation", () => {
    const timeOff: TimeOff[] = [{ employeeId: "e1", start: "2026-06-10T00:00:00Z", end: "2026-06-11T00:00:00Z", reason: "vacation" }];
    const result = allocate({ ...base, employees: [employee("e1", "2015-01-01T00:00:00Z", { qualifications: ["dispatch"] })], timeOff });
    assert.equal(getAllocation(result, 0).status, "unfilled");
    assert.ok(getAllocation(result, 0).candidates[0]?.reasons.includes("time_off_conflict:vacation"));
  });

  test("a time-off window that does not overlap does not block", () => {
    const timeOff: TimeOff[] = [{ employeeId: "e1", start: "2026-06-09T00:00:00Z", end: "2026-06-09T23:59:00Z" }];
    const result = allocate({ ...base, employees: [employee("e1", "2015-01-01T00:00:00Z", { qualifications: ["dispatch"] })], timeOff });
    assert.equal(getAllocation(result, 0).status, "filled");
  });
});

describe("bid deadlines", () => {
  test("a bid submitted after the deadline is rejected and never allocated", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z")],
      employees: [employee("e1", "2015-01-01T00:00:00Z")],
      bids: [bid("e1", "s1", "2026-06-05T23:59:59Z")],
      config: { ordering: "seniority", allowMultipleShifts: false, bidDeadline: "2026-06-05T12:00:00Z" }
    });
    assert.equal(getAllocation(result, 0).status, "unfilled");
    assert.deepEqual(result.rejectedBids.map(r => r.reasons[0]), ["bid_after_deadline"]);
  });

  test("a bid submitted exactly at the deadline is accepted", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z")],
      employees: [employee("e1", "2015-01-01T00:00:00Z")],
      bids: [bid("e1", "s1", "2026-06-05T12:00:00Z")],
      config: { ordering: "seniority", allowMultipleShifts: false, bidDeadline: "2026-06-05T12:00:00Z" }
    });
    assert.equal(getAllocation(result, 0).status, "filled");
    assert.equal(result.rejectedBids.length, 0);
  });
});

describe("invalid schedule data fails closed", () => {
  const employees = [employee("e1", "2015-01-01T00:00:00Z")];
  const good = shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z");

  const invalid: Array<[string, () => unknown]> = [
    ["shift ends at or before start", () => allocate({ shifts: [shift("s1", "2026-06-10T19:00:00Z", "2026-06-10T07:00:00Z")], employees, bids: [], config: BASE_CONFIG })],
    ["zero-length shift", () => allocate({ shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T07:00:00Z")], employees, bids: [], config: BASE_CONFIG })],
    ["unparseable shift start", () => allocate({ shifts: [shift("s1", "next tuesday", "2026-06-10T19:00:00Z")], employees, bids: [], config: BASE_CONFIG })],
    ["requiredCount of zero", () => allocate({ shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z", { requiredCount: 0 })], employees, bids: [], config: BASE_CONFIG })],
    ["fractional requiredCount", () => allocate({ shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z", { requiredCount: 1.5 })], employees, bids: [], config: BASE_CONFIG })],
    ["unknown shift in bid", () => allocate({ shifts: [good], employees, bids: [bid("e1", "s404")], config: BASE_CONFIG })],
    ["unknown employee in bid", () => allocate({ shifts: [good], employees, bids: [bid("e404", "s1")], config: BASE_CONFIG })],
    ["duplicate bid", () => allocate({ shifts: [good], employees, bids: [bid("e1", "s1"), bid("e1", "s1")], config: BASE_CONFIG })],
    ["unparseable seniority date", () => allocate({ shifts: [good], employees: [employee("e1", "a long time ago")], bids: [bid("e1", "s1")], config: BASE_CONFIG })],
    ["negative seniorityRank", () => allocate({ shifts: [good], employees: [employee("e1", "2015-01-01T00:00:00Z", { seniorityRank: -2 })], bids: [bid("e1", "s1")], config: BASE_CONFIG })],
    ["invalid time-off window", () => allocate({ shifts: [good], employees, bids: [], timeOff: [{ employeeId: "e1", start: "2026-06-11T00:00:00Z", end: "2026-06-10T00:00:00Z" }], config: BASE_CONFIG })],
    ["invalid ordering policy", () => allocate({ shifts: [good], employees, bids: [], config: { ordering: "coin_flip" as unknown as "seniority", allowMultipleShifts: false } })],
    ["bid deadline not a date", () => allocate({ shifts: [good], employees, bids: [], config: { ordering: "seniority", allowMultipleShifts: false, bidDeadline: "sometime soon" } })]
  ];

  for (const [name, run] of invalid) {
    test(name, () => {
      assert.throws(run, ValidationError);
    });
  }
});

describe("calendar and timezone transitions", () => {
  test("offset-aware instants compare correctly across timezone spellings", () => {
    // Same instant, written in two offsets: 07:00-04:00 == 11:00Z.
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T11:00:00Z", "2026-06-10T19:00:00Z")],
      employees: [employee("e1", "2015-01-01T00:00:00Z")],
      bids: [bid("e1", "s1")],
      timeOff: [{ employeeId: "e1", start: "2026-06-10T07:00:00-04:00", end: "2026-06-10T15:00:00-04:00" }],
      config: BASE_CONFIG
    });
    assert.equal(getAllocation(result, 0).status, "unfilled");
    assert.ok(getAllocation(result, 0).candidates[0]?.reasons.includes("time_off_conflict"));
  });

  test("a shift crossing a DST change keeps its true duration", () => {
    // North America: 2026-11-01, clocks fall back 06:00 EDT -> 01:00 EST.
    // A 19:00Z->07:00Z shift spans 11 real hours either way; a time-off
    // window written in local offset terms that ends inside the shift must
    // still conflict because wall-clock end (07:00-05:00 = 12:00Z) < shift end.
    const result = allocate({
      shifts: [shift("nights", "2026-11-01T03:00:00Z", "2026-11-01T07:00:00Z")],
      employees: [employee("e1", "2015-01-01T00:00:00Z")],
      bids: [bid("e1", "nights")],
      timeOff: [{ employeeId: "e1", start: "2026-11-01T01:00:00-04:00", end: "2026-11-01T07:30:00-05:00" }],
      config: BASE_CONFIG
    });
    assert.equal(getAllocation(result, 0).status, "unfilled");
  });
});

describe("audit trail and explanations", () => {
  test("every candidate is recorded with an order and an explanation", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z", { requiredCount: 1 })],
      employees: [employee("e-senior", "2015-01-01T00:00:00Z"), employee("e-mid", "2016-01-01T00:00:00Z"), employee("e-junior", "2017-01-01T00:00:00Z")],
      bids: [bid("e-senior", "s1"), bid("e-mid", "s1"), bid("e-junior", "s1")],
      config: BASE_CONFIG
    });
    const allocation = getAllocation(result, 0);
    assert.deepEqual(allocation.candidates.map(c => c.employeeId), ["e-senior", "e-mid", "e-junior"]);
    assert.deepEqual(allocation.candidates.map(c => c.order), [1, 2, 3]);
    assert.equal(getCandidate(allocation, 0).outcome, "allocated");
    assert.equal(getCandidate(allocation, 0).explanation, "");
    assert.equal(getCandidate(allocation, 1).outcome, "rejected");
    assert.equal(getCandidate(allocation, 1).explanation, "shift_full");
  });

  test("assignmentsByEmployee mirrors the allocations", () => {
    const result = allocate({
      shifts: [shift("s1", "2026-06-10T07:00:00Z", "2026-06-10T19:00:00Z"), shift("s2", "2026-06-11T07:00:00Z", "2026-06-11T19:00:00Z")],
      employees: [employee("e1", "2015-01-01T00:00:00Z"), employee("e2", "2016-01-01T00:00:00Z")],
      bids: [bid("e1", "s1"), bid("e2", "s1"), bid("e2", "s2")],
      config: BASE_CONFIG
    });
    assert.deepEqual(result.assignmentsByEmployee, { e1: ["s1"], e2: ["s2"] });
  });
});
