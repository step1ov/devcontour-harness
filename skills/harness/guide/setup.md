<!-- harness guide setup: Install, check the machine, prepare the repository; policy, profiles and other inputs -->

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
