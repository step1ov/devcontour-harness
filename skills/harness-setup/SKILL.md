---
name: harness-setup
description: Install, configure or upgrade devcontour-harness for a new or existing npm/pnpm Git repository, including pnpm/Turborepo monorepos such as Turbo Starter and task sources such as Relay — decide every routine choice yourself from the repository, ask the user only at real forks (which vendor writes and which accepts, a missing Relay fact, isolation or Docker, rule conflicts, commits, writes to Relay, live model calls), install the exact version in `.harness-tools/`, run `harness init`, and hand over to the `harness` skill; upgrade an installed version with a state copy and a compatibility check.
---

# Harness setup

This skill installs and upgrades the `devcontour-harness` package for one
repository and leaves it ready for work. Running work orders (plan, run,
explain, result) is the job of the `harness` skill shipped inside the package
(`<tooldir>/node_modules/devcontour-harness/skills/harness/SKILL.md`); read it
once the package is installed.

This skill only explains the route. Gates, review, write scope, budgets and
the reviewer vendor rule are enforced by the harness itself; nothing here
replaces or relaxes them.

Every `harness` command prints one JSON envelope on stdout (`ok` with `data`,
or `error`); exit codes: 0 success, 2 invalid input, 3 refusal or block,
4 infrastructure. Below `$H` is the installed CLI:
`H=<tooldir>/node_modules/.bin/harness`, and `<pkg>` is
`<tooldir>/node_modules/devcontour-harness`.

Modes: **install** (first setup), **upgrade** (change the installed version),
**check** (report what is installed; read only). Pick the mode from the
request; when the repository already has `.harness/` and a pinned or
installed `$H`, it is upgrade or check, not install.

## Decide or ask

Decide everything you can from the repository and the defaults below, and
report each decision with its reason at the end; the user overrides any of
them by saying so. Ask only at a fork — a choice that changes who is trusted,
what leaves the machine, what is spent or which project rule gives way — and
ask all open forks of a step in one round (multiple choice where the host
supports it).

| Choice                     | Default (decide yourself)                                                                                     | Ask when                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writer and reviewer vendor | —                                                                                                             | always: which of `claude` / `codex` writes; the other one reviews and accepts                                                                         |
| Same vendor for review     | never                                                                                                         | only one runtime is installed, or the user asked for it                                                                                               |
| Models and effort          | runtime defaults                                                                                              | the user named models                                                                                                                                 |
| Branch                     | new branch `harness-setup` from the current branch; an existing `harness/accepted` is reported and left alone | the working tree is not clean                                                                                                                         |
| Install location           | `<repo>/.harness-tools`                                                                                       | the user asked for a directory outside the repository                                                                                                 |
| Package source             | npm `@alpha` resolved to the exact version                                                                    | the user gave a version or a tarball                                                                                                                  |
| Stack profile              | built-in by lockfile; a local `.harness/profile.json` when the project does not have its scripts (below)      | —                                                                                                                                                     |
| Gates                      | derived from the project's own commands (step 6), each reported with its command                              | a check the project or its CI runs would be left out, or no command can prove behaviour without new dependencies                                      |
| Plan approval              | `agent` (`init` default)                                                                                      | the user wants to approve plans themselves (`operator`)                                                                                               |
| Task source                | Relay when the repository or the request names it, otherwise graph files                                      | both are plausible                                                                                                                                    |
| Relay connection           | discovered from the repository and environment                                                                | a fact is missing: endpoint or binary/config, `projectId`, which tasks                                                                                |
| Relay completion           | `review-only` (a human closes the task)                                                                       | the user wants `complete`                                                                                                                             |
| Controller mode            | —                                                                                                             | the product AGENTS.md tells agents to manage worktrees, commits, merges or Relay history: the overlay then takes precedence over those rules (step 9) |
| OS isolation               | on                                                                                                            | prepare or gates fail inside the sandbox (store, network, Docker socket)                                                                              |
| Docker environment         | none                                                                                                          | gates need a database or other service                                                                                                                |
| Project rule conflicts     | —                                                                                                             | a project rule forbids what setup creates (for example new `.md` files: `.harness/README.md`)                                                         |
| Commit, Relay writes, runs | —                                                                                                             | always confirm: committing the setup, `run --source` / `source-deliver` / `source-reconcile`, any live `run` or `review-plan`                         |

## Install

### 1. Preconditions

Node.js ≥ 24.3, `git`, `npm` (or `pnpm` for a pnpm project) and the runtime
CLIs (`claude --version`, `codex --version`). Whether a runtime is signed in
is not detectable without a model call: the user confirms it. A missing or
signed-out runtime is the user's to fix.

The package manager version is checked exactly: the built-in profiles pin
one (`npm-ci` pins npm `11.4.2`), and `package.json#packageManager`
(`npm@<version>` / `pnpm@<version>`) overrides that pin. Another version is
`NOT_READY` (`TOOL_VERSION`) at `init`; adding `packageManager` to an existing
project is the user's decision.

### 2. Repository

**Existing.** It must be the top level of a Git repository with at least one
commit and exactly one lockfile: `package-lock.json` (profile `npm-ci`) or
`pnpm-lock.yaml` (profile `pnpm-frozen`). With both or none, write a local
profile (step 6).

**New.** Create it only with the user's consent, at the path they gave:

```sh
git init <repo> && cd <repo>
npm init -y && npm install          # writes package-lock.json
```

The built-in `npm-ci` profile needs two scripts: `check` and `test`, where
`test` writes JUnit to `.reports/junit.xml`. A minimal set for Node's test
runner, with the installed npm version pinned:

```json
"packageManager": "npm@<npm --version>",
"scripts": {
  "check": "node --check index.js",
  "test": "mkdir -p .reports && node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=.reports/junit.xml"
}
```

Add `.reports/` and `node_modules/` to `.gitignore`, a first source file and
a passing test, then commit. The first commit must pass its own gates: a
project failing on its base is a separate first task, not a reason to relax
a gate.

### 3. Branch

`git status` must be clean (ask the user about local changes; never stash or
discard them yourself). Then `git switch -c harness-setup`.

`run` creates `refs/heads/harness/accepted` from the `HEAD` of the main
checkout when that ref does not exist yet. Keep the setup branch checked out,
with the setup committed (step 11), until the first `run`: otherwise
`harness/accepted` starts from a commit without it. When `harness/accepted`
already exists, report its SHA and leave it alone. Accepted work lands in
`harness/accepted`, not in the setup branch; merging it anywhere is the
user's decision.

### 4. Install the exact version

Resolve `@alpha` to the exact version first and install that:
`npm view devcontour-harness@alpha version`. For a tarball, compare
`shasum -a 256 <file.tgz>` with the sha256 the user gave and stop on a
mismatch.

**Inside the project** — `<tooldir>` = `<repo>/.harness-tools`:

```sh
T=<repo>/.harness-tools
mkdir -p "$T"
npm install --prefix "$T" --save-exact --omit=dev --ignore-scripts devcontour-harness@<version>
printf 'node_modules/\n' > "$T/.gitignore"
```

The version is pinned by `.harness-tools/package.json` and its
`package-lock.json`, not by a directory name; both are committed with the
setup, `node_modules/` is not. The project's own `package.json` and lockfile
do not change. When the project declares npm `workspaces` or a
`pnpm-workspace.yaml` whose globs match `.harness-tools`, or lint/type/test
globs that would read it, tell the user before going on.

In a fresh clone, or after `node_modules/` was removed, restore the pinned
version without changing the pin:

```sh
npm ci --prefix <repo>/.harness-tools --omit=dev --ignore-scripts
```

A tarball source records a local `file:` path in `.harness-tools/package.json`
that does not exist on other machines: install it the same way, but keep the
whole directory out of Git with `.git/info/exclude` instead of committing it:

```sh
npm install --prefix "$T" --omit=dev --ignore-scripts <file.tgz>
grep -qxF '.harness-tools/' <repo>/.git/info/exclude || echo '.harness-tools/' >> <repo>/.git/info/exclude
```

**Outside the project** — any directory the user names, the same commands
with `--prefix <tooldir>`; nothing is written into the repository.

Then:

```sh
H=<tooldir>/node_modules/.bin/harness
$H --version
$H doctor
```

Never install the package into the project's own dependencies as part of this
route, and never put the execution state inside the repository.

### 5. Read the project

Before choosing gates read: the root and package `package.json` scripts, the
lockfile, `pnpm-workspace.yaml`, `turbo.json`, every `AGENTS.md`, CI
workflows (they show which commands the project trusts), code generators
(OpenAPI, SDK, Prisma) and Relay traces (`relay.config.json`,
`relay.workspace.json`, `.artifacts/relay/`, Relay commands in AGENTS.md).

### 6. Stack profile and gates

**A built-in profile fits** when the project already has the scripts it
calls (`npm-ci` / `pnpm-frozen`: `check`, and `test` writing JUnit to
`.reports/junit.xml`). Then skip to step 7.

**Otherwise write `.harness/profile.json`** (`<pkg>/schemas/stack-profile.schema.json`)
and pass `--profile ./.harness/profile.json` to `init`. This is the usual
case for a pnpm/Turborepo monorepo; Turbo Starter is the worked example
(`<pkg>/docs/turbo-starter.md`, `<pkg>/examples/turbo-starter/policy.json`):

- `prepare`: `pnpm install --frozen-lockfile`.
- check gates (`kind: check`): the project's own type and build commands per
  package, called directly — `pnpm --filter <package> run check-types`,
  `… run build`, with `dependsOn` where one needs another's output. Prefer
  the per-package commands a root script runs when the root script also
  does work that cannot run in a worktree (for example an environment check
  that fails on the pinned Node); that keeps every check the root script
  makes. Leaving out a check the project or its CI runs is the user's
  decision. Never call `turbo run` without `--force` (a cache hit proves
  nothing), and `pnpm exec turbo` only with an exactly pinned `turbo`.
- test gates (`kind: test`, at least one, with
  `report: { type: junit, path: .artifacts/junit/<gate>.xml }`): an existing
  test command that can write JUnit without new dependencies (Node's test
  runner `--test-reporter=junit --test-reporter-destination=…`, Vitest's
  built-in `junit` reporter). When the project has none, or its AGENTS.md
  forbids tests in product code, put acceptance tests in
  `.harness/acceptance/*.test.mjs` run by `node --test`, as the example does.
  When no command can prove behaviour without adding a dependency, ask.
- code generation (OpenAPI, SDK): a test gate that runs the project's pinned
  generator and fails on any difference in the generated paths
  (`<pkg>/examples/turbo-starter/harness/acceptance/generation.test.mjs`).
  Generated outputs are not `generatedPaths` (that list means "protected");
  orders that change generated code list the outputs in their write scope.
  `generatedPaths` is only for ignored outputs nobody edits (Prisma client).
- `protectedPaths`: lockfile, every `package.json`, `pnpm-workspace.yaml`,
  `turbo.json`, `.npmrc`, `scripts/`, `infra/`, CI, every `AGENTS.md`,
  generator inputs and configuration, `.harness/`, `.harness-tools/`.
- `toolchain`: the package manager version from `packageManager`, and
  `node: ">=24.3"`.
- `environment.values` for variables the commands need to stay local
  (for example `DOTENV_CONFIG_PATH: /dev/null`, `CHECKPOINT_DISABLE: 1`);
  secrets only by name in `environment.secrets`, never their values.

A gate that is red on the current base stays: fixing the base is a separate
first work order. List the gates with the command each one runs in the
report.

### 7. `harness init`

```sh
$H init --repository <repo> --writer <claude|codex> --plan
$H init --repository <repo> --writer <claude|codex>
```

Add `--profile ./.harness/profile.json` with a local profile. The first call
writes nothing: read `data.files`, `data.conflicts`,
`data.toolchain.problems`, `data.facts` and `data.manifest.paths.state`, and
resolve every conflict or problem with the table of the `harness` skill
(step 3) before the second call. `init` is create-only: `.harness/.gitignore`,
`.harness/README.md`, `.harness/project.json` (local, not under Git) and
`.harness/policy.json`. The state lives outside the repository
(`HARNESS_STATE_HOME`, `XDG_STATE_HOME` or `~/.local/state/devcontour-harness`).

### 8. Runtimes, approval, isolation

Edit `.harness/policy.json` only as the decisions require:

- models: `model` on `roles.<role>.writer` and on `review.code.reviewer`,
  `review.plan.reviewer`, `review.contract.reviewer`;
- effort: `effort` (`low`, `medium`, `high`, `xhigh`) only on bindings whose
  `runtime` is `codex`; on any other runtime it is refused;
- a reviewer of the writer's vendor (an explicit yes only): on
  `review.code` and/or `review.contract`, set `reviewer.runtime` to the
  writer's runtime and add `"vendor": "same-vendor-allowed"`. Leave
  `review.plan` with the other vendor: `init` reads the saved writer from the
  plan reviewer, so changing it makes every later `init --plan` report
  `content-differs` on `policy.json`. When the user wants it anyway, say so
  and let them decide;
- operator approval: top-level `"approvalMode": "operator"`;
- isolation: keep `isolation.mode: os`. When `doctor` or a first `prepare`
  shows the sandbox blocking the package store, the network or the Docker
  socket, show the diagnosis and ask between `isolation.domains` and
  `isolation.mode: none`;
- with the version pin committed inside the project: `.harness-tools/` in
  `repositories[0].protectedPaths` (already there when the local profile
  lists it).

Never remove or weaken anything `init` wrote. Keep the writer runtime as
`init` wrote it: a different writer vendor is a new `init --writer` decision.

Check after editing:

```sh
$H doctor --policy <repo>/.harness/policy.json
$H init --repository <repo> --plan
```

`doctor` checks the policy schema, runtimes and toolchain only; `init --plan`
must show `data.conflicts` = 0. The cross-checks of the policy (effort on a
non-codex runtime, the reviewer vendor rule, unknown gates) run in
`$H validate --graph <graph> --policy <repo>/.harness/policy.json`: run it
for the first graph before any review or run, and fix the policy, not the
check, when it fails.

**Services.** When gates need a database or another service, ask before
using Docker. With a yes, copy `<pkg>/examples/turbo-starter/harness/`
(`compose-bridge.mjs`, `compose.acceptance.yml`, `env/`) into `.harness/`,
adapt the compose model to the project and add `repositories[0].lifecycle`
(setup, ready, teardown) and the secret names as in
`<pkg>/docs/turbo-starter.md`; gates that need the service run through
`node .harness/compose-bridge.mjs exec -- <command>`.

### 9. Controller mode

When the product AGENTS.md tells an agent to create worktrees, commit, merge,
move tasks or keep Relay history itself, the harness controller does those
operations instead, and the worker needs the controller-mode overlay
(`<pkg>/templates/controller-mode/README.md`). The overlay takes precedence
over those product rules, so ask first: show the rules it overrides and say
that the overlay text names Turbo Starter commands (`pnpm worktree:create`,
`pnpm rest-api-sdk:generate`) as examples. Without a yes, keep controller
mode off; the harness still refuses a worker commit (`scope-violation`).
With a yes, build the pack from the committed AGENTS.md files:

```sh
node --input-type=module -e "
import { controllerContext } from '<pkg>/examples/turbo-starter/setup.mjs';
import { execFileSync } from 'node:child_process';
const repo = '<repo>';
const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
controllerContext({ repo, baselineSha, upstream: null }, repo + '/.harness/work/context');
"
```

It writes `.harness/work/context/controller-mode/` (the unchanged overlay,
`references/` with the product AGENTS.md files, `provenance.json`); a rebuild
starts from an empty directory and never lists `.harness/`. The pack is not
committed to the repository (some projects forbid new `.md` files): keep it
out of Git and rebuild it in a fresh clone with the same command. Its
`provenance.json` records the `HEAD` it was built on, so a rebuild on another
commit is a new pack digest and the next Relay snapshot needs a new approval
even when no AGENTS.md changed.

```sh
grep -qxF '.harness/work/context/controller-mode/' <repo>/.git/info/exclude \
  || echo '.harness/work/context/controller-mode/' >> <repo>/.git/info/exclude
```

File graphs list `"context": ["controller-mode"]` on every order; Relay tasks
list it in `tasks[].context` of the connector (step 10). A changed AGENTS.md
or overlay means rebuilding the pack, and the next snapshot needs a new
approval; a result already accepted is still delivered.

### 10. Task source

**Graph files.** Nothing more to configure; the `harness` skill plans the
first graph.

**Relay.** Write `.harness/connector.json` from `<pkg>/docs/connectors.md`
("Конфигурация"):

- `"version": 1` and `"provider": "relay-v1-http"` or `"relay-v2-cli"`,
  always explicit — never guessed from a binary named `relay`;
- `projectId` and `actor` (`harness-controller`) at the top level;
  `repository.id` is the policy repository id (`app` after `init`);
- adapter settings nested under `relay`: v1 `relay.endpoint`; Relay-2
  absolute `relay.binary` and `relay.config`, `relay.project` for a workspace,
  `relay.env` that may set `RELAY_HOME` (and on macOS `DYLD_LIBRARY_PATH` to
  SQLite ≥ 3.44) but never `RELAY_CONFIG` or `RELAY_ACTOR`;
- `tasks[]`: `ref`; `role` and `gates` only from `data.facts` of `init`;
  `writeScope` (required) = the role's `writePaths` from the facts, or, when
  the role has none, `["."]` (the whole repository) or the narrower paths the
  task names (with generated outputs when it changes them); `criteria` mapped
  to a gate and a JUnit `testId`; `"context": ["controller-mode"]` with
  controller mode (step 9) — the pack is read from `contextDir`, by default
  `work/context` next to `connector.json`;
- `completion: { "mode": "review-only" }` unless the user chose `complete`;
  `eligibility.columns` from the project's board; `history.enabled: true`;
- no `stateDir` (pass `--state <manifest.paths.state>`), no secret values.

Checks that do not write to Relay:

```sh
$H source-check --source <repo>/.harness/connector.json --policy <repo>/.harness/policy.json --state <state>
$H source-snapshot --source <repo>/.harness/connector.json --policy <repo>/.harness/policy.json --state <state> --out <dir outside the repo>
$H validate --graph <dir outside the repo>/graph.json --policy <repo>/.harness/policy.json --context <dir outside the repo>/context.json
```

`source-check` is read only. `source-snapshot` reads Relay but records the
snapshot in the connector state under `--state` and writes `graph.json`,
`context.json` and `manifest.json` to `--out`; its output names the pinned
local packs (`localContext`) and a context over the limits as
`LIMIT_EXCEEDED`. `run --source`,
`source-deliver` and `source-reconcile` write to Relay: run them only after
the user says so.

### 11. Commit

With the user's yes: commit on the setup branch `.harness/.gitignore`,
`.harness/README.md`, `.harness/policy.json`, `.harness/profile.json`,
`.harness/connector.json`, `.harness/acceptance/` and the bridge files when
present, and, for an npm source inside the project,
`.harness-tools/.gitignore`, `.harness-tools/package.json`,
`.harness-tools/package-lock.json`. Never `project.json`, `node_modules/` or
the state or the controller-mode pack. Do not push or merge.

### 12. Report and hand over

Report: installed version (and the tarball sha256), `doctor`, every decision
of the table with its reason, the gates with their commands, the policy
edits, controller mode, the connector check and snapshot (`graphId`,
`graphDigest`, eligibility per task), the commit SHA. Then continue with the
`harness` skill: brief → `plan-request` → draft → `plan-check` → `validate`
→ `run` (for Relay: `review-plan` and `run --source`). A live `run` or
`review-plan` calls paid models: start it when the user asks.

## Upgrade

An upgrade changes only the package. Policy, profiles, graphs, accepted
results and `.harness/project.json` stay as they are unless the user decides
otherwise in step 7.

1. **Current and target.** `$H --version`; target from the user, or
   `npm view devcontour-harness dist-tags`. Install the target into a scratch
   directory outside the repository (`N=<scratch>/node_modules/.bin/harness`)
   and read its `docs/release-notes/<version>.md` and the format matrix of
   `docs/upgrade.md` for every version in between.
2. **Stop the writers.** `$H status --state <state>`; `$H pause --state <state>`;
   wait for active attempts to finish or ask the user to stop them; stop every
   `run` process on this state. A paused queue alone is not enough.
3. **Record.** `git rev-parse refs/heads/harness/accepted` and
   `$H result --state <state> --work <id>` for the accepted orders.
4. **Copy the state** while nothing writes: `cp -Rp <state> <state>.bak-<old version>`.
5. **Check on a second copy** with the target version: `$N doctor --state <copy>`
   and `$N status --state <copy>`. Hash the copy's files before and after;
   they must not change. Stop and report when `doctor` shows
   `data.state.compatible: false` or `status` fails with
   `STATE_VERSION_UNSUPPORTED`.
6. **Install** into the same `<tooldir>`:
   `npm install --prefix <tooldir> --save-exact --omit=dev --ignore-scripts devcontour-harness@<new>`
   (or the new `.tgz` after its sha256 check).
7. **Verify.**
   - `$H --version`; `$H doctor --state <state> --policy <repo>/.harness/policy.json`.
   - `$H init --repository <repo> --plan` must show `data.conflicts` = 0.
     `content-differs` on `.harness/project.json` means a saved decision no
     longer matches: the built-in profile digest changed (compare
     `$H profile --profile <id>` with the pin in `project.json`), the
     repository moved (`root`, `projectId`), or the API version changed.
     Show the difference to the user. With their yes, move the manifest out
     of the repository, next to the state copy of step 4
     (`mv <repo>/.harness/project.json <state>.bak-<old version>/project.json`),
     and run
     `$H init --repository <repo> --profile <saved profile.ref> --writer <saved runtimes.writer> --state <saved paths.state>`
     with the values of the moved manifest, so the profile choice and the state
     path are kept; never edit the manifest by hand.
   - The policy is not regenerated. List gates or defaults of the new profile
     that the policy lacks and add them only with the user's yes; never weaken
     the existing ones. A changed policy changes the facts of planning, so
     graphs may need plan review or approval again (`explain` names it).
   - `$H validate --graph <graph> --policy <repo>/.harness/policy.json` for
     every `.harness/work/*.json` graph.
   - Read the release notes for new options the setup should use (for
     example `tasks[].context` of the connector for controller mode) and
     propose them; do not apply them unasked.
8. **Resume.** `$H resume --state <state>`, then `run` as before. Attempts that
   were active at the stop are not continued with old tokens; recovery either
   accepts a saved integration SHA or ends the attempt.
9. **Commit** the changed `.harness-tools/package.json` and
   `package-lock.json` on a branch, with the user's yes.

Rollback: stop the writers again; reinstall the old exact version; when the
new version already wrote state the old one cannot read, restore the copy of
step 4 and reconcile `harness/accepted` with the recorded SHAs
(`docs/upgrade.md`, "Откат"). Never `git reset --hard` the user's repository.

## Check

Read only: `$H --version`, `$H doctor`, `$H init --repository <repo> --plan`,
`$H status --state <paths.state>`, and the pin in
`.harness-tools/package.json` when present. Report a mismatch between the pin
and `$H --version`, or a missing `node_modules/` (restore with `npm ci`, step
4); do not fix it unasked.

## Don'ts

- Do not ask what the repository answers, and do not decide a fork of the
  table for the user: the vendors, a reviewer of the writer's vendor,
  controller mode, a left-out project check, isolation, Docker, project rule
  conflicts, commits, writes to Relay and live runs are theirs.
- Do not install into the project's dependencies, edit its `package.json` or
  lockfile (except when bootstrapping a new project with consent), or put the
  state inside the repository.
- Do not weaken gates, budgets, isolation or the reviewer rule, and do not set
  `same-vendor-allowed` without an explicit yes.
- Do not overwrite `.harness/project.json` or `.harness/policy.json` on a
  `content-differs`; that is a decision to show to the user.
- Do not write to Relay, call live models, push, tag or publish without being
  asked.
- Do not upgrade while a controller writes the state, and do not skip the
  state copy.
