<!-- harness guide plan: Plan the work graph and validate it -->

### 4. Plan the graph

You are the planner: write the draft yourself. No other model is called for
planning, and the draft approves nothing.

**Declare the release outline first.** Before the first graph, record the
whole release, not only the next graph: stages (infra per service, product,
deploy, …) × components with a rough size and who does them (writers,
environment, owner) — `$H lead outline` (see `$H lead outline --help`; before
the first `run`, with `--policy <policy>`).
Without it `status` and `harness view` say «плана выпуска нет — прогноз по одному
графу» and the forecast reads one graph as the whole release. Update the
outline with a reason when the plan grows.

1. Write the user's goal and constraints to `.harness/work/<graph-id>.brief.md`.
   Keep it next to the graph file: `run --graph .harness/work/<graph-id>.json`
   records it in the state, and the release review checks the release
   against it, failure paths included.
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
   and `digest` exactly, never invent ids or digests. Size tasks by user
   scenario (alpha.71): one task per coherent scenario through all its layers.
   Split only by repository, or when the parts are independent and can be
   accepted separately. A few larger tasks beat many slices that each pay for
   gates and review. In light mode, shared test infrastructure that only the
   first product task needs (an acceptance launcher, fixtures) goes inside
   that task, not into a separate work; in strict mode, acceptance code under
   `repositories[].infra.paths` stays an `infra` task that product tasks
   depend on (below). Task keys become order
   ids; `description` becomes the goal; omitted `writePaths` mean the whole
   repository. Scope each task's `gates` to the gates that cover its
   criteria and the packages it touches: a web-only task does not list the
   API acceptance gate. Keep every test gate a requirement links to. This
   is guidance, not a check. A new feature test belongs to the task whose behaviour it
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

**Light mode (the default since 0.1.0-alpha.69).** A policy without
`harnessMode` is light (`<pkg>/docs/light-mode.md`): writers and gates run
on the host with Docker, browsers, network and their own ports and compose
project (`attemptEnv`, `COMPOSE_PROJECT_NAME`); the only guard is writes
outside the attempt worktree, its temp dir and tool caches (against
accidents, not a security boundary: Docker and caches bypass it). Acceptance tests,
fixtures and compose test services live with the product code inside
product works and are reviewed as code; infra works, a separate infra phase
and `gateChanges` below are not required. Don't split test infrastructure
into a separate stage: use the harness helpers — per-attempt services and
`attempt-env.json` (`HARNESS_ATTEMPT_ENV_FILE`), the `browser` (Playwright)
gate, the gateway-mirror check. Open an infra work only for a shared thing
several works need (for example a new compose service), reviewed like code.
In acceptance criteria and tests ask for what a user or client sees (status,
text, roles, links, payloads), never hashed CSS Module classes or the RSC
payload.
Strict mode (`harnessMode: strict`) is frozen; switching modes is the
owner's decision — never change it yourself. When the product is served
through a gateway in production, gates should go through the project's
gateway (`repositories[].gateway`) and the routing files belong in
`release.topology`.

**Infra works (strict mode, or when the owner wants that boundary).**
Harness-owned infrastructure code — environment bridges,
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
