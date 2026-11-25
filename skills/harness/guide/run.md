<!-- harness guide run: Run the graph, wait for events, probe the writer, notes -->

### 7. Run

```sh
$H run --graph .harness/work/<graph-id>.json --policy .harness/policy.json \
  --state <manifest.paths.state> --author <claude|codex>
```

The state directory lives outside the repository; `run` creates it.

**Waiting for progress.** While `run` works (in the background or in another
process), do not loop `status`. Block on the next event that matters instead:

```sh
$H wait --state <manifest.paths.state> --policy .harness/policy.json \
  [--after <cursor from the previous wait>] [--until accepted,failed,held,question] [--timeout 30m]
```

It returns when a work is accepted, fails or is held, a writer asks a
question, the release is ready, or the queue stops (no controller, no
attempt and no `run` still starting: while `run` registers the graph, probes
and reviews the plan, its start marker keeps the queue live; a state
directory that does not exist yet is waited for). A failure that harness retries by itself is not reported. The
result names what happened, the next step from `explain` (`next.actor`,
`next.action`, `next.message`), a short status line and `cursor`. Act on
`next`, then wait again with `--after <cursor>`: events that arrived while
you acted (or in the same moment as the reported one) come next, none is
lost. The first `wait` without `--after` first reports what already waits
for you (a failure, a hold or a question nobody acted on). Exit codes: 0
accepted, 10 release-ready, 11 question, 12 held, 13 failed, 14 stopped, 15
timeout, 16 aborted (signal). They are outcomes, not errors (`ok: true`);
the JSON `kind` is authoritative. It reads the state read-only, does not
query the controller and keeps an open lead session alive while waiting.

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

### 11. Notes

No external note or chat service is called, and missing notes are normal. A
new note is a Markdown file in `.harness/work/context/notes/`, written with
your own tools. It enters a context snapshot only when the order lists
`"context": ["notes"]`; the snapshot pins its digest and refuses symlinks. Do
not copy acceptance logs or attempt state into notes.
