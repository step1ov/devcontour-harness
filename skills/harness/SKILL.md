---
name: harness
description: Drive engineering work orders through the headless execution harness — validate a work graph and policy, run isolated attempts with gates and independent review, read accepted results. Use when a task should be executed and accepted by `harness` rather than edited directly.
---

# Harness

`harness` executes an approved work graph: each order runs in its own Git
worktree, passes the policy gates and an independent review on the exact
candidate and integration SHAs, and is accepted by a compare-and-swap of the
target ref. The result is a JSON record with SHAs and evidence.

This skill explains how to use the tool. It enforces nothing: gates, review,
fencing, write scope and budgets are enforced by the harness itself, whether or
not this file is installed.

## Inputs

- **Policy** (`ExecutionPolicy` JSON): repositories with gates and target ref,
  roles (writer runtime, write paths), reviewer rule per review kind
  (`different-vendor` by default; `same-vendor-allowed` only when stated),
  isolation, limits. `templates/policy.json` is a starting point.
- **Work graph** (`WorkGraph` JSON): orders with goal, acceptance criteria,
  write scope, gates and dependencies. `templates/graph.json` is a starting
  point.
- **Stack profile** (optional): `harness profile --profile <id>` shows a
  built-in profile (`profiles/*.json`) with its gates, preparation and roles;
  `--profile ./file.json --repository <dir>` resolves a profile kept in the
  repository. Profile resolution only reads manifests and never runs project
  commands. Copy the gates you need into the policy, or build the repository
  entry with `repositoryFromProfile` from the library.

Every command takes explicit paths. The tool keeps no "current project"; pass
`--state <dir>` for the execution state of this graph.

## Workflow

1. `harness validate --graph graph.json --policy policy.json` — schemas and
   cross checks, no model calls, no writes. Fix every reported issue.
2. `harness run --graph graph.json --policy policy.json --state <dir>` —
   registers the graph, runs the plan review under the policy reviewer rule,
   approves it (`approvalMode: agent`) and works the queue until idle. With
   `approvalMode: operator` use `harness approve` after the review.
3. `harness status --state <dir>` — per order status and blockers (pause,
   budget, reviewer rule, contract review, dependencies).
4. `harness result --state <dir> --work <id>` — the accepted or rejected result
   with SHAs, evidence and findings; `harness deliver` repeats delivery without
   models or Git integration.
5. `harness pause`, `resume`, `cancel`, `retry` control the queue. A human pause
   stays until `resume`; `retry` is bounded by the policy.

## Rules for the agent driving harness

- Do not edit the target ref or the attempt worktrees yourself; acceptance
  happens only through `harness run`.
- A green exit code is not acceptance. Read `result.outcome` and the evidence.
- A refusal (exit 3) names its code (`GATE_FAILED`, `REVIEW_REJECTED`,
  `SCOPE_VIOLATION`, `BUDGET_EXHAUSTED`, `REVIEWER_SAME_VENDOR`,
  `CONTROLLER_BUSY`, …). Fix the cause in the graph, policy or code, then run
  again; do not look for a way around the check.
- Reviewer of the same vendor as the writer is refused unless the policy says
  `same-vendor-allowed` for that review kind.
- Fixture runtimes (`policy.mode: fixture`, `HARNESS_*_BIN` overrides) test the
  mechanics of the harness; they say nothing about the quality of live models.
