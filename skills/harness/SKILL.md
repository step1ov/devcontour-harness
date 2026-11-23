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
(`ok` with `data`, or `error`). `--human` (only `init`, `status`, `explain`, `plan-request`, `gates` and `update`) prints
text instead of a successful envelope; a refusal stays JSON. Exit codes:
0 success, 2 invalid input, 3 refusal or block, 4 infrastructure. The tool
keeps no "current project".

## Route for an existing repository

### 0. What to ask the user

Only the repository path, the goal and the constraints (what must not change,
limits), and one choice for a new project: may you, the lead, decide the
executor's technical questions yourself (the result for the user stays the
same; you record why), so that only questions that change the result for the
user reach them? Yes — pass `--lead-technical-answers` to `init`; the default
is no. Everything else — profile, gates, roles, paths, state — comes from
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
its sha256. Do not install it into the project's dependencies: the project
`package.json` and lockfile stay untouched. `<tooldir>` is outside the
repository or `<repo>/.harness-tools`; the `harness-setup` skill of the
package covers both, the version pin and upgrades.

### 2. Check the machine

`$H doctor` — runtime availability and versions, OS sandbox. No model call.
With `--policy`, `data.warnings` carries machine advice: `LOW_RESOURCES`
(weak machine, `concurrency` above 1) and `DEPENDENCY_STORE_RECOMMENDED`
(pnpm without `dependencyStore`). For a new project answer them with
`init --lean`; for a prepared one see "Weak machine" (step 8).
`DEPENDENCY_STORE_UNSUPPORTED` (the pinned pnpm is outside the verified
versions: the store is not applied and every checkout installs everything from
the network) and `DEPENDENCY_CACHE_PATH` (a gate, `prepare` step or policy
environment sets its own pnpm store/cache) are loud on purpose — see
"Package cache" below.

`$H capabilities` — the catalog of the shared operations (`init`, `explain`,
`plan-request`, `plan-check`, `capabilities`): description, `readOnly`, JSON
Schema of input and response, and the byte limits. Read only.

### Lead inside a Codex sandbox

A lead started as `codex exec -s workspace-write` runs `harness` inside the
Codex seatbelt. There `.git` is read-only (`git switch -c` fails with "cannot
lock ref ... Operation not permitted", `smoke`/`gates`/`run` cannot create
`.git/worktrees`), `ps` is denied, and harness's own OS isolation of writers,
gates and reviewers does not start nested on macOS
(`sandbox_apply: Operation not permitted`).

Run `$H doctor` first. When `data.leadSandbox.inside` is true, `problems`
carries a `lead-sandbox:` line with the reason and the exact flags; `init`
adds the warning `lead-sandbox`. Follow it:

- the lead needs write access to the repository `.git` (the git common dir),
  to the harness state directory, and network for the writer CLIs;
- on a trusted machine run the lead unsandboxed:
  `codex exec --dangerously-bypass-approvals-and-sandbox`;
- the narrow variant
  `codex exec -s workspace-write --add-dir <repo>/.git --add-dir <state> -c sandbox_workspace_write.network_access=true`
  fixes git and the state directory, but commands that start models or gates
  (`run`, `smoke`, `gates`, `review-plan`) still need an unsandboxed lead or an
  operator outside the sandbox.

Do not work around the denials (do not switch the policy isolation off, do not edit `.git` by hand):
report the `doctor` line to the user and restart the lead with the flags.

### 3. Prepare the repository

1. `$H init --repository <repo> --plan` writes nothing. The lead is you:
   pass `--lead claude` or `--lead codex` unless `data.lead` already names
   you (`CLAUDECODE` / `CODEX_THREAD_ID`, the saved manifest, or a
   committed policy in a fresh checkout). The writer defaults to the lead;
   `--review auto` (default) picks the same runtime with an explicit
   `same-vendor-allowed` and a `review-same-vendor` warning only when your
   own CLI works and the other vendor's is missing or signed out — tell the
   user; otherwise a reviewer of the other vendor. Read `data.warnings`,
   `data.files`
   (`create` / `preserve` / `conflict`), `data.conflicts`,
   `data.toolchain.problems`, `data.facts`, `data.manifest.paths.state` and
   `data.questions.line` — who answers executor questions, in plain words;
   tell the user this rule.
   Exit 3 means the plan has conflicts or the toolchain is not ready.
2. Fix what you may fix, or hand it to the user (see the table).
3. `$H init --repository <repo>` is create-only: `.harness/.gitignore`,
   `.harness/README.md`, `.harness/project.json` (the decisions: profile,
   lead, writer, review, state), and `.harness/policy.json` last. No other file of the
   repository changes and nothing is committed. A
   repeat with the same decisions writes nothing (`created: []`); after an
   interruption it resumes from the saved manifest decisions and writes only
   what is missing.

| Conflict or refusal                                                         | Meaning                                                                                                                                                                                            | Action                                                                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `symlink`                                                                   | the path or an ancestor (`conflictPath`) is a symlink                                                                                                                                              | never write through it; the user replaces the link                                                                          |
| `ancestor-not-directory`                                                    | an ancestor of the path is a file                                                                                                                                                                  | ask the user; never delete their files                                                                                      |
| `not-regular-file`                                                          | the destination exists and is not a regular file                                                                                                                                                   | ask the user                                                                                                                |
| `outside-root`                                                              | the destination resolves outside the repository                                                                                                                                                    | ask the user                                                                                                                |
| `content-differs` on `.harness/project.json`                                | an explicit `--lead`, `--writer`, `--review`, `--model`, `--profile` or `--lean` differs from the saved manifest; after an upgrade or a move, also a changed built-in profile, root or API version | keep the saved decision, or the user confirms the change explicitly; for `--lean` use `$H lean --repository <repo> --plan`  |
| `content-differs` on `.harness/policy.json`                                 | the saved policy assigns no allowed reviewer for the decisions (plan and contract of the lead, code of the writer); the refusal names the reason                                                   | pass the `--lead` / `--writer` the policy was made for, or the user confirms the change explicitly                          |
| `content-differs` on `.harness/policy.json` from `--lead-technical-answers` | the saved policy does not let the lead decide technical questions                                                                                                                                  | the user confirms the change; then add `inputPolicy.leadAnswers.technical: true` to `.harness/policy.json` (between runs)   |
| `NOT_READY` `lead-unknown`                                                  | no `--lead`, no saved manifest and no session marker                                                                                                                                               | pass `--lead claude` or `--lead codex` (who leads this session)                                                             |
| `INVALID_INPUT` with a path                                                 | not a Git root, invalid manifest or policy (also a truncated write), `--state` inside the repository                                                                                               | read the issue path; a broken file is removed by a human, not overwritten                                                   |
| `NOT_READY` `no-commits`                                                    | the repository has no commits                                                                                                                                                                      | the user commits first                                                                                                      |
| `NOT_READY` `stack-ambiguous` / `stack-unsupported`                         | both lockfiles, or none                                                                                                                                                                            | pass `--profile`; when profile gates do not fit, write `.harness/profile.json` and pass `--profile ./.harness/profile.json` |
| `NOT_READY` toolchain problems                                              | missing scripts, wrong tool versions                                                                                                                                                               | fix the project or hand it to the user; never weaken the policy                                                             |
| `CONTROLLER_BUSY` from `lean`                                               | a run of this project is in progress (live controller, attempt or joint verification)                                                                                                              | wait for the run to finish, then repeat `lean`; never edit the policy under a running controller                            |
| `CONTROLLER_BUSY`                                                           | the repository is already owned by another controller                                                                                                                                              | stop: a second controller and state are not created                                                                         |

**Package cache.** Right after `init`, run `$H smoke` (step 7) and read the
prepare time and the dependency store advice. Prepare longer than a minute →
enable `dependencyStore` with `$H lean --repository <repo> --plan`, then
without `--plan`. A package manager version the store does not support →
report it to the operator as a harness finding. Never build your own shared
cache in gate or `prepare` arguments (`--store-dir`, `store-dir`, `cache-dir`,
`pnpm_config_store_dir`): an absolute path and shared mutable state bypass
the store's trust boundary and do not move to another machine; a path inside
the worktree starts empty in every attempt. Do not start a paid `run` until
prepare fits a reasonable time.

### 4. Plan the graph

You are the planner: write the draft yourself. No other model is called for
planning, and the draft approves nothing.

**Declare the release outline first.** Before the first graph, record the
whole release, not only the next graph: stages (infra per service, product,
deploy, …) × components with a rough size and who does them (writers,
environment, owner) — `$H lead outline` (see `$H lead outline --help`).
Without it status and the panel say «плана выпуска нет — прогноз по одному
графу» and the forecast reads one graph as the whole release. Update the
outline with a reason when the plan grows.

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

**Infra works.** Harness-owned infrastructure code — environment bridges,
gate wrappers, validators, acceptance tests under `.harness/` — is planned
as tasks with `"kind": "infra"`, not written by you during setup or between
runs (`<pkg>/docs/infra-works.md`). The setup report lists such code and the
inherited setup debts; each becomes an infra task:

- the repository needs an infra scope in the policy:
  `repositories[].infra.paths` (for example `.harness/acceptance/`,
  `.harness/infra/`), inside `protectedPaths`, never covering
  `.harness/policy.json`, `profile.json`, `connector.json`, `project.json`,
  `.harness/work/` or a file that `lifecycle`/`prepare` steps run; its
  teardown is `node …/compose-bridge.mjs` or `docker`/`podman compose` with
  `-p`/`--project-name` (the policy refuses anything else). Adding it
  changes the isolation digest: the plan needs `review-plan` again;
- an infra task's `writePaths` lie inside that scope (the role's write
  paths do not narrow it); a file that host steps name is never edited —
  write the new version next to it and switch the policy after acceptance;
- any file of the scope that already exists in the base — a gate script or
  test, a helper it imports, data — any new `package.json`, `node_modules/`,
  dot-file, `*.config.*` or Python config, and any new file whose name stem
  matches a base file or directory next to it changes only when the task lists
  it in `gateChanges` and its description says what the new check proves
  and why it is not weaker; plan review approves that change. New tests and
  helpers can be added freely; symlinks cannot. Host steps after the writer
  (lifecycle teardown) run in a separate clean checkout of the trusted base,
  never on the candidate's code; keep bridge state in the environment
  directory, not in files setup writes into the tree;
- every product task of the same repository (or naming it in
  `relatedRepositories`) depends on the infra tasks (`plan-check` refuses a
  graph where it does not): product works run the gates and bridges of the
  accepted infra revision. An open infra work of an earlier graph holds the
  product works of its repositories.

Infra works run through the normal loop (attempts, review-code, forecast);
treat their failures like any other work's.

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

**After a policy change.** An approval belongs to the policy it was made
under: after you edit `.harness/policy.json` (or `lean` changes it) the graph
is `APPROVAL_STALE`, and `review-plan` holds a new round instead of returning
the stored one. When the change does not touch the execution boundary (list
below) — for example a gate timeout — and the last round approved, re-approve
through the CLI with an audit record:
`$H reapprove --state … --policy .harness/policy.json --subject <graph-id> --digest <graph digest> --by "<who>" --reason "<what changed and why the last review still covers it>"`.
A change to isolation, network, tool profiles (or which profile a role or
reviewer uses), the policy `environment`, `protectedPaths`, host steps
(`lifecycle`, `prepare`, `dependencyBuild`, `preflight`), `mode` or
`approvalMode` always
needs a fresh `review-plan` — `reapprove` and `approve` refuse it
(`APPROVAL_REQUIRED`). In operator mode `approve` of an already approved graph
after a policy edit also points to `reapprove`.
Never call library internals (`Engine.approve`, store writes) to approve.

**Review rounds that go in circles.** Each plan or contract review round is a
paid call; `status` / `explain` `data.reviews[].line` shows the verdict, rounds
used of the cap and the review spend (in Russian: «одобрено, открытых заметок
2; раундов 3/6; ревью $0.75»). Approval may leave open notes: say so to the
user instead of reporting a clean approval. A finding the reviewer raises
again in other words keeps its ID (`sameAs`, or the same path and rule), so
`rounds` counts how long it has stayed open.

- If a finding is a known limitation you accept, record it in the next round:
  `$H review-plan … --accept-limitation <id> --reason "<why>"`. The reviewer
  sees the reason and does not re-raise it without new evidence. This is not
  an approval; never use it to silence a defect you can fix.
- A blocking finding open for 3 rounds stops the next round before the call
  (`INPUT_REQUIRED`, `data.reviews[].escalation`): give the user the question
  and its options, then record their answer with `--actor operator`
  (`--accept-limitation <id> --reason …`, or `--continue-review <id> --reason …`
  for three more rounds). Do not answer it yourself.

### 7. Run

```sh
$H run --graph .harness/work/<graph-id>.json --policy .harness/policy.json \
  --state <manifest.paths.state> --author <claude|codex>
```

The state directory lives outside the repository; `run` creates it.

Before a long cycle, first run the cheap decisive gates
(«перед долгим циклом сначала прогоните дешёвые решающие gates»):

```sh
$H gates --state <manifest.paths.state> --policy .harness/policy.json \
  --sha HEAD --gate <cheap,decisive,ids> --fail-fast
```

It runs the named gates (with their prerequisites) on that commit exactly as
the integration phase does, outside any attempt: no attempt, no order state,
no model call. `data.gates[]` gives `passed`, `failed`, `not-run` (a
prerequisite failed) or `skipped` (after the first failure with
`--fail-fast`); exit 0 when all passed, 3 otherwise; `--human` prints a table.
A green `gates` is not acceptance: only `run` accepts work.

**Code written outside the harness.** When you (or the user) already wrote
the code on a branch — a hotfix, a change made before the harness was set up,
commits added after acceptance — get an independent technical review of
exactly that diff instead of reviewing it yourself:

```sh
$H gates --state <manifest.paths.state> --policy .harness/policy.json --sha <head>   # optional, first
$H review-code --state <manifest.paths.state> --policy .harness/policy.json \
  --base <main> --head <branch> [--role <role>] [--author <who wrote it>]
```

The reviewer is chosen by the role's code review rule against the author's
vendor (`--author` defaults to the role's writer; name yourself when you wrote
the code): another vendor, or the same one only with `same-vendor-allowed`
(`REVIEWER_SAME_VENDOR` otherwise, before any model call; tell the user when
`sameVendor` is true). It reads the diff `merge-base(base, head)..head` in a
read-only checkout of `head`; a `gates --sha` result for that `head` is
attached as `gates`. Exit 0 — approved, 3 — blocking findings; fix them on the
branch and repeat with the same `--base`/`--head`: the reviewer must state
each previous finding. The record says `acceptance: false`: an approved
`review-code` is a review, not acceptance — say so to the user, and use
`run` when the work must be accepted.

Run the heavy commands — `smoke`, `smoke --writer-probe`, `gates`, `run` —
**one at a time**, never in parallel or as concurrent background jobs: they
share the dependency store, ports and CPU, and a parallel run fails for
reasons that are not in the project.

When the project has `lifecycle`, `prepare` or a dependency store, check the
environment alone first — never debug lifecycle or seed through paid attempts:

```sh
$H smoke --state <manifest.paths.state> --policy .harness/policy.json --sha HEAD --human
```

It brings up only the environment (lifecycle, store, prepare, teardown) with
no gates and no model call and times each step. Exit 4 (`LIFECYCLE_FAILED`)
names `failure.class` (`port-busy`, `timeout`, `crash`, `missing-tool`,
`cleanup`, `tree-changed`, `environment`) and `failure.advice`; fix the
environment (free the port, install the tool, raise the step timeout), not
the task code. `"lifecyclePreflight": "cached"` in the policy runs the same
check before every `run`, once per base tree, and stops the run before any
paid attempt.

**Probe the writer before the first paid attempt.** Product rules often make
the writer run steps its sandbox may close: a generator fetched from the
registry, a local server for browser checks, a browser tool, a tool that
writes into the home directory, reading the task from a tracker. List those
commands in `repositories[].writerProbe` (`[{ "id", "command": [argv],
"timeoutMs" }]`; `harness-setup` proposes them) and run

```sh
$H smoke --state <manifest.paths.state> --policy .harness/policy.json --sha HEAD --writer-probe --human
```

After `prepare` every command runs in the isolation of each writer of
the repository — same environment and tool profile, its own `TMPDIR`, same
write and read areas, same network, the same class of mechanism (`codex
sandbox` with the writer's permission profile for Codex; harness's
sandbox-runtime with the same policy for Claude, not Claude Code's built-in
sandbox) — with no model call. A blocked probe almost surely blocks the
writer; a pass is strong but not absolute evidence. `data.writerProbe`
gives per command `ok`, `blocked`, `failed` or `outside`, the `reason`
(`listen-denied`, `network-denied`, `write-denied`, `process-abort`,
`missing-tool`, `timeout`, `no-shell`, `environment`), the matching output
line and plain `advice`; exit 4 when anything is blocked or no command was
probed. `outside` is a browser check (`agent-browser`, headless Chrome,
Playwright with a browser, `verify:browser`) the writer's sandbox does not
start: expected, not a blocked step and not a question for anyone; make it a
harness gate only if it passes on HEAD under harness, and `doctor` lists such
steps in `notes` (`browser-checks`). Resolve every
blocked step before `run`: enable it in the policy, prepare it in `prepare`,
move it into a harness gate (gates run outside the writer sandbox and may
listen on localhost), or record that the product rule is waived under the
harness (controller-mode overlay). For a local server the writer must start
itself (`listen-denied`, or EPERM without a path) the probe re-runs the steps
under `"network": "loopback"` by itself; when `writers[].loopback.status` is
`resolves`, run the printed `loopbackCommand` (`… --writer-probe
--apply-loopback`) yourself — a technical lead decision, not an owner
question: it writes the network into the writer's tool profile, records the
reason in `loopbackApplied` and re-probes. Listen and connect on
127.0.0.1/::1 only, no internet — do not turn on the full network
(`codexNetwork: true`) for it. On Linux the server and
its client must run in one shell command; Codex needs the `network_proxy`
feature (the probe reports `environment` otherwise), and the probe's first
line `harness-loopback-check` proves the boundary (`network-open` means this
codex lets external traffic through: do not run the writer with it; rerun the
probe after every codex upgrade — real runs do not repeat this check). A
profile without the `network` field shows `legacy`: the old boundary, with the
runtime's web tools not explicitly closed. The mode
also turns off the runtime's own web tools (Codex web search, Claude
WebFetch/WebSearch); external tool servers configured in the profile stay
outside the boundary. Changing `network` needs
a new plan review. A browser that aborts under the macOS
sandbox (`process-abort`) cannot run inside the writer at all.

### 8. When it stops

`$H explain --state <state> --policy .harness/policy.json [--work <id>]` is
read only (no retries, model calls or state changes). For every stopped order
it returns `code`, `cause`, `phase`, `actor`, `action`, `retryPlanned`,
`message` and `evidence`.

| `actor`      | `action`                                                                                                           | Who acts                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `controller` | `wait`, `retry`                                                                                                    | you: wait, or run `$H run` again                                             |
| `lead`       | `review-plan`, `diagnose-failure`, `replan-dependents`, `wait`                                                     | you: fix the graph, policy or code by the evidence, then run                 |
| `lead`       | `diagnose`, `reset-attempts`                                                                                       | you: diagnose repeated failures, grant a new attempt limit yourself (below)  |
| `user`       | `fix-access`, `fix-environment`, `raise-budget`, `reset-attempts`, `user-decision`, `resume-queue`, `answer-input` | hand it to the user with the message and evidence                            |
| `lead`       | `apply-input`                                                                                                      | you: `input-resolve --request ID [--author A]` (or `input-carry`, see below) |
| `null`       | `none`                                                                                                             | nothing to do                                                                |

The `actor` field decides, not the action name: `reset-attempts` with
`actor: lead` is yours, with `actor: user` it is the human's. The rule is in
`docs/principles.md` («Кто принимает решения»): technical recovery is yours
within the budget; the human gets product questions, contradictions, an
exhausted budget and explicit escalation.

After an answer: `$H input-resolve --state D --request ID --author <your runtime>`
builds the answer snapshot (stored by digest, no files), reviews the plan with
it (an approved round for the same snapshot is reused, no model call), and
applies it. If the work has moved on since the question (another attempt ran,
or the order was edited), `input-resolve` refuses with `NOT_READY` and names
`$H input-carry --state D --request ID --reason "…" [--author A]`, which
supersedes the question onto the same work and carries the answer. Both take
`--reset --reason` for exhausted attempts and `--policy F` after a policy edit.
A policy edit does not un-apply an applied answer once the graph is
re-approved (`reapprove` or `run`) and the approved snapshot still carries the
answer; `run` with a changed `--context` carries applied answers into it. An
order edit does make the answer stale — then use `input-carry`. `retry --reset`
on a ready work resets the counter (the reply says `reset.performed`); while
an attempt runs it refuses. Every command has `$H <command> --help`.

Only `user` actions go to the human: access, environment, budgets, attempt
resets beyond your budget, goal decisions, resuming a paused queue and answers
to executor questions are their decisions.

**Repeated failures (`DIAGNOSIS_REQUIRED`, `actor: lead`, `diagnose`).** With
`recovery.mode: lead` (the default when `inputPolicy.leadAnswers.technical`
is on; `doctor` and `status --human` print the effective rule in plain
words), after `recovery.diagnoseAfter` counted failures (default 2) the next
attempt is not issued until you diagnose them. Failures of the environment,
the model provider, a controller stop and writer questions are not counted
and need no diagnosis. Read the gate log, the review findings and the diff of
the failed attempts, then pick one cause:

- the checks let the defect through or miss a class of inputs → `coverage`
  (add cases, strengthen the check);
- the implementation idea is wrong → `approach`, with a new testable
  hypothesis for the writer;
- the work is too big for one attempt → `split` (re-plan the graph into
  smaller orders and get the plan reviewed; attempts are not added);
- two acceptance criteria or the order and its contract contradict each
  other → `contradiction` (this goes to the human);
- the environment, or none of these → `environment` / `other`.

`$H diagnose --state D --work <id> --cause <cause> --hypothesis "<what the
writer does differently and how it is checked>" [--evidence "<log line or
id>"]`. The hypothesis is required for `coverage` and `approach` and must be
new for the work. The next attempt gets the cause and the hypothesis in its
prompt; then `$H retry --work <id>` or `$H run` continues.

Found a second cause of the same failure after you diagnosed it (for example,
a cleanup error in the test masks the original failure)? Add it to the fresh
diagnosis instead of re-registering the graph or writing an instruction into
the task source: `$H diagnose --state D --work <id> --addendum "<what else
the writer must know>" [--evidence "…"]` (up to 5 per diagnosis). The next
attempt gets the diagnosis with its addenda. An addendum is not a new
diagnosis: it grants no new attempt limit and needs no plan review.

**Infra work too big (`unfinished` twice).** Two `unfinished` attempts of an
infra work (or one attempt that lists many independent deliverables: fault
proxy, wrapper, fixtures, smoke, browser helper…) mean the order is too big
for one attempt. Diagnose `split` and re-plan it into smaller infra works,
each with one deliverable and its own check, instead of another `approach`
on the same order.

**Attempts exhausted (`ATTEMPTS_EXHAUSTED`).** If `explain` says `actor:
lead`, it is yours: with `diagnose`, diagnose the last failure first; with
`reset-attempts`, a fresh technical diagnosis exists (`coverage`, `approach`,
or `other` with a hypothesis) and you grant a new attempt limit yourself:
`$H retry --state D --work <id> --reset --by lead --diagnosis <D…>`. You may
do this `recovery.leadResets` times per work budget (default 2), only after a
new failure and a new hypothesis, and only while the work budget is not
exhausted; status then reads «ведущий дал ещё N попыток (сброс K из M):
причина …; гипотеза …». If `explain` says `actor: user` — the cap is spent,
the cause is not technical, the diagnosis was already used, or the rule is
`user` — hand it to the human with the message and your diagnosis as
evidence. Never call `retry --reset` without `--by lead` yourself: that
records a human decision.

**Writer stopped on the environment (`APPROVAL_REQUIRED`, `cause:
needs-lead`, `actor: lead`, `diagnose-failure`).** The writer reported that
its sandbox closed a mandated step (network, local server, tool, task
source); its own words are in `message` and in `status` / `view`
`lastFailure`. The attempt was not counted, and harness does not retry it:
the same sandbox would hit the same step. This is your move — reproduce it
with `$H smoke --writer-probe`, fix the cause (policy, `prepare`, pinned
context, a harness gate), then `$H retry --work <id>`. Never retry it
unchanged. The same applies when `explain` says the same testcase failed
twice in a row before the last attempt: read the gate log (expected and actual), fix the task or its
context, then retry or split the task.

**A gate needs `ps` (`GATE_SANDBOX_PROCESS_LIST`, cause
`sandbox-process-list`).** The gate ran `ps`, `pgrep` or `top` inside the OS
sandbox for gates, where macOS does not start them. Changing the task code
does not help, and there is no per-gate policy switch for this. Rewrite the
test to check its own child processes by pid (`process.kill(pid, 0)`) or by
marker files, or take that test out of the gate command. `$H smoke` warns
about it (`sandbox-process-list`, with the files that call `ps`) before any
paid attempt; `$H doctor` shows `sandbox.processList`. The engine does not
retry this failure on its own and does not pause the queue: a retry would
fail the same way, and the attempt is not counted. It is your move (explain:
`lead`, `fix-environment`). While you have not, the gate is held: other works
of that repository that need it are not started (`ENVIRONMENT_GATE_HELD`,
`lead`, `fix-environment`; `view.resources.gates.heldLine`). Changing the
gate definition lifts the hold by itself; after fixing the test instead, run
`$H retry --work <id> --by lead` on the stopped work. When the task change
itself added the `ps` call (the base has none), it is a normal counted gate
failure for the writer («тест вызывает ps … уберите вызов»), not this case.

**Code review keeps raising new findings (`REVIEW_REJECTED`).** The reviewer
must list all blocking findings in one round. A new blocking finding on a path
that did not change since the previous round is marked `late` in
`$H result --work <id>` (`findings[].late`) and the failure reads «поздние
находки: N»: a moving target. Fix real defects. For a finding that is a known
limitation of this task (for example, test rigor beyond the acceptance), record
it before the retry:
`$H review-accept --state <state> --work <id> --accept-limitation <finding id>
--reason "<why>"` (add `--actor operator` when the user decided), then
`$H retry --work <id>`. The next round sees the decision and does not re-raise
it without new evidence. It is not an approval and does not skip the gates.

**Executor question (`INPUT_REQUIRED`, `actor: user`, `answer-input`).** The
writer stopped and asks the human. Do not answer it yourself:

1. `$H input-show --state <state> --request <id>` gives the question, the
   options (id, label, consequence and, when the writer gave it, `forUser` —
   what changes for the user), the recommended option, the severity and its
   rationale, and `impact` (`technical`, or absent — the choice changes the
   result for the user).
2. Before the question, add one line of your own in plain words, marked as
   yours: what this decision is about and why the work stopped on it, without
   technical terms. Then pass on the question verbatim: the question text, every
   option with its consequence and `forUser`, the writer's recommendation and
   the severity. Do not shorten, reword, rank, merge or pre-select an option,
   and do not put your explanation inside an option.
3. Record the human's answer in their own words:
   `$H input-answer --state <state> --request <id> --text "<their words>"
[--option <id they chose>] --actor operator --request-version <n>`.
4. Then continue with the `lead` steps of `apply-input` above.

**A question blocks only its own work.** A blocking executor question, or a
product question you recorded for the owner in the task source, holds only
the works it names and the works that depend on them; every other ready work
keeps going. Before you end a session to wait for an owner's answer, start
the run for the ready works: when `status` (`runner.ready`,
`runner.heldByQuestion`), `explain` (`queue`, `actor: lead`,
`action: start-run`) or `harness view` (`progress.queue.line`) says
«запустите harness run: готово N задач, вопрос блокирует только X», that is
your move now, not after the answer. Stop the session only when nothing is
ready.

**Technical question decided by you (`INPUT_REQUIRED`, `actor: lead`,
`answer-input`).** Only when the human opted in with
`inputPolicy.leadAnswers.technical: true` (`init --lead-technical-answers`;
`doctor` and `init --plan` print the rule in `questions.line`) and the writer
marked the question `impact: technical` with no floor (critical area or
critical path). `explain` and `status` then name you (`leadMay: technical`).
Read the options, choose, and record the choice with the reason:
`$H input-answer --state <state> --request <id> --text "<your decision>"
[--option <id>] --actor lead --reason "<why this option>" --request-version <n>`
(no `--reason` — `INVALID_INPUT`). It is shown as «решено ведущим (технический
вопрос)» in `status`, `explain`, `handoff` and the report (a count there);
`explain` and `handoff` also carry your reason.
If you see that an option would in fact change what the user sees or gets,
do not decide it: pass it on to the human as above.

Never close a question that changes the result for the user (`impact`
absent or `user-visible`) with `--actor lead`: the harness refuses it with
`OPERATOR_ANSWER_REQUIRED` (exit 3). The only exception is a policy that has
`inputPolicy.leadAnswers {maxSeverity}` without `technical: true`: then you
may answer up to that severity. With `technical: true` such questions always
go to the human. Pending non-blocking requests to you (`kind: follow-up`,
from the autonomous mode) you answer yourself with `--actor lead`; a question
below the threshold is recorded closed (the writer decided) and takes no
answer. Who answered is
recorded and shown in `status`, `explain`, `handoff` and the report.

**What is happening now.** `status` gives every order a `stage`: the current
stage (`writer` — the writer is coding, `gates`, `review`, `integration`,
`input` — waiting on an executor question, `queued`, `blocked`, `stopped`,
`done`) with the time spent in it, the stages still ahead, what is needed from
the operator (`needs`, same `actor`/`action` as `explain`) and the order's
spend so far, plus one plain line (`stage.line` in Russian, `stage.lineEn` in
English). When you start a long `run` (several orders, or work that will take
more than a few minutes), give the operator a way to watch it themselves and
tell them that what they see comes from the harness itself, not from your
retelling:

1. If the `harness-ui` skill is installed, start the read-only operator panel
   with it and give the operator its local URL.
2. Otherwise give them the watch command:

```sh
$H status --state <state> --human --watch [--interval 10]
```

It refreshes until no attempt is running and no live controller will move an
order, or until Ctrl-C. When asked what is going on, quote `stage.line`
instead of describing or estimating it. An operator UI reads `harness view`
(`$H view --state <state> [--lang en]`): one read-only JSON document from the
harness itself, never your retelling.

**Progress and "how long" questions.** `status` (`works[].attemptSummary`)
and `explain` (`attempts[]`) give one line per order, counted from the store
by the same rules as `harness report`: attempts, failures by class, timeouts,
attempts interrupted by a controller shutdown (not failures), accepted, and
the attempts and group repairs left. When the user asks how long it will take
or how far along it is, quote that `line` and `result.outcome`
(`$H result --state <state> --work <id>`); never estimate time, and never
turn the attempts left into a duration. Keep three words apart (in Russian
«исправлено», «проверка прошла», «принято»): "fixed" — an
attempt produced a candidate; "check passed" — a gate passed on that
candidate (`gates` or evidence); "accepted" — only `result.outcome:
accepted` (gates, independent review and integration). A fix or a green check
is not accepted work.

**Weak machine.** When `doctor --policy` reports `LOW_RESOURCES`, or attempts
and gates on a slow machine stop at their time limits (`timeout`, a gate
killed at its limit), switch the prepared project to the `lean` layer instead
of editing the policy by hand:

1. `$H lean --repository <repo> --plan` writes nothing. Show the user
   `data.changes` (file, field, before → after: `concurrency` 1,
   `gateTimeoutFloorMs`, `runTimeoutMs`, `dependencyStore` for pnpm,
   `profile.layers` in the manifest) and `data.notes` (an explicit value the
   layer replaces, for example `concurrency` 3). Exit 3 with
   `data.problems`: `CONTROLLER_BUSY` — a run is in progress, wait for it;
   `PATH_CONFLICT` — a field was edited by hand, the user decides.
2. `$H lean --repository <repo>` applies it. The policy digest changes:
   graphs in `data.staleApprovals` need `review-plan` again (or `reapprove`
   with `--by` / `--reason`, see step 6 "After a policy change"), and the next
   `run --policy .harness/policy.json` uses the new policy.
3. `$H lean --repository <repo> --off` restores the recorded values exactly
   (`--plan` first). `NOT_READY` without `.harness/project.json`: run
   `init --repository <repo>` first.

### 9. Report the result

`$H result --state <state> --work <id>`: `data.result.outcome` must be
`accepted` and `data.result.shas.result` must equal `git rev-parse <targetRef>`
in the repository. Report what the harness recorded, not your own summary.
Link only addresses the user runs and keeps (their own site or dashboard),
never a temporary port of a server you started in this session and stop:
such links are dead once you leave. To let the user look at an accepted
result, start a harness preview only when they ask
(`$H preview-start --state <state> --ref accepted --work <id>`, policy
`previews[]`): it returns a loopback `url`, and the harness stops it on TTL
or idle; stop it yourself when they are done (`$H preview-stop --state <state>`).
Never start a preview from a gate, a writer task or `run`. A gate that fails only for you
while `doctor` warns that `PATH` Node differs from `toolchain.node` is an
environment problem — fix the shell or the pin, not the code or the gate.
A failed gate whose text says its node differs from the last passing run of
that gate still counts as a failure: pin `toolchain.node` (or fix the shell)
before you blame the code.

After acceptance the target ref can move on. `result` (`data.target`) and
`status` (`works[].target`) compare the accepted SHA with the current ref:
`commitsSinceAccepted`, `filesSinceAccepted`, `diverged` (ref rewritten),
`unavailable`, and `line` / `lineEn` («принято на X; после приёмки N коммитов
— не проверены» / "accepted at X; N commits since acceptance are not
verified"). When `commitsSinceAccepted` is above 0 or `diverged` is set,
quote that line: those commits are **not accepted**. They need a new harness
order (`run`), or at least `$H gates --sha <targetRef>` (`HEAD` when the
checkout is on it; a check, not acceptance) and
`review-code --base <acceptedSha> --head <targetRef>`. Never report the current ref
as accepted because an earlier order on it was.

**A defect found after acceptance** (your own check, the operator, the
source) is a follow-up change, not a retry: edit the order and run again —
the new graph revision needs a new plan review round and approval. An
accepted work whose order changed opens a rework (`work.reopened`) with its
own attempt budget; `status` and `view` say «принято ранее на <sha>;
доработка 1: …» / "accepted earlier at <sha>; rework 1: …", and the forecast
keeps the earlier acceptance. A work gets at most 3 reworks with their own
budget; after that the counter carries over, and an exhausted rework is a
`reset-attempts` of whoever `explain` names (lead resets count per budget). Re-planning a work that was **not** accepted keeps
its counter — never re-plan to dodge `ATTEMPTS_EXHAUSTED`. A new order id
is a new task with its own counter; the plan review that approves the
revision is the guard, so never rename an order to get attempts back. A source task
already closed (`done`) refuses a run with a changed order (`TASK_DONE`): the
operator moves it back out of `done` in the source first.

**Changed your mind about a rework?** `$H cancel --state <state> --work <id>`
on an open rework does not cancel the task: the work goes back to its
accepted revision (`done`, the earlier acceptance and result, `abandoned:
true` in the answer, `work.rework-abandoned` in the feed). Use it when the
rework was a mistake. A delivery problem in the task source (a connector
binding, a closed task) is never a reason to re-plan accepted work.
**Delivery to the task source is not a reason to re-plan.** With a
connector, `run --source` delivers each accepted result to its source task.
When the task stays open after a confirmed delivery, read
`$H source-status --source <connector.json> --state D`: `tasks[].proof` says
which criteria are unproven and why («testcase orders.api.access отсутствует
в evidence gate api-http (есть test.orders.api.access …)»). The fix is the
binding, not the code: correct `criteria[].testId` (the JUnit id is
`classname.name`; node:test writes `test.<test name>`) or `evidence` in
`connector.json`, then `$H source-deliver --source <connector.json> --state D
--reprove [--work ID]`. It re-sends the evidence of the same accepted result
under a new operation key, with no models, gates or Git, and closes the task;
repeating it sends nothing. A binding edit changes neither the order nor the
snapshot revision: no new `source-snapshot`, no plan review, no rework. Never
re-plan, rework or cancel accepted work to force a delivery, and never close
criteria or move tasks in the source by hand while harness can still prove
them. A `conflict` from `--reprove` means the task statement itself changed
— then it is a follow-up change, handled as above.

**Updating a source document that feeds accepted tasks.** Writing the
owner's answer into a question document, or any other edit of a document
linked to accepted tasks, is not a re-plan either. Optional documents are
context: an accepted result still delivers. After the edit, check delivery
with `$H source-status` and, for a `conflict` or `uncertain` operation,
`$H source-reconcile --operation <key>` — not a new plan. Only a changed
required document (`requiredDocuments`) or task text makes the accepted
result belong to the old statement.

**Confirming a provisional answer creates no work.** When the owner's answer
matches the choice you (or the writer) already took provisionally and the
accepted work already implements it, record the confirmation where the
question lives (the question document or `input-answer`) and stop there: no
follow-up task, no new order, no new plan approval. A follow-up task is right
only when the answer differs from what was built.

"Accepted" is local: the harness moved the target ref in this repository and
never pushes. `data.target.remote` (also `status` `works[].target.remote`)
says whether the accepted commit is already on the remote branch, from the
local remote-tracking ref only (no fetch): `state` `pushed`, `not-pushed` or
`unknown`, and `line` («принято локально; в удалённой ветке origin/main ещё
нет» / "accepted locally; not yet on the remote branch origin/main"). Quote
that line to the operator. When it is `not-pushed`, **offer** to push with
the destination the harness names — `git push <pushRemote>
<targetRef>:<pushRef>` (the local branch may track a remote branch of another
name) — and wait for their yes; never push on your own, and never report
`unknown` as pushed or as not pushed. After that push, `status` shows
`pushed` without a fetch (the push updates the tracking ref).

### Lead log: tell the operator what you are doing

The operator watches `$H view` while you work. Harness records your own
harness commands there by itself (plan review, approve, retry, cancel,
source-deliver, input answers, run start and end). Everything else you do —
writing in the task source, checking the site in a browser, fixing the
connector — is invisible unless you say it:

- At the start of your session: `$H lead begin --state <state>` (a lease of
  30 minutes; `--ttl` takes a unit — `90s`, `30m`, `2h`, a bare number is
  refused; each of your records extends it). Your harness commands are
  written to your log only while your session is active, or when they say
  `--by lead` / `--actor lead` (`diagnose` is always yours); a command with `--actor operator` (or
  `--by <human>`) is the operator's and does not extend your lease. Inside
  your open session, `retry` without `--by` and `input-answer` without
  `--actor` run as yours (`--by lead` / `--actor lead`, with the same limits
  and refusals; the answer says `bySource`/`actorSource: lead-session`); a
  human's decision you pass on still needs `--by operator` / `--actor operator`.
- **Declare the whole release first** — before the first graph, record the
  release outline: stages × components with a rough size and who does them,
  not only the next graph:
  `$H lead outline --state <state> --file outline.json` with
  `{"stages":[{"id":"infra","title":"Инфраструктура","kind":"infra","components":[{"id":"api-infra","title":"API: сборка и gates","size":"S","actor":"writers"}]},{"id":"product","title":"Продукт","kind":"product","components":[{"id":"site","title":"Сайт","size":"M","actor":"writers","works":["site-form"]}]},{"id":"deploy","title":"Выкладка","kind":"deploy","components":[{"id":"staging","title":"Стенд","size":"S","actor":"owner"}]}]}`
  (`kind`: infra | product | deploy | other; `size`: S = 1, M = 2, L = 4 tasks,
  or `tasks: N`; `actor`: writers | environment | owner; optional `works`
  names the work IDs or task keys of a component). The forecast then counts
  the unregistered parts as release volume instead of reading one graph as
  100 %; without an outline `status`/`view` show `RELEASE_OUTLINE_MISSING`
  (a hint — `run` is not blocked). When the plan changes, record it again
  with `--reason "<why>"`: the view says «план вырос: +…» instead of an
  unexplained drop.
- At each step outside harness, one short line in plain words, the way you
  would tell a non-developer: `$H lead note "Обновляю документ DOC-2 в источнике задач"
--state <state>` (up to 200 characters; no secrets, no paths, no logs).
- When all code is accepted, delivered and checked, write the final report:
  `$H release done --state <state> --summary "<what was done, what is left>"`.
  Until then the view says «код принят, ведущий ещё работает: <your last
  note>» and progress stays below 100 %; it refuses while a work or rework is
  still open.
- When you stop: `$H lead end --state <state>`. If approved works are ready
  and nothing runs, it still ends the session but warns
  `READY_WORKS_NOT_RUNNING` (`data.readyNotRunning`): start `$H run` first.

### 10. New session

Nothing is asked again:

1. `$H init --repository <repo> --plan` returns the saved manifest
   (decisions, `paths.state`) with `status: complete` and writes nothing.
2. `$H status --state <paths.state>` — `NOT_FOUND` means "never run".
3. `$H explain --state <paths.state> --policy <repo>/.harness/policy.json`.
4. Read `.harness/work/*.json` and the notes.
5. With a task-source connector (`connector.json` next to the policy),
   `$H doctor --policy <repo>/.harness/policy.json` also checks the source
   version. When `warnings` carries its compatibility line, tell the operator
   that line once: the writer works without the full task context until the
   source is updated. Product questions you record in the task source as
   question documents appear in `$H view` (`sourceQuestions`) after the next
   `source-snapshot` or `run --source`; the owner answers them there.
6. Updates, one line to the user: `$H update --check --state <paths.state>`
   (it reaches only the npm registry, no telemetry;
   offline it answers «Не удалось проверить обновления» and nothing else
   changes). With `"mode": "off"` in `.harness/updates.json` skip the call and
   say nothing. Quote `data.line` as is: «Доступна harness … — что нового: …;
   обновить — …», «Обновлений нет», or «Нужно ваше решение: …» (a format
   change: never apply it yourself; ask the user and, with their yes, run the
   `data.check.command`). Apply an `available` pair only when the user asks
   or the mode is `auto`: `$H update --apply --state <paths.state> --wait 30`
   — it never installs during a run, copies the state, checks the new version
   and goes back by itself on failure; report `data.line`. Do not run it in
   the middle of your own `run`.

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
- **Lead log**: `$H lead begin|note|end`, `$H lead outline --file`, `$H release done --summary` (see «Lead log»).
- **Queue control**: `$H status`, `pause`, `resume`, `cancel`, `retry`
  (bounded by the policy), `deliver` (repeats delivery without models or Git
  integration); with a connector, `source-deliver --reprove` re-proves the
  criteria of an accepted result after a binding fix.

## Don'ts

- Do not hand-order or hand-compose context sources. Harness builds the
  context snapshot (`input-context`, `source-snapshot`) and its digest does
  not depend on source order; a hand-made copy only risks a different
  content. When a digest differs, the review record names the changed
  sources (`changes.context`).
- Do not re-register a graph or a source snapshot just to pass a note to the
  writer: use `diagnose --addendum`. A re-review of an unchanged plan does
  not spend the plan-review round limit (`counted: false`), but a changed
  plan does; `status` shows «раундов N/M, осталось K».
- Before `lead end`, start `$H run` for every approved ready work; the
  session end warns `READY_WORKS_NOT_RUNNING` when you forgot.

- Use only the public CLI (`$H <command>`). Never import or call the
  package's library internals (`Engine`, `approve`, `carryInput`, isolation
  helpers) from your own scripts: approvals, answers and policy changes made
  that way bypass the review and the audit trail. When no command does what
  you need, stop and report it to the user as a harness finding.

- Do not call a separate model to plan, and do not mark a plan or draft as
  approved: approval comes only from `review-plan` / `approve` / `reapprove`
  / `run`. Never approve by calling library internals (`Engine.approve`).
- Do not weaken or remove gates or requirements so that a new feature test
  is green before its implementation; a project already failing on its base
  is a separate first task.

- Do not edit the target ref or the attempt worktrees yourself; acceptance
  happens only through `harness run`. An approved `review-code` and a green
  `gates` are not acceptance either.
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
