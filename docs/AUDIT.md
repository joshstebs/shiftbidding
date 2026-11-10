# ShiftBidding — audit and status (2026-11-09)

Prepared by Bosun (Command Code agent) as part of the production-readiness assignment.

## 1. Audit findings — the most important fact first

**The repository contains no application source code.** Before this assignment the repo
held exactly one file: a one-line `README.md` ("Shift Bidding and scheduling engine").
There is no frontend, no backend, no database schema, no authentication, and no
scheduling engine to audit. This was independently verified before any work started:

- Single `main` branch, single "Initial commit" (2026-10-17), no other branches, no
  open PRs, no local or remote working copies anywhere on this host.
- An earlier investigation (botlog `plans/harbour-and-main-app-portfolio-2026-10-18.md`,
  GPT-6) reached the same conclusion via the GitHub contents/branches API: the original
  ShiftBidding source lived in a Codex/Work workspace that was never exported, and
  "0/5 sources transferred" across Apex, ShiftBidding, DealRadar, TariffWire and
  Lockerroom Swap. The Vercel project `stebs-co/shiftbidding` exists with zero
  deployments, consistent with a repo that cannot build.

**Consequence:** a "code audit" of the previous app is impossible — there is nothing to
audit. What follows is (a) an audit of the *specification* gap, (b) a real, tested
starting point: the deterministic allocation engine the mission statement emphasizes,
built as a pure, portable library with no framework lock-in, and (c) the decisions and
policy confirmations required before a full application is built.

If the original Codex/Work source is ever recovered, treat this engine as a
replacement candidate to be reviewed against it, not as a re-implementation of it —
the original's rules were never visible to any agent on this host.

## 2. What was implemented

`src/engine/` — a pure TypeScript allocation engine (zero runtime dependencies):

| Module | Responsibility |
| --- | --- |
| `types.ts` | Domain types (employees, shifts, bids, time-off, config, results) |
| `validate.ts` | Fail-closed input validation; interval overlap helper |
| `allocate.ts` | The allocation algorithm with per-candidate audit trail |
| `index.ts` | Public surface |

Guarantees:

- **Deterministic.** Candidates are evaluated in a total order (policy ordering →
  explicit rank → seniority date → submission time → employee id). There is no
  randomness anywhere; identical input produces byte-identical output, and input array
  order never matters (tested).
- **Explainable.** Every candidate examined for every shift records an `order`,
  machine-readable `reasons[]` (`employee_inactive`, `missing_qualification:dispatch`,
  `time_off_conflict:vacation`, `overlapping_shift:id`, `already_allocated_other_shift`,
  `max_shifts_reached`, `shift_full`, `bid_after_deadline`) and a human-readable
  `explanation`. Unfilled shifts explain themselves candidate by candidate, and
  `rejectedBids` explains bids that never entered the round (deadline).
- **Configurable.** Ordering policy (`seniority` or `submittedAt`), bid deadline,
  multiple-shift permission and per-employee caps are all `AllocationConfig` fields.
  Explicit `seniorityRank` overrides raw hire-date seniority, so a workplace whose
  seniority list is not plain hire-date order still works. Nothing about any specific
  collective agreement is baked in.
- **Fail-closed.** Malformed input (unparseable dates, zero-length or backwards shifts,
  `requiredCount < 1`, duplicate bids, unknown references, invalid policy values)
  raises `ValidationError` instead of producing a plausible-looking roster.

Allocation semantics (matching how a scheduler fills a board): shifts are processed in
chronological order (earliest start first, id as stable tie-break); on each shift,
eligible bidders are taken in policy order until `requiredCount` is met; conflicts are
detected across the whole run (overlapping held shifts, time-off windows, per-employee
caps).

## 3. Testing

`tests/engine.test.ts` — 34 tests, all passing, covering the mission's required areas:

- Seniority ordering (hire date, explicit rank override, unranked employees fall behind)
- Tie-breaking (seniority → submission time → employee id; input-order independence)
- Conflicting bids and overlapping-shift double-booking prevention
- Ineligible employees (inactive, missing qualification, time-off conflict, non-conflicting time-off passes)
- Allocation fill semantics (`requiredCount`, partial, unfilled, `maxShiftsPerEmployee`)
- Bid deadlines (late rejected with reason; exactly-at-deadline accepted)
- Invalid schedule data — 13 fail-closed cases
- Calendar/timezone transitions — offset-aware instants compare correctly across
  timezone spellings; DST-crossing windows conflict correctly
- Audit trail — candidate order, explanations, `assignmentsByEmployee` mirror
- Determinism — repeated runs deep-equal

Run with `npm test`; typecheck with `npm run typecheck` (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`). CI runs the same gates on every PR (`.github/workflows/ci.yml`).

## 4. Policy questions requiring formal confirmation

These are deliberately **not** decided in code. Each maps to an `AllocationConfig`
field or a future extension point; all need management/HR confirmation (and, where
applicable, the applicable collective agreement) before operational use:

1. **Seniority definition** — hire date? classification date? departmental or provincial list? Is the explicit `seniorityRank` override the right mechanism?
2. **Primary ordering policy** — is seniority-based awarding the rule, or first-come/first-served, or a hybrid (e.g., seniority among equally-qualified bidders)?
3. **Tie-break policy** — is "earliest submitted bid" the accepted tie-break after seniority, or should ties stay open for manual award?
4. **Shift configuration** — shift definitions, rotations, minimum staffing per qualification, and whether unfilled shifts go to mandatory assignment, overtime lists, or external staffing.
5. **Bid windows** — opening/closing schedule per round, whether late bids are ever accepted, and whether employees can withdraw bids before the deadline.
6. **Multiple-shift policy** — may one employee hold several shifts per round? Daily/weekly caps? Rest requirements between shifts (currently modeled only as overlap detection)?
7. **Eligibility rules** — qualification codes and who certifies them; restrictions after discipline/attendance actions; probationary employees.
8. **Time-off source of truth** — which system's approved absences feed the engine, and how cancellations propagate.
9. **Timezone convention** — one site timezone for wall-clock deadlines and displays (engine compares absolute instants; the *presentation* convention must be chosen).
10. **Reassignment and swaps** — post-allocation swaps, sick-day reassignment flow, and whether the engine re-runs or the change is a manual transaction with its own audit entry.
11. **Review and appeals** — whether allocations auto-publish or require administrator review before publication.

## 5. Security findings and requirements for the application layer

No application layer exists yet, so these are requirements, not findings:

- **Authentication:** a real identity provider (OIDC) — no home-grown password storage. Sessions via secure, httpOnly, SameSite cookies.
- **Authorization:** role-based (employee / administrator / read-only auditor) enforced **server-side on every endpoint**, with object-level checks (an employee may only see and act on their own bids and published schedules). The engine being pure makes it easy to test that unauthorized inputs never reach it.
- **Employee data privacy:** the dataset is personal data. Minimum necessary exposure in APIs (no seniority dates or qualifications to non-admins unless policy says so), no bulk export without the auditor role, and synthetic data only in every environment that isn't production. **No real CBSA (or any agency) employee data may be imported into test or demo systems.**
- **Audit trail:** allocation runs should be persisted with their full candidate explanations (the engine emits them) plus who triggered the run and when; bid submissions should be immutable with server-side timestamps.
- **Database:** least-privilege roles; row-level security or equivalent scoping by employee; migrations in version control.
- **API hardening:** rate limiting on bid submission and auth endpoints, CSRF protection for cookie-based sessions, strict input validation at the boundary (the engine's `ValidationError` is the inner layer, not the outer one).
- **Operational honesty:** the application must not be presented as officially approved for operational use until policy questions in §4 are confirmed and the system passes acceptance testing with synthetic data.

## 6. What was intentionally not built

- **No frontend, backend, database, or authentication layer.** Choosing the stack (the
  rest of Josh's portfolio is Next.js on Vercel + Neon Postgres, which would be the
  natural default) and the deployment shape is a project decision, and building an
  entire scheduling UI before §4 is confirmed would produce rework. The engine is
  deliberately framework-free so it drops into any of those choices unchanged.
- **No mobile surface.** Mobile optimization has nothing to optimize yet; the
  accessibility and mobile requirements (44px targets, no horizontal overflow, single-column
  bidding forms, calendar readability with explicit timezone labels, full keyboard
  support) are recorded here so they are binding on the future UI.
- **No notifications, reports, or exports** — these depend on the §4 decisions and the
  data model.

## 7. Production-readiness assessment

**Not production ready — by an honest distance.** There is no application. What exists
now is the hardest, most policy-sensitive core (the allocation engine), implemented
deterministically with a full audit trail and a 34-test suite, plus this audit. On the
path to production:

| Milestone | Status |
| --- | --- |
| Allocation engine, deterministic + explainable + tested | ✅ this PR |
| Policy decisions confirmed (§4) | ❌ needs management/HR |
| Data model + migrations (employees, shifts, bids, time-off, runs) | ❌ |
| AuthN/AuthZ (OIDC, roles, object-level checks) | ❌ |
| Bid submission + schedule UI (mobile-first) | ❌ |
| Administrator review flow + allocation run persistence | ❌ |
| Acceptance test on synthetic data + security review | ❌ |

## 8. Recommended next steps

1. Josh confirms the §4 policy answers (or confirms they must come from the client/union side) — this gates everything else.
2. Decide the stack (Next.js + Neon Postgres to match the portfolio is recommended) and whether the recovered original source, if it ever surfaces, replaces or merges with this engine.
3. Data model + migrations + OIDC auth with role-based access, all server-side enforced.
4. Bid submission and schedule views mobile-first; then administrator review and the allocation-run persistence with explanations.
5. Acceptance tests on synthetic employees only; security review; then a first preview deployment.
