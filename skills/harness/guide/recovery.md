<!-- harness guide recovery: When it stops: explain, diagnose, retries, holds and questions -->

### 8. When it stops

**Check `explain` before you retry.** Harness retries some failures itself:
a single timeout or stall (a second one in a row needs your diagnosis), and
a no-retry environment failure whose gate hold a fix has lifted. Then
`explain` (and `wait`'s `next`) says `actor: controller`, `action: retry`.
Do not run `retry --by lead` then: you would race the controller. Retry
yourself only when `explain` names you.

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

**The same defect twice in a row.** When two consecutive counted gate or
review failures have the same failure fingerprint or the same blocking
review finding, the
work is held for your diagnosis whatever `diagnoseAfter` says, harness does
not retry it on its own, and the diagnosis needs a `--hypothesis`. The next
attempt starts from a clean tree instead of continuing the failed patch, so
name what it does differently.

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
`other` with a hypothesis, or `environment` with evidence when every
diagnosed failure was classified as environment by harness) and you grant a
new attempt limit yourself:
`$H retry --state D --work <id> --reset --by lead --diagnosis <D…>`. You may
do this `recovery.leadResets` times per work budget (default 2), only after a
new failure and a new hypothesis, and only while the work budget is not
exhausted; status then reads «ведущий дал ещё N попыток (сброс K из M):
причина …; гипотеза …». If `explain` says `actor: user` — the cap is spent,
the cause is not technical, the diagnosis was already used, or the rule is
`user` — hand it to the human with the message and your diagnosis as
evidence. Never call `retry --reset` without `--by lead` yourself: that
records a human decision.

Attempts eaten by the environment (owner decision P8-4(b), alpha.71) are
yours too. Examples: a Docker pull EOF, a registry timeout, the uncounted
failure limit («исчерпан предел незасчитанных отказов»). Fix the
environment and prove it with `$H smoke --writer-probe` (or
`lifecyclePreflight`). Then diagnose `--cause environment --evidence "<what
passed after the failure>"` and reset with `--by lead --diagnosis <D…>`. Do
not ask the owner. It counts against `recovery.leadResets` like any lead
reset. A gate that is held for its own definition (`ps`, a signal, a browser
in the OS sandbox, `gate-definition`) is not this case: fix the gate.

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

**A gate tool is missing (`GATE_TOOL_MISSING`, cause `gate-definition`).**
The gate command could not find its program or browser. Examples:
`Command "playwright" not found`, `sh: vitest: not found`,
`Executable doesn't exist … playwright install`. Another case is pnpm
refusing its task state path. It is held only when this is the only failure
signal, a harness probe in the gate environment confirmed the tool is
absent, and the change touched no manifest, lockfile, file named in the gate
command, wrapper script or test config and added no call to that name. Then
the attempt is not counted, the writer is not retried, and the gate is held.
Install the tool or browser, or fix the gate command, then `$H retry --work
<id> --by lead`. Otherwise it stays a counted gate failure with the reason.

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
gate definition (or the sandbox becoming able to list processes) lifts the
hold by itself, and then harness retries the held work itself
(`work.retried`, `by: recovery`). After fixing the test instead, run
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
`answer-input`).** In light mode (the default) this is on unless the policy
says `inputPolicy.leadAnswers.technical: false`; in strict mode only when the
human opted in with `inputPolicy.leadAnswers.technical: true`
(`init --lead-technical-answers`). `doctor` and `init --plan` print the rule
in `questions.line`. It applies when the writer marked the question
`impact: technical` and it has no critical-path floor; a question with the
declared floor (severity 10 or a named area) is yours only when it names
areas and every one is in `technicalAreas` (light and thin default:
`internal`, a fork inside the code that changes no approved contract, public
API, data model or security, and `migration`, a data migration the writer
marked `impact: technical`). Questions about `contract` or `api` go to the owner unless the
owner listed them; a severity-10 question with no area goes to the owner. `explain` and
`status` then name you (`leadMay: technical`).
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
