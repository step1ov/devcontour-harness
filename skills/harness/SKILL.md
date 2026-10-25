---
name: harness
description: Drive engineering work orders through the headless execution harness — install the exact package, prepare an existing npm/pnpm Git repository with `harness init`, plan the work graph yourself and check it, run isolated attempts with gates and independent review, explain stops and read accepted results. Use when a task should be executed and accepted by `harness` rather than edited directly.
---

# Harness

`harness` executes an approved work graph: each order runs in its own Git
worktree, passes the policy gates and an independent review on the exact
candidate and integration SHAs, and is accepted by a compare-and-swap of the
target ref. The result is a JSON record with SHAs and evidence.

This skill explains how to use the tool. It enforces nothing: gates, review,
fencing, write scope and budgets are enforced by the harness itself, whether or
not this file is installed.

Every command takes explicit paths and prints one JSON envelope on stdout
(`ok` with `data`, or `error`). `--human` (only `init`, `explain` and `plan-request`) prints
text instead of a successful envelope; a refusal stays JSON. Exit codes:
0 success, 2 invalid input, 3 refusal or block, 4 infrastructure. The tool
keeps no "current project".

## Route for an existing repository

### 0. What to ask the user

Only the repository path, the goal and the constraints (what must not change,
limits). Everything else — profile, gates, roles, paths, state — comes from
`harness init`. Preconditions: Node.js ≥ 24.3, `git`, `npm` or `pnpm`, and a
signed-in `claude` and/or `codex` CLI.

### 1. Install the exact package outside the project

```sh
npm install --prefix <tooldir> --omit=dev --ignore-scripts <file.tgz>
H=<tooldir>/node_modules/.bin/harness
$H --version
shasum -a 256 <file.tgz>
```

Use the exact tarball (or exact registry version) you were given and record
its sha256. Do not install it into the project: the project `package.json`
and lockfile stay untouched.

### 2. Check the machine

`$H doctor` — runtime availability and versions, OS sandbox. No model call.

`$H capabilities` — the catalog of the shared operations (`init`, `explain`,
`plan-request`, `plan-check`, `capabilities`): description, `readOnly`, JSON
Schema of input and response, and the byte limits. Read only.

### 3. Prepare the repository

1. `$H init --repository <repo> --plan` writes nothing. Read `data.files`
   (`create` / `preserve` / `conflict`), `data.conflicts`,
   `data.toolchain.problems`, `data.facts` and `data.manifest.paths.state`.
   Exit 3 means the plan has conflicts or the toolchain is not ready.
2. Fix what you may fix, or hand it to the user (see the table).
3. `$H init --repository <repo>` is create-only: `.harness/.gitignore`,
   `.harness/README.md`, `.harness/project.json` (the decisions: profile,
   writer, state), and `.harness/policy.json` last. No other file of the
   repository changes and nothing is committed. A
   repeat with the same decisions writes nothing (`created: []`); after an
   interruption it resumes from the saved manifest decisions and writes only
   what is missing.

| Conflict or refusal                                 | Meaning                                                                                              | Action                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `symlink`                                           | the path or an ancestor (`conflictPath`) is a symlink                                                | never write through it; the user replaces the link                                                                          |
| `ancestor-not-directory`                            | an ancestor of the path is a file                                                                    | ask the user; never delete their files                                                                                      |
| `not-regular-file`                                  | the destination exists and is not a regular file                                                     | ask the user                                                                                                                |
| `outside-root`                                      | the destination resolves outside the repository                                                      | ask the user                                                                                                                |
| `content-differs` on `.harness/project.json`        | an explicit `--writer` or `--profile` differs from the saved manifest                                | keep the saved decision, or the user confirms the change explicitly                                                         |
| `content-differs` on `.harness/policy.json`         | the saved policy's writer differs from the manifest or explicit `--writer`                           | keep the saved decision, or the user confirms the change explicitly                                                         |
| `INVALID_INPUT` with a path                         | not a Git root, invalid manifest or policy (also a truncated write), `--state` inside the repository | read the issue path; a broken file is removed by a human, not overwritten                                                   |
| `NOT_READY` `no-commits`                            | the repository has no commits                                                                        | the user commits first                                                                                                      |
| `NOT_READY` `stack-ambiguous` / `stack-unsupported` | both lockfiles, or none                                                                              | pass `--profile`; when profile gates do not fit, write `.harness/profile.json` and pass `--profile ./.harness/profile.json` |
| `NOT_READY` toolchain problems                      | missing scripts, wrong tool versions                                                                 | fix the project or hand it to the user; never weaken the policy                                                             |
| `CONTROLLER_BUSY`                                   | the repository is already owned by another controller                                                | stop: a second controller and state are not created                                                                         |

### 4. Plan the graph

You are the planner: write the draft yourself. No other model is called for
planning, and the draft approves nothing.

1. Write the user's goal and constraints to `.harness/work/<graph-id>.brief.md`.
   Ask the user a short question for every real ambiguity instead of
   guessing; the answer goes into the brief. A changed brief makes an earlier
   draft stale.
2. Build the planning request (read only: no model call, no state, no writes):

   ```sh
   $H plan-request --brief .harness/work/<graph-id>.brief.md \
     --policy .harness/policy.json [--requirements docs/spec.md]
   ```

   Read `data.prompt` (roles, gates, repositories, context, resources and
   contracts of the project; requirement snapshots at `HEAD` when
   `--requirements` names a committed file with `## REQ-*` sections) and keep
   `data.basis`. `--human` prints only the prompt.

3. Write `.harness/work/<graph-id>.draft.json` matching
   `schemas/plan-draft.schema.json` of the installed package; the example is
   `<tooldir>/node_modules/devcontour-harness/templates/plan-draft.json`, whose
   ids (`app`, `developer`, `unit`) are placeholders to replace. Take
   `repositoryId`, `role`, `gates`, `contextPacks`, `resources` and
   `contracts` only from the request; copy requirement `id`, `source`, `text`
   and `digest` exactly, never invent ids or digests. Task keys become order
   ids; `description` becomes the goal; omitted `writePaths` mean the whole
   repository. A new feature test belongs to the task whose behaviour it
   proves, bound by a requirement (test gate, scenario, `testId`): it may fail
   before the implementation and must pass on the accepted commit.
4. Check the draft (read only, no gates run):

   ```sh
   $H plan-check --draft .harness/work/<graph-id>.draft.json \
     --policy .harness/policy.json \
     --brief .harness/work/<graph-id>.brief.md --basis <data.basis>
   ```

   The graph id is the file name without `.draft.json`. Exit 0 returns
   `data.graph` and `data.graphDigest`; otherwise read `data.issues` and
   `data.checkPlan`:

   | Code                                                                                    | Action                                                                                                                                                                                           |
   | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `GATE_UNKNOWN`, or any issue with a `checkPlan` entry (`declare-gate`, `add-test-gate`) | prepare the check: declare the gate in the policy or a local profile, or run a bootstrap graph proven by existing gates; then repeat `plan-request`. Never drop the gate or swap in a weaker one |
   | `APPROVAL_STALE`                                                                        | the brief, the project facts or a requirement changed: run `plan-request` again and redo the draft                                                                                               |
   | `INVALID_INPUT`                                                                         | fix the draft at the issue path (unknown role, gate scope, contract, requirement, write paths, order limits)                                                                                     |
   | `NOT_READY`                                                                             | the requirement source is not a committed Git file: the user commits it                                                                                                                          |

5. Save `data.graph` unchanged to `.harness/work/<graph-id>.json`, then
   validate, review and run it (steps 5–7). The review record of the plan
   carries the same digest as `data.graphDigest`.

A hand-written graph is still possible: start from
`<tooldir>/node_modules/devcontour-harness/templates/graph.json` and take
`repositoryId`, `role`, `gates` and the write scope only from `data.facts` of
`init`.

### 5. Validate

`$H validate --graph .harness/work/<graph-id>.json --policy .harness/policy.json`
checks schemas and cross references; no model calls, no writes. Fix every
reported issue.

### 6. Review and approve the plan

With `approvalMode: agent` (the generated default) `run` performs the plan
review under the reviewer rule and approves it.
`$H review-plan --state … --graph … --policy … --author <your runtime>` shows
the findings in advance. With `approvalMode: operator` a human approves with
`$H approve`.

### 7. Run

```sh
$H run --graph .harness/work/<graph-id>.json --policy .harness/policy.json \
  --state <manifest.paths.state> --author <claude|codex>
```

The state directory lives outside the repository; `run` creates it.

### 8. When it stops

`$H explain --state <state> --policy .harness/policy.json [--work <id>]` is
read only (no retries, model calls or state changes). For every stopped order
it returns `code`, `cause`, `phase`, `actor`, `action`, `retryPlanned`,
`message` and `evidence`.

| `actor`      | `action`                                                                                           | Who acts                                                     |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `controller` | `wait`, `retry`                                                                                    | you: wait, or run `$H run` again                             |
| `lead`       | `review-plan`, `diagnose-failure`, `replan-dependents`, `wait`                                     | you: fix the graph, policy or code by the evidence, then run |
| `user`       | `fix-access`, `fix-environment`, `raise-budget`, `reset-attempts`, `user-decision`, `resume-queue` | hand it to the user with the message and evidence            |
| `null`       | `none`                                                                                             | nothing to do                                                |

Only `user` actions go to the human: access, environment, budgets, attempt
resets, goal decisions and resuming a paused queue are their decisions.

### 9. Report the result

`$H result --state <state> --work <id>`: `data.result.outcome` must be
`accepted` and `data.result.shas.result` must equal `git rev-parse <targetRef>`
in the repository. Report what the harness recorded, not your own summary.

### 10. New session

Nothing is asked again:

1. `$H init --repository <repo> --plan` returns the saved manifest
   (decisions, `paths.state`) with `status: complete` and writes nothing.
2. `$H status --state <paths.state>` — `NOT_FOUND` means "never run".
3. `$H explain --state <paths.state> --policy <repo>/.harness/policy.json`.
4. Read `.harness/work/*.json` and the notes.

### 11. Notes

No external note or chat service is called, and missing notes are normal. A
new note is a Markdown file in `.harness/work/context/notes/`, written with
your own tools. It enters a context snapshot only when the order lists
`"context": ["notes"]`; the snapshot pins its digest and refuses symlinks. Do
not copy acceptance logs or attempt state into notes.

## Other inputs

- **Policy** (`ExecutionPolicy` JSON): repositories with gates and target ref,
  roles (writer runtime, write paths), reviewer rule per review kind
  (`different-vendor` by default; `same-vendor-allowed` only when stated),
  isolation, limits. `init` generates it; `templates/policy.json` is a
  starting point for a hand-written policy.
- **Stack profile**: `$H profile --profile <id>` shows a built-in profile
  (`profiles/*.json`); `--profile ./file.json --repository <dir>` resolves a
  profile kept in the repository. Profile resolution only reads manifests and
  never runs project commands.
- **Queue control**: `$H status`, `pause`, `resume`, `cancel`, `retry`
  (bounded by the policy), `deliver` (repeats delivery without models or Git
  integration).

## Don'ts

- Do not call a separate model to plan, and do not mark a plan or draft as
  approved: approval comes only from `review-plan` / `approve` / `run`.
- Do not weaken or remove gates or requirements so that a new feature test
  is green before its implementation; a project already failing on its base
  is a separate first task.

- Do not edit the target ref or the attempt worktrees yourself; acceptance
  happens only through `harness run`.
- A green exit code is not acceptance. Read `result.outcome` and the evidence.
- A refusal (exit 3) names its code (`GATE_FAILED`, `REVIEW_REJECTED`,
  `SCOPE_VIOLATION`, `BUDGET_EXHAUSTED`, `REVIEWER_SAME_VENDOR`,
  `CONTROLLER_BUSY`, `PATH_CONFLICT`, …). Fix the cause in the graph, policy or
  code, then run again; do not look for a way around the check.
- Do not weaken gates, isolation, budgets or the reviewer rule to get a pass.
  A reviewer of the same vendor as the writer is refused unless the policy says
  `same-vendor-allowed` for that review kind.
- `RESPONSE_TOO_LARGE` (exit 2) means the response of a shared operation is
  over the transport limit; nothing was truncated. Narrow the input
  (`explain --work <id>`, a shorter brief or fewer requirement files) instead
  of retrying. Clipped strings in a response are not the full data: follow the
  evidence ids (`events`, `result`) for details.
- Fixture runtimes (`policy.mode: fixture`, `HARNESS_*_BIN` overrides) test the
  mechanics of the harness; they say nothing about the quality of live models.
