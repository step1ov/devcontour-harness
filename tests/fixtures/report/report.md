# Harness report: demo

_Window: all history. As of 2026-11-03T16:00:00.000Z. Harness 0.0.0-test. Engines: 0.1.0-alpha.29, 0.1.0-alpha.30 (2 attempts unknown)._

_Coverage: 13 attempts on 7 tasks; failure class on 6 of 7 failed; stage timings on 9; complete call records on 11; approval wait on 8. 10 calls, 3 plan or contract review rounds, 8 events (events from 2026-10-05T07:50:00.000Z)._

## Summary

- **5**: 5 tasks accepted. At least 2 of them on the first try; for 1 more task it is unknown (failures without a class).
  _Accepted: merged after all required checks and an independent review. First try: the accepting attempt was the only counted attempt (environment failures except stalls, blocked-before-work attempts, expired leases and shutdowns are not counted). Window: all history._
- **≥ 2 of 5**: At least 2 of 5 accepted tasks were sent back by checks, review or the scope rule before merge; 1 task had only failures without a class before merge. Nothing merged without passing every required check and review.
  _An attempt rejected as gate, review or scope-violation before the accepting attempt. Failures without a class are not counted, so this is a lower bound._
- **8.1 d**: From approval to merge: median 8.1 d (n=5).
  _Wall clock from the first attempt's approval to the accepting attempt, including queue waits and pauses. 1 task used the task approval time because the first attempt has no wait record._
- **≥ $2.37**: Known spend ≥ $2.37 per accepted task (1 call without a known price, 2 attempts without call records: configure prices).
  _Known spend $11.85 over 10 calls in the window (plans, contracts, implementation and review) divided by 5 accepted tasks._
- **≥ 1 of 6**: At least 1 of 6 classified failed attempts were caused by the environment; 1 more failure in setup checks may be environment too.
  _Environment: sandbox, network, provider access and expired leases. 0 time-limit failures (ambiguous) and 1 unknown or unclassified failure are not distributed._

## Defects caught before merge

- Rejected attempts: 4 (checks 2, review 1, scope 1; candidate 2, integration 1, phase unknown 1).
- Accepted tasks sent back at least once: ≥ 2 of 5; 1 more with failures without a class.
- Rejected reviews: 1 (candidate 1, integration 0) with 2 blocking findings; 0 without findings.
- Rejected by review although every required check passed on the same commit: 1 of 7 green candidates (diagnostic: what the checks did not catch).
- Caught only against the current target branch (integration): 1.
- Plan and contract review: 3 rounds, 1 rejected (plans 1 of 2, contracts 0 of 1); blocking findings closed before code 1, open 0, withdrawn 0.
- Findings withdrawn by the reviewer (precision proxy): 1 of 4; 1 finding without a status.

### Rejections by check

| Check | Phase | Failed | Note |
| --- | --- | ---: | --- |
| install | integration | 1 | setup check: may be a network error |
| unit | candidate | 1 |  |

### Rejection evidence (newest first)

| When | Task | Attempt | Kind | Check | Phase | Commit | Blocking | Log |
| --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| 2026-11-03T10:40:00.000Z | broken | 2 | test | install | integration | 496ad081c104 |  | …/install.log |
| 2026-10-29T10:30:00.000Z | broken | 1 | scope |  |  | efaabe836d64 |  |  |
| 2026-10-14T10:30:00.000Z | review | 1 | review | independent-review | candidate | b0ed1b9fd317 | 2 | repos/app/artifacts/run-review-1/candidate/independent-review.log |
| 2026-10-12T10:22:00.000Z | gate | 2 | test | unit | candidate | 82406707b186 |  | repos/app/artifacts/run-gate-2/candidate/unit.log |

## Autonomy

- Accepted tasks that needed no human action: not measurable yet (retries, resets and base moves have no recorded actor). Accepted tasks with an operator recovery decision: 0 of 5.
- Human actions with a recorded actor: operator recovery decisions 0. Without a recorded actor (not counted as human): holds 1, cancelled attempts 1. Not recorded yet: retries, resets, base moves.
- Plan approvals: operator 1, agent 0 (from events).
- Escalations to a person (recovery awaiting the user or stopped): 0.

| Queue stop | Count | Paused | Still open | Failure classes |
| --- | ---: | ---: | ---: | --- |
| operator | 1 | 1.0 h | 1 |  |
| runtime | 1 | 30 min | 0 | environment |

## Speed

- First try: ≥ 2 of 5 accepted tasks (any attempt count: 1 of 5). Finished in the window: 5 accepted, 1 failed, 1 cancelled.
- Approval to merge: median 8.1 d, p75 8.2 d, max 13.2 d (n=5); 1 from the task approval time. Includes queue waits and pauses.
- Waiting for dependencies: median 1.8 h, p75 24.0 h, max 13.0 d (n=8). Waiting in the queue: median 1.0 h, p75 1.0 h, max 1.0 h (n=8).
- Attempts per accepted task: 1 ×1, 2 ×3, 3 ×1, 4–6 ×0, 7+ ×0; median 2, mean 2. Attempts on tasks not accepted in the window: 3.
- Machine time per accepted task (sum of attempt durations, not human time): median 1.7 h, p75 3.0 h, max 3.6 h (n=5).

| Stage | Spans | Total | Median | On accepted attempts | On rejected attempts | Unfinished |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| implementation | 9 | 2.7 h | 18 min | 1.2 h | 1.5 h | 0 |
| candidate-review | 9 | 1.2 h | 8 min | 32 min | 40 min | 0 |
| candidate-test | 18 | 36 min | 2 min | 16 min | 20 min | 0 |
| integration-test | 0 | 0 s |  | 0 s | 0 s | 1 |

## Cost

- Known spend $11.85 over 9 of 10 calls (reported by the provider $10.55, estimated from tariffs $1.30).
- Calls without a known price: 1 (no tariff 1, incomplete telemetry 0, active 0, abandoned 0); by runtime: codex 1. Attempts without call records: 2; with records not marked complete: 0.
- Spend per accepted task: ≥ $2.37.
- Spend per fully priced attempt: median $0.80, p75 $1.75, max $3.00 (n=9; 4 not measured).
- Spend on attempts that were not accepted: ≥ $6.50 of ≥ $11.35 attributed to 13 attempts (defect $6.50, environment $0.00, operator $0.00, unclassified $0.00).

| Stage | Calls | Known spend | Without price |
| --- | ---: | ---: | ---: |
| implementation | 8 | $11.35 | 0 |
| plan-review | 1 | $0.50 | 0 |
| candidate-review | 1 | $0.00 | 1 |

## Environment

Failed attempts: 7, of them 6 classified; attempts interrupted by shutdown are not failures: 1. Caused by the environment: ≥ 1 of 6 classified; 1 more failed only in setup checks and may be environment too.

| Failure class | Attempts |
| --- | ---: |
| defect (check, review, scope) | 4 |
| incomplete (empty, unfinished, needs lead, context exhausted) | 0 |
| integration (stale base, merge) | 0 |
| environment (sandbox, network, provider, lease) | 1 |
| time limit | 0 |
| reviewer protocol | 0 |
| cancelled by a person | 1 |
| budget | 0 |
| unknown | 0 |
| unclassified (legacy) | 1 |

- Environment failures cost 2 min of machine time and $0.00 known spend; blocked before work (not counted as an attempt): 1; queue stops caused by the environment: 1.
- Integration check rechecks: 0 flaky (false rejection avoided), 0 confirmed.
- Environment sub-causes: not recorded yet.

## Weekly trend

| Week | Attempts | Accepted | First try | Defect rejections | Environment failures | Known spend | Unpriced calls | Median approval to merge | Engines |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-W45 | 2 | 0 | 0/0 | 1 | 0 | $0.40 | 0 |  | changed: 0.1.0-alpha.30 |
| 2026-W44 | 4 | 2 | 1/2 | 1 | 1 | $2.50 | 0 |  | changed: 0.1.0-alpha.29, 0.1.0-alpha.30 |
| 2026-W43 | no activity |  |  |  |  |  |  |  |  |
| 2026-W42 | 3 | 1 | 0/1 | 2 | 0 | $7.25 | 0 |  | 0.1.0-alpha.29 |
| 2026-W41 | 2 | 1 | 1/1 | 0 | 0 | $1.70 | 1 |  | changed: 0.1.0-alpha.29 |
| 2026-W40 | 1 | 1 | 0/1 | 0 | 0 | $0.00 | 0 |  | unknown |
| 2026-W39 | 1 | 0 | 0/0 | 0 | 0 | $0.00 | 0 |  | unknown |

## Tasks

| Task | Outcome | Finished | Attempts | Counted | Approval to merge | Known spend | Failures |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| cancel: Abandoned idea | cancelled | 2026-11-03T14:20:00.000Z | 1 | 1 |  | $0.00 | operator 1 |
| broken: Refactor storage | failed | 2026-11-03T10:45:00.000Z | 2 | 2 |  | ≥ $1.00 | defect 2 |
| env: Wire the CLI | accepted | 2026-10-28T12:00:00.000Z | 2 | 1 | 4.0 h | $1.10 | environment 1 |
| review: Harden \<input\> handling | accepted | 2026-10-27T13:00:00.000Z | 2 | 2 | 13.2 d | $3.80 | defect 1 |
| gate: Fix \| the \*parser\* | accepted | 2026-10-13T11:00:00.000Z | 3 | 2 | 8.1 d | $4.25 | defect 1 |
| first: Add the greeting | accepted | 2026-10-05T10:50:00.000Z | 1 | 1 | 2.8 h | ≥ $1.20 (+1 unpriced) |  |
| legacy: Old task from before classification | accepted | 2026-09-29T12:00:00.000Z | 2 | 2 | 8.2 d | unknown | unclassified 1 |

## Limits and unknowns

- There is no before-harness baseline: the report does not compare with work done without the harness.
- Human actions are counted only where a person is recorded as the actor (operator recovery decisions); retries, resets, cancellations and base moves have no recorded actor yet, so tasks that needed no human action are not measurable yet.
- Network or registry errors inside checks are classified as check failures, so rejections by checks can be overstated; setup checks are marked.
- Environment failures have no recorded sub-cause (sandbox, network, provider, lease).
- A rejected candidate is not proof of a real defect: reviewer precision is not measured; withdrawn findings are only a proxy.
- Defects found after merge and human time outside the tool are not visible to the harness.
- 1 failed attempt without a failure class (recorded before classification) is shown as unclassified, not as defects.
- 4 of 13 attempts have no stage timings; stage time covers the rest.
- 2 of 13 attempts have no call records, so their spend is unknown.
- Holds and cancelled attempts record no actor (host operations hold tasks too), so they are not counted as human actions.
- 1 of 10 calls have no known price (no tariff 1, incomplete telemetry 0, active 0, abandoned 0); spend is a lower bound.
- 1 accepted task started from the task approval time, which a re-approval overwrites.
- Pauses and approvals are counted from events, which start at 2026-10-05T07:50:00.000Z.
- Several engine versions in the window (0.1.0-alpha.29, 0.1.0-alpha.30, unknown): weeks where the version changed are marked.

## Appendix

- Accepted: the task is done; its accepting attempt is the last succeeded attempt. Window membership: accepted tasks by acceptance time, attempts and calls by start time, review rounds and events by their time; the window start is included, the end is not.
- Attempts are counted from attempt records, not from the task attempt counter (a reset sets it back to zero).
- Percentages are shown only when the denominator is 20 or more; medians only for 5 or more values; with fewer than 3 accepted tasks the summary is replaced by raw counts.
- Bounds: "≥" is a lower bound (some inputs are unknown), "≤" an upper bound, "unknown" means not measured; unknown is never shown as zero.
- Tokens in the window: input 8900, output 1700, cache read 40000, cache write 800; calls with incomplete token counts 1.
