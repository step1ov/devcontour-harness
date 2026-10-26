---
name: harness-setup
description: Install, configure or upgrade devcontour-harness for a new or existing npm/pnpm Git repository — ask the setup questions once (project, branch, install location, package source, writer and reviewer models, approval, task source such as files or Relay), install the exact version inside the project (`.harness-tools/`) or outside it, run `harness init`, record the decisions and hand over to the `harness` skill; upgrade an installed version with a state copy and a compatibility check.
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
`H=<tooldir>/node_modules/.bin/harness`.

Modes: **install** (first setup), **upgrade** (change the installed version),
**check** (report what is installed; read only). Pick the mode from the
request; when the repository already has `.harness/` and a pinned or
installed `$H`, it is upgrade or check, not install.

## Install

### 0. Ask once

Ask everything in one round (a multiple-choice question per item where the
host supports it); offer the default first. Do not ask what the repository
already answers: detect the lockfile, `packageManager`, an existing
`.harness/`, the current branch and which of `claude` / `codex` are installed
first. Whether a runtime is signed in is not detectable without a model call:
the user confirms it.

| #   | Question                        | Options (default first)                                                                      | Becomes                                                               |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Repository                      | existing path / new project at a path                                                        | step 2                                                                |
| 2   | Branch for the setup            | new branch `harness-setup` / current branch                                                  | step 3; never the name `harness` (it clashes with `harness/accepted`) |
| 3   | Install location                | inside the project `.harness-tools/` / outside, in a tool directory                          | `<tooldir>` of step 4                                                 |
| 4   | Package source                  | npm `@alpha` resolved to an exact version / npm exact version / local `.tgz` with its sha256 | step 4                                                                |
| 5   | Writer runtime                  | `claude` / `codex`                                                                           | `init --writer`; the reviewer is the other vendor                     |
| 6   | Models and effort               | runtime defaults / explicit `model` (and `effort` for codex) for writer and reviewer         | step 6                                                                |
| 7   | Reviewer of the writer's vendor | no (`different-vendor`) / yes for code and contract review, stated explicitly                | step 6                                                                |
| 8   | Plan approval                   | `agent` (the reviewer approves) / `operator` (a human runs `approve`)                        | step 6                                                                |
| 9   | Task source                     | graph files in `.harness/work/` / Relay v1 (HTTP) / Relay-2 (CLI)                            | step 7                                                                |
| 10  | Commit the setup                | commit on the setup branch / leave uncommitted                                               | step 8                                                                |

For Relay also ask: the v1 endpoint, or the absolute Relay-2 binary, the
absolute `relay.config.json` / `relay.workspace.json` and the workspace
project; `projectId`; `actor` (default `harness-controller`); the task refs
and, per task, its write scope when it is narrower than the whole
repository; the columns a task may start from; `completion.mode`
(`review-only` for the first run, or `complete`).

The answers are the user's decisions. Do not change them later without
asking.

### 1. Preconditions

Node.js ≥ 24.3, `git`, `npm` (or `pnpm` for a pnpm project) and the runtime
CLIs the answers name (`claude --version`, `codex --version`). A missing or
signed-out runtime is the user's to fix; a live run is impossible without it.

The package manager version is checked exactly: the built-in profiles pin
one (`npm-ci` pins npm `11.4.2`), and `package.json#packageManager`
(`npm@<version>` / `pnpm@<version>`) overrides that pin. Another version is
`NOT_READY` (`TOOL_VERSION`) at `init`; adding `packageManager` to an existing
project is the user's decision.

### 2. Repository

**Existing.** It must be the top level of a Git repository with at least one
commit and exactly one lockfile: `package-lock.json` (profile `npm-ci`) or
`pnpm-lock.yaml` (profile `pnpm-frozen`). Both or none is decided by the user
(`--profile`, or a local `.harness/profile.json` passed as
`--profile ./.harness/profile.json`).

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
discard them yourself). Then `git switch -c <branch>`.

`run` creates `refs/heads/harness/accepted` from the `HEAD` of the main
checkout when that ref does not exist yet. Keep the setup branch checked out,
with the setup committed (step 8), until the first `run`: otherwise
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

### 5. `harness init`

```sh
$H init --repository <repo> --writer <claude|codex> --plan
$H init --repository <repo> --writer <claude|codex>
```

The first call writes nothing: read `data.files`, `data.conflicts`,
`data.toolchain.problems`, `data.facts` and `data.manifest.paths.state`, and
resolve every conflict or problem with the table of the `harness` skill
(step 3) before the second call. `init` is create-only: `.harness/.gitignore`,
`.harness/README.md`, `.harness/project.json` (local, not under Git) and
`.harness/policy.json`. The state lives outside the repository
(`HARNESS_STATE_HOME`, `XDG_STATE_HOME` or `~/.local/state/devcontour-harness`).

### 6. Runtimes and approval

Edit `.harness/policy.json` only as the answers require:

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
- with the version pin committed inside the project: add `.harness-tools/` to
  `repositories[0].protectedPaths`, so no work order can change the tool it
  is checked by.

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

### 7. Task source

**Graph files.** Nothing more to configure; the `harness` skill plans the
first graph.

**Relay.** Write `.harness/connector.json` from `docs/connectors.md` of the
installed package ("Конфигурация"):

- `"version": 1` and `"provider": "relay-v1-http"` or `"relay-v2-cli"`,
  always explicit — never guessed from a binary named `relay`;
- `projectId` and `actor` at the top level; `repository.id` is the policy
  repository id (`app` after `init`);
- adapter settings nested under `relay`: v1 `relay.endpoint`; Relay-2
  absolute `relay.binary` and `relay.config`, `relay.project` for a workspace,
  `relay.env` that may set `RELAY_HOME` (and on macOS `DYLD_LIBRARY_PATH` to
  SQLite ≥ 3.44) but never `RELAY_CONFIG` or `RELAY_ACTOR`;
- `tasks[]`: `ref`; `role` and `gates` only from `data.facts` of `init`;
  `writeScope` (required) = the role's `writePaths` from the facts, or, when
  the role has none, `["."]` (the whole repository) or the narrower paths the
  user named; `criteria` mapped to a gate and a JUnit `testId`;
- `completion: { "mode": "review-only" }` (or `"complete"`) and
  `eligibility.columns` from the answers;
- no `stateDir` (pass `--state <manifest.paths.state>`), no secret values.

Checks that do not write to Relay:

```sh
$H source-check --source <repo>/.harness/connector.json --policy <repo>/.harness/policy.json --state <state>
$H source-snapshot --source <repo>/.harness/connector.json --policy <repo>/.harness/policy.json --state <state> --out <dir outside the repo>
```

`source-check` is read only. `source-snapshot` reads Relay but records the
snapshot in the connector state under `--state` and writes `graph.json`,
`context.json` and `manifest.json` to `--out`. `run --source`,
`source-deliver` and `source-reconcile` write to Relay: run them only after
the user says so.

### 8. Commit

With the user's yes: commit on the setup branch `.harness/.gitignore`,
`.harness/README.md`, `.harness/policy.json`, `.harness/connector.json` (when
present) and, for an npm source inside the project,
`.harness-tools/.gitignore`, `.harness-tools/package.json`,
`.harness-tools/package-lock.json`. Never `project.json`, `node_modules/` or
the state. Do not push or merge.

### 9. Report and hand over

Report: installed version (and the tarball sha256), `doctor`, the decisions
of the manifest (profile, writer, reviewer, state path), the policy edits,
the connector check, the commit SHA. Then continue with the `harness` skill:
brief → `plan-request` → draft → `plan-check` → `validate` → `run`. A live
`run` or `review-plan` calls paid models: start it when the user asks.

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

- Do not choose for the user: location, source, runtimes, models, the vendor
  rule, approval mode, task source and commits are their answers.
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
