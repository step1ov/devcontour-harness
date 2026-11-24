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

## Mode: light by default, strict is the owner's decision

Since 0.1.0-alpha.69 a policy without `harnessMode` runs in **light mode**
(`<pkg>/docs/light-mode.md`): writers and gates run on the host like a
normal developer — Docker, network, browsers, ports and `ps` work — with
one guard: writes only into the attempt worktree, its temp dir and tool
caches (`writeGuard`). Attempts are separated by their worktree, their
`COMPOSE_PROJECT_NAME` and their own ports (`attemptEnv.ports`).

**Strict mode** (`harness init --harness-mode strict`, `"harnessMode":
"strict"`) is the old OS sandbox. It is frozen and may be removed after the
next pilots. Choosing it is the **owner's** decision: ask only when the
project runs untrusted code (a foreign fork, unreviewed generated
dependencies) or the machine holds production secrets the writer must not
read. Never switch the mode yourself; `doctor` prints the current mode as
its first note.

In light mode:

- declare the ports the project's services need in `attemptEnv.ports` and
  make the compose file and gates read them (`"${API_PORT}:3000"`);
- when production routes through a gateway (Caddy, nginx), run gates
  through the project's gateway service (`repositories[].gateway`) and
  declare the production routing files in `release.topology`
  (`<pkg>/docs/release-review.md`);
- browser checks run as ordinary gates (`ui: {type: "browser"}`,
  `<pkg>/docs/ui-gates.md`); no external browser controller is needed;
- infra tasks, `infra.paths` and `gateChanges` (below) are **not
  required**, and there is no separate infra phase: acceptance tests,
  fixtures and compose test services live with the product code inside
  product works and are reviewed as code. **Don't split test
  infrastructure into a separate stage.** Use the harness helpers instead:
  per-attempt services (`COMPOSE_PROJECT_NAME`, `attemptEnv.ports`, the
  `attempt-env.json` file named by `HARNESS_ATTEMPT_ENV_FILE`), the
  `browser` (Playwright) gate, the gateway-mirror check
  (`GATEWAY_MIRROR_MISSING`). Open an infra work only for a shared thing
  several works need (for example a new compose service), reviewed like
  code. Infra works stay available when the owner wants that boundary;
- acceptance tests assert what a user or client sees — status codes, text,
  roles, links, API payloads — and never hashed CSS Module class names
  (`module__<hash>`) or the framework's RSC payload (`__next_f`): those
  change with every build and make the test fail on correct code;
- browser gates standardise on Playwright Test with its bundled headless
  Chromium (`ui: {type: "browser"}`); agent-browser is an exploration tool
  for agents, not a gate runner. Mobile gates (Maestro) are a contract in
  this version (`<pkg>/docs/ui-gates.md`);
- **pre-warm tools during setup** so gates run offline and fast: install the
  pinned Playwright browser (`pnpm exec playwright install chromium`), pull
  or build the compose images (`docker compose pull`/`build`), fill the
  dependency store (`smoke`); report sizes and times in the setup report;
- in the project's compose files: publish ports from `attemptEnv` variables
  (or `127.0.0.1::<port>`), give every service a real healthcheck, and guard
  a RabbitMQ `rabbitmq-diagnostics` healthcheck on the Erlang cookie file
  (`test -s /var/lib/rabbitmq/.erlang.cookie && rabbitmq-diagnostics -q
ping`) — parallel attempt stacks race without it (`doctor` notes
  `compose-rabbitmq-cookie`); teardown is `docker compose down -v
--remove-orphans`.

## Setup is configuration

Setup is configuration only: the stack profile, `harness init`, policy edits
the decisions require, the task-source connector, `doctor`, `smoke` (and
the writer probe), gates on `HEAD`. Copying the example bridge files and
setting their parameters for the project is configuration too. You do not
write new executable code during setup:

- a bridge, gate wrapper, validator, crash-cleanup test or any other script
  that does not exist yet becomes a task of the first plan — an ordinary
  product task in light mode, an **infra task** in strict mode
  (`"kind": "infra"`, `<pkg>/docs/infra-works.md`): a writer builds it
  through the normal loop with review-code, attempts and the forecast;
- inherited setup debts (a known bridge defect, a missing acceptance test)
  are listed as infra tasks too, not fixed silently by you;
- keep each infra task to one deliverable with its own check (a bridge, a
  wrapper, a fixture set, one smoke): a task that lists many independent
  deliverables does not fit one attempt and ends `unfinished`; after two
  `unfinished` attempts split it (`diagnose --cause split`) rather than
  retrying the same order;
- a compose file whose services publish ports while attached only to
  `internal: true` networks is reported by `doctor`
  (`compose-internal-ports`): Docker does not publish those ports — fix the
  compose model before `smoke`;
- declare where infra code lives: `repositories[0].infra.paths` (for
  example `.harness/acceptance/`, `.harness/infra/`), inside
  `protectedPaths`; files that `lifecycle` or `prepare` steps run stay
  outside it.

**Setup budget: about 30 minutes.** Setup time counts from this setup's
first record (the manifest `init` writes for this directory, the first
`smoke` or `gates` of this state) to the first registered graph; files
inherited from an earlier project do not start the clock. Over the budget, `doctor`
prints `SETUP_OVER_BUDGET: …` and `status`/`harness view` show the setup
progress line with «бюджет 30 мин — превышен»: stop adding code, write down
what is left as infra tasks and hand over to planning. `harness view`
(`stage.progress`) shows each setup step (profile, init, doctor, smoke,
probe, gates, connector) with its state and time from the records harness
keeps.

## Decide or ask

Decide everything you can from the repository and the defaults below, and
report each decision with its reason at the end; the user overrides any of
them by saying so. Ask only at a fork — a choice that changes who is trusted,
what leaves the machine, what is spent or which project rule gives way — and
ask all open forks of a step in one round (multiple choice where the host
supports it).

| Choice                     | Default (decide yourself)                                                                                     | Ask when                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lead                       | you: `--lead claude` or `--lead codex` (the runtime of this session)                                          | —                                                                                                                                                     |
| Writer vendor              | the lead (`--writer` only when the user wants another writer)                                                 | the user named a different writer                                                                                                                     |
| Review vendor              | `--review auto`: the other vendor unless only the lead's own CLI is usable                                    | `auto` fell back to the same runtime (`review-same-vendor` warning): tell the user, and use `--review same` only with their yes                       |
| Models and effort          | runtime defaults; one model for every binding — `--model` with `--review same`                                | the user named models                                                                                                                                 |
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
| Harness mode               | light (no `harnessMode` field)                                                                                | untrusted code or production secrets on the machine: strict is the owner's decision                                                                   |
| Write guard / OS isolation | on (light: write guard; strict: OS sandbox)                                                                   | a tool writes to a cache outside the defaults (`writeGuard.add`), or, in strict mode, prepare or gates fail inside the sandbox                        |
| Docker environment         | none                                                                                                          | gates need a database or other service                                                                                                                |
| Project rule conflicts     | —                                                                                                             | a project rule forbids what setup creates (for example new `.md` files: `.harness/README.md`)                                                         |
| Commit, Relay writes, runs | —                                                                                                             | always confirm: committing the setup, `run --source` / `source-deliver` / `source-reconcile`, any live `run` or `review-plan`                         |
| Update mode                | ask once: `auto` (recommended for a non-technical operator), `notify` (default) or `off` (step 10a)           | never change it later unasked                                                                                                                         |

## Install

### 1. Preconditions

Node.js ≥ 24.3, `git`, `npm` (or `pnpm` for a pnpm project) and the runtime
CLIs (`claude --version`, `codex --version`). `init` checks sign-in locally
without a model call (`claude auth status`, `codex login status`) and reports
it in `data.runtimes`; an unknown answer is not a confirmation. A missing or
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
$H init --repository <repo> --lead <claude|codex> --plan
$H init --repository <repo> --lead <claude|codex>
```

Add `--profile ./.harness/profile.json` with a local profile, `--writer`
for a writer other than the lead, `--review cross|same` to override `auto`,
and `--model <model>` (with `--review same`) to pin one model. Read
`data.lead`, `data.review` and `data.warnings`: `review-same-vendor` and
`runtime-missing` go to the user before the first run. The first call
writes nothing: read `data.files`, `data.conflicts`,
`data.toolchain.problems`, `data.facts` and `data.manifest.paths.state`, and
resolve every conflict or problem with the table of the `harness` skill
(step 3) before the second call. `init` is create-only: `.harness/.gitignore`,
`.harness/README.md`, `.harness/project.json` (local, not under Git) and
`.harness/policy.json`. The state lives outside the repository
(`HARNESS_STATE_HOME`, `XDG_STATE_HOME` or `~/.local/state/devcontour-harness`).

**Toolchain pin.** `init` proposes `toolchain.node` in the policy: the Node
version that runs `init` (or the exact version of `.nvmrc`, `.node-version`
or `engines.node` when it is installed). Harness prepends that Node to `PATH`
for every stage — gates, `gates`, `smoke`, prepare, writer and reviewers — so
the result does not depend on whose shell starts harness (a login shell that
reloads a version manager can put another Node first). Keep the pin; when
`doctor` warns that the Node on `PATH` differs from the pin, report it and fix
the shell or the pin, never the gate commands. Do not wrap gate commands in
compatibility shims for a wrong Node.

On a weak machine (`doctor --policy` reports `LOW_RESOURCES`: at most 4
performance cores or less than 16 GB of RAM) add `--lean` to a new
project's `init`. For an already prepared project, or when attempts hit their
time limits, switch the layer instead of editing the policy by hand:

```sh
$H lean --repository <repo> --plan
$H lean --repository <repo>
```

Show `data.changes` and `data.notes` before applying, and tell the user the
policy digest changes: graphs in `data.staleApprovals` need `review-plan`
again. `$H lean --repository <repo> --off` restores the recorded values.

### 8. Runtimes, approval, isolation

Edit `.harness/policy.json` only as the decisions require:

- models: `init --model` with `--review same`, or `model` on
  `roles.<role>.writer` and on `review.code.reviewer`,
  `review.plan.reviewer`, `review.contract.reviewer`;
- effort: `effort` (`low`, `medium`, `high`, `xhigh`) only on bindings whose
  `runtime` is `codex`; on any other runtime it is refused;
- a reviewer of the author's vendor (an explicit yes only): prefer a new
  `init --review same` decision; editing by hand, set `reviewer.runtime` to
  the author's runtime and add `"vendor": "same-vendor-allowed"` on the
  rule. `init --plan` reports `content-differs` on `policy.json` only when
  the policy assigns no allowed reviewer for the lead's plans and contracts
  or the writer's code;
- operator approval: top-level `"approvalMode": "operator"`;
- isolation: keep `isolation.mode: os`. When `doctor` or a first `prepare`
  shows the sandbox blocking the package store, the network or the Docker
  socket, show the diagnosis and ask between `isolation.domains` and
  `isolation.mode: none`;
- with the version pin committed inside the project: `.harness-tools/` in
  `repositories[0].protectedPaths` (already there when the local profile
  lists it).

Never remove or weaken anything `init` wrote. Keep the writer runtime as
`init` wrote it: a different lead or writer vendor is a new `init --lead` /
`--writer` decision.

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
`node .harness/compose-bridge.mjs exec -- <command>`. Changes to the bridge
beyond its parameters (a validator, a wrapper, a crash-cleanup test) are
infra tasks of the plan, not setup work.

Old smoke records that stay `cleanup-failed` although their worktree and
Docker resources are gone are reconciled by
`$H cleanup --state <state> --run <LS-…>` (it never deletes anything; with
resources left it names them). Never edit their state by hand.

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

### Heavy commands run one at a time

`smoke`, `smoke --writer-probe`, `gates` and `run` install dependencies and
start servers: run them **sequentially**, never in parallel (in one shell or
in background jobs). Parallel runs compete for the same store, ports and CPU,
and their failures say nothing about the project.

### Dependency cache

Right after `init` run `$H smoke --state <manifest.paths.state> --policy .harness/policy.json --sha HEAD --human` and read the prepare time and the
dependency-store advice. Prepare longer than a minute → enable
`dependencyStore` through `$H lean --repository <repo> --plan`. A package manager version the store does
not support → report it to the operator as a harness finding; do not build a
cache of your own into step or gate arguments (no store or cache directory
inside the attempt worktree, no absolute shared paths). Do not start a paid
`run` until prepare fits a reasonable time.

### Writer probe

Read the product AGENTS.md files and skills for commands the writer must run:
generators (`pnpm dlx …`, `pnpm run create`), local servers and browser checks
(`agent-browser`, Playwright), tools that keep state in the home directory,
reads from a tracker. Propose each as `repositories[].writerProbe`
(`{ "id", "command": [argv], "timeoutMs" }`; a command that can run quickly,
for example `--help` of the generator or a server start that exits) and run
`$H smoke --state <manifest.paths.state> --policy .harness/policy.json --sha HEAD --writer-probe --human` before the first paid attempt.
Never debug these conflicts through paid attempts. Two results are not
forks — decide them yourself and report them:

- **Local server or port** (`listen-denied`, or EPERM without a path from a
  Rust bundler): the probe re-runs the steps under `network: loopback`
  itself (127.0.0.1/::1 only, no internet). When `writers[].loopback.status`
  is `resolves`, run the one command it prints (`data.writerProbe.loopbackCommand`,
  `… --writer-probe --apply-loopback`) without asking: it writes
  `"network": "loopback"` into the writer's tool profile, records the reason
  (`loopbackApplied`) and re-probes. It is a technical lead decision; internet,
  write areas and OS isolation stay as they are. Report it in the setup
  summary. `not-enough` or `unavailable` — treat those steps as blocked
  (below).
- **Browser checks** (`agent-browser`, headless Chrome, Playwright with a
  browser, `verify:browser`): status `outside`, and `doctor` lists them in
  `notes` as `browser-checks`. The writer's sandbox does not start a browser;
  this is expected and needs no decision. Make such a check a harness gate
  only if it passes on HEAD under harness (`$H gates --state <manifest.paths.state> --policy .harness/policy.json --sha HEAD`); otherwise
  leave it to the human. Tell the user in one plain line.

For every remaining `blocked` command (internet, writes outside the write
areas, missing tools) give the user the advice and the choice: run it in
`prepare`, move it into a harness gate, allow it in the policy, or waive the
product rule under the harness (controller-mode overlay). Do not open the
writer's internet or switch OS isolation off to make the probe green.

### Previews

If the product is something a person looks at (a site, an admin, an API with
pages), describe how to run it as `repositories[].previews` in
`.harness/policy.json` (or `previews` of a local profile), from the
project's own commands — never invent scripts. Read `package.json` scripts
and the product README: `build` holds install and build steps
(`{ "id", "command": [argv], "timeoutMs" }`, for example `npm ci` and
`npm run build`), `start` the long-running command (`npm run start`,
`npm run preview`), `health` a path that answers below 400 when the app is
up (`/`, `/health`), `env` the values the app needs. The port is not fixed:
the app gets it as `PORT` and `{port}`, the host as `HOST=127.0.0.1` and
`{host}`; pass them on the command line if the script ignores `PORT`
(`["npm", "run", "start", "--", "--port", "{port}", "--host", "{host}"]`).
Set `"services": true` only when the app needs the repository lifecycle
(the database that `lifecycle.setup` starts). Check it once on HEAD:
`$H preview-start --state <manifest.paths.state> --policy .harness/policy.json --ref HEAD --ttl 5m`
must return a `url` that opens, then `$H preview-stop --state <manifest.paths.state>`.
Previews do not change the execution digest and need no plan re-review. See
`<pkg>/docs/previews.md`.

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

The overlay (v2) also tells the writer to implement first when the sandbox
blocks a mandated step, run what it can, and then ask a technical question
naming the blocked step instead of stopping before coding.

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
  to a gate and a JUnit `testId` spelled exactly as the report spells it —
  `classname.name` (node:test writes `classname="test"`, so the test
  `orders.api.access` is `test.orders.api.access`; open a JUnit file the gate
  wrote to check), or `"evidence": "gate"` when the passed gate itself is the
  proof; a document the task cannot be done without goes into
  `requiredDocuments` (only those make the statement: an edit of any other
  linked document does not reopen accepted work); `"context": ["controller-mode"]` with
  controller mode (step 9) — the pack is read from `contextDir`, by default
  `work/context` next to `connector.json`;
- `completion: { "mode": "review-only" }` unless the user chose `complete`;
  `eligibility.columns` from the project's board; `history.enabled: true`;
- no `stateDir` (pass `--state <manifest.paths.state>`), no secret values;
- `tasks` may stay empty while the board has no tasks yet: `source-check`
  then verifies the connection and warns; add tasks before the snapshot.

The connector puts the full task context (FI/SI, their features and
scenarios, application, product passport, documents) into the writer's pack.
Any unmodified Relay 0.13.x is enough: the connector builds the context from
the ordinary Relay routes (a server that declares `relay-task-context-v1` is
read with one call); no Relay build with harness changes is needed. In the
product's AGENTS.md rule "read the task in Relay", the pack replaces the read.

Checks that do not write to Relay:

```sh
$H source-check --source <repo>/.harness/connector.json --policy <repo>/.harness/policy.json --state <state>
$H source-snapshot --source <repo>/.harness/connector.json --policy <repo>/.harness/policy.json --state <state> --out <dir outside the repo>
$H validate --graph <dir outside the repo>/graph.json --policy <repo>/.harness/policy.json --context <dir outside the repo>/context.json
```

`source-check` also checks every criterion binding: a gate outside the
policy or the task's gates, `evidence: test` on a gate without JUnit, and a
`testId` missing from the gate's reports while `<classname>.<testId>` is
there are problems (`run --source` refuses them before any attempt); a
binding edit needs no new plan.

`source-check` is read only. `source-snapshot` reads Relay but records the
snapshot in the connector state under `--state` and writes `graph.json`,
`context.json` and `manifest.json` to `--out`; its output names the pinned
local packs (`localContext`) and a context over the limits as
`LIMIT_EXCEEDED`. `run --source`,
`source-deliver` and `source-reconcile` write to Relay: run them only after
the user says so.

### 10a. Updates

Ask once, in the first round of questions, how updates of harness and the
operator UI package should arrive (multiple choice):

- **auto** (recommend it for managers and other non-technical operators):
  installed by itself once a day, only when nothing runs, with a state copy,
  a check of the new version and an automatic return on failure; a version
  that changes data formats is never installed by itself — it becomes a
  decision for the owner;
- **notify** (the default): only a line in the operator UI, `status --human` and
  from the lead at the start of a session;
- **off**: nothing is checked.

Write the answer and, for `auto` (or `notify` when the user wants the daily
check without a session), the daily job:

```sh
$H update --mode <auto|notify|off> --state <paths.state>
$H update --schedule daily --state <paths.state>   # macOS launchd; Linux prints systemd/cron text
$H update --check --state <paths.state>
```

`.harness/updates.json` is committed with the setup (step 11). The only
network call is the npm registry query of `harness update`, through npm and
its configuration, without telemetry.

### 11. Commit

With the user's yes: commit on the setup branch `.harness/.gitignore`,
`.harness/README.md`, `.harness/policy.json`, `.harness/profile.json`,
`.harness/connector.json`, `.harness/updates.json`, `.harness/acceptance/` and the bridge files when
present, and, for an npm source inside the project,
`.harness-tools/.gitignore`, `.harness-tools/package.json`,
`.harness-tools/package-lock.json`. Never `project.json`, `node_modules/` or
the state or the controller-mode pack. Do not push or merge.

### 12. Report and hand over

Report: installed version (and the tarball sha256), `doctor`, every decision
of the table with its reason, the gates with their commands, the policy
edits, controller mode, the connector check and snapshot (`graphId`,
`graphDigest`, eligibility per task), the commit SHA, the setup time against
the budget, and the infra tasks for the first plan (new code and inherited
debts, each with its paths and the gate files it would change). Then continue with the
`harness` skill: release outline (`lead outline`: infra, product and deploy
stages with rough sizes) → brief → `plan-request` → draft → `plan-check` → `validate`
→ `run` (for Relay: `review-plan` and `run --source`). A live `run` or
`review-plan` calls paid models: start it when the user asks.

Links in the report point to what stays up after you leave: the site or
dashboard the user runs (ask for its address when unknown). Never link a
temporary port of a server you started yourself and stop at the end of the
session.

## Upgrade

From 0.1.0-alpha.60 the routine upgrade is one command:
`$H update --check --state <state>` shows the pair, what is new and whether formats change;
`$H update --apply --state <state> --wait 30` installs it when nothing runs
(state copy, exact versions in the same `<tooldir>`, `doctor`, automatic
return on failure); `$H update --rollback --state <state>` goes back. Use
the manual steps below for a format change the owner approved, for a
tarball source, or when `update` refuses.

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
