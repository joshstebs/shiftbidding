# shiftbidding

Shift bidding and scheduling engine.

## Status

**In development — not approved for operational use.** The application surface
(authentication, database, bid UI, schedule views) does not exist yet; see
[docs/AUDIT.md](docs/AUDIT.md) for the full audit, the policy decisions that must be
confirmed before operational use, and the production-readiness assessment.

What exists today is the core allocation engine: deterministic, explainable,
configurable, and fully tested.

## The allocation engine

```ts
import { allocate } from "./src/engine/index.js";

const result = allocate({
  shifts: [{ id: "day-1", start: "2026-06-10T07:00:00-04:00", end: "2026-06-10T19:00:00-04:00",
             requiredCount: 2, requiredQualifications: ["dispatch"] }],
  employees: [{ id: "e1", seniorityDate: "2015-01-01T00:00:00Z", qualifications: ["dispatch"], active: true }],
  bids: [{ shiftId: "day-1", employeeId: "e1", submittedAt: "2026-06-01T12:00:00Z" }],
  timeOff: [],
  config: { ordering: "seniority", allowMultipleShifts: false, bidDeadline: "2026-06-05T12:00:00Z" }
});

// result.allocations[0].candidates → every candidate, in evaluation order,
// with machine-readable reasons and a human-readable explanation for each.
```

- **Deterministic** — a total candidate order with stable tie-breakers; no randomness.
- **Explainable** — every award and every rejection carries its reason.
- **Configurable** — seniority vs submission ordering, deadlines, multiple-shift rules;
  no workplace policy is hardcoded.
- **Fail-closed** — malformed input raises `ValidationError` instead of producing a roster.

## Development

```bash
npm install --include=dev   # (this machine's npm config omits dev deps by default)
npm test                    # node --test via tsx — 34 engine tests
npm run typecheck           # strict TypeScript
```
