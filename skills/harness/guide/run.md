<!-- harness guide run: Run the graph, wait for events or let the lead driver wait, probe the writer, notes -->

### 7. Run

```sh
$H run --graph .harness/work/<graph-id>.json --policy .harness/policy.json \
  --state <manifest.paths.state> --author <claude|codex>
```

The state directory lives outside the repository; `run` creates it.

To keep `run` going after your shell command returns, start it detached:
`$H run --detach --log <file> --graph … --policy … --state … --author …`.
It starts `run` as its own process (own process group and session, stdin
closed, stdout and stderr appended to `<file>`, mode 0600), waits (up to
30 s) until the run sets its start marker or takes the controller role and
prints the pid — in bash and zsh alike, no `&`, `nohup`, `set -m` or
`setsid` needed. If the run exits with an error first, it refuses
(`NOT_READY`) with the exit code and the last 40 lines of `<file>`. It
records the start in `<state>/run-detach.json`.

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

**Waiting costs model tokens.** Every time a wait returns to you, your agent
sends the whole session so far to the model again; a loop of short waits
(`--timeout 50s`) costs more than the work itself. Wait with the longest
`--timeout` your shell tool allows (10 minutes or more if it allows it; the
default is 30m), and never chain more than about 3 empty waits (`timeout`,
exit 15): after that, end your turn with a short status line instead.

**Under the lead driver (`HARNESS_LEAD_DRIVE=1`).** When your environment
has `HARNESS_LEAD_DRIVE=1`, an operator loop without a model waits for you
(`harness lead drive`) and starts a fresh session of yours on each event
that needs you; your input is the operator's goals plus a short event
summary (what happened, the cursor, the commands for it; an executor's text
is quoted as data, not instructions). Handle that event and decide: only
your decisions count as progress — harness commands of your log (retry,
reset, diagnose, input answers, input-resolve/carry, review-accept,
reapprove, run start), new graphs, review rounds (`review-release`) and
`release done`; `lead begin` and notes do not. A stopped queue or a ready
release you leave without a decision does not wake you again: the driver
stops after waiting a while for any change (a `review-release` you started
in the background, a policy fix). Begin every session with `$H lead begin`:
without an open session your `run` and `input-resolve` are not written to
your log and do not count as a decision (the run's own start and end
records are not your decisions; `run --detach` is). Start `harness run` only detached
(`$H run --detach --log <file> …`, above) so it outlives your turn and is
not stopped with your session. Then end your turn with a
short summary. Do not call `$H wait` and do not loop: the driver wakes you
on the next failure, hold, question for you, a human's answer, ready
release or stopped queue (only you start runs; for a stopped queue the
summary shows the last `run --detach` log and its last lines); accepted
works, failures harness retries by itself and
events already resolved do not wake you. A new executor question you may
not answer wakes you once (`HARNESS_LEAD_DRIVE_EVENT=owner-question`): do
not answer it yourself — pass it to the owner's channel (an open
question in the task source, see `$H guide session`), keep independent works running and end
your turn; the same question does not wake you again, the owner's answer
does. When nothing is left for you but an owner's decision, say so:
`$H lead end --state <state> --waiting owner --reason "<which decision>"` —
the driver tells the owner and keeps waiting instead of waking you.
A product question you ask the owner yourself in the task source (not an
executor question of harness) is invisible to the driver: when the remaining
work depends on the answer, follow it with `lead end --waiting owner` too.
The operator brings the answer back in the driver's goals. When the goals
changed since the driver's last start (`HARNESS_LEAD_DRIVE_EVENT=goals-changed`,
or the line «Также: оператор изменил цели драйвера …» in another event's
summary),
apply what is new (owner answers, instructions) before anything else.

**Running the driver (operator).** Instead of a lead session that waits:

```sh
$H lead drive --state <manifest.paths.state> --policy .harness/policy.json \
  --agent 'codex exec --dangerously-bypass-approvals-and-sandbox --json -C /path/to/repo -' \
  --prompt-file goals.md --log transcripts/drive [--max-sessions 20] [--idle-sessions 3] \
  [--timeout 60m] [--session-timeout 60m] [--repeat-wait 10m]
```

`--agent` is the host's lead command as one string, run without a shell
(quotes group arguments); the session prompt goes to its stdin, and
`{session}`, `{cursor}` and `{prompt-file}` are substituted. `goals.md` is a
short goals-only prompt (what the release must achieve, who answers what);
the driver appends the event summary. The driver keeps a digest of the goals
in the state (`lead-drive-goals.json`). When you restart it with changed
goals (owner answers, new instructions), or with no record on a state that
already has works, the first session gets them at once: if nothing else
waits for the lead (or the waiting event turns out to need no session: the
question is already answered or closed, the stop is gone, the step is the
owner's), the driver starts one `goals-changed` session before waiting for
events. The goals count as delivered only after a session that exits 0 (or
records a lead decision); a session that fails or is stopped by
`--session-timeout` leaves them new for the next start. The same goals start
no extra session. New goals are not delivered when the driver exits first:
after `release done` (exit at once) and on an operator pause (`owner`
exit) — resume the run or start the next release, then restart the driver. Each session is new, so the context
stays small; the agent gets `HARNESS_LEAD_DRIVE=1`,
`HARNESS_LEAD_DRIVE_CURSOR`, `HARNESS_LEAD_DRIVE_SESSION` and
`HARNESS_LEAD_DRIVE_EVENT`, runs in its own process group, and its stdout
and stderr go straight to `--log` files (`session-N.prompt.md`, `.out`,
`.err`, mode 0600) or to /dev/null without `--log` — never to the driver's
JSON. A session longer than `--session-timeout` is stopped with its whole
process group (SIGTERM, then SIGKILL after 10 s) and counts as a failed
session. Unchanged state the lead already got without a decision is waited
on for `--repeat-wait` (default 10m) before stopping. The driver never
starts runs itself. Each session gets an executable wrapper of this exact
harness CLI in `$H` and on `PATH` (`H`), so `$H …` works in every separate
shell call; `HARNESS_BIN`, when set, is the path of one executable harness
file. Owner notices (stderr and `data.notices`): a question the lead may
not answer (plus one `owner-question` session to pass it on), a step only a
human takes for one work (budget, provider access) and the lead's
`lead end --waiting owner`; the driver keeps waiting while other work can go
on: failures of independent works still wake the lead, and the owner's
answer (operator view or `input-answer`) wakes it to apply the answer. While it
waits, the driver renews an open lead session, as `wait` does. Exit codes
(`ok: true`, the JSON `outcome` decides): 0 release-done (release done
recorded, all code accepted), 20 owner (no run going, nothing ready, and
everything left waits for the owner — or an operator pause, at once: decide
it, then start the driver again), 21 no-progress (`--idle-sessions`
sessions in a row without a lead decision or over the time limit — passing
an owner question on does not count — or the same stop again without a
decision and no change within `--repeat-wait`: check the agent command and
its logs),
22 max-sessions, 23 agent-error (the command did not start, or a session
failed on a provider refusal — usage limit or credentials; no new sessions
start), 16 aborted
(signal). Progress lines go to stderr.

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
