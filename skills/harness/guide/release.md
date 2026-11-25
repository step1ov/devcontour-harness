<!-- harness guide release: Report the result, release review and release done -->

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

### Lead log: release review and release done

The lead session rules (`lead begin`, roles of your commands, notes) are in
`$H guide session`.

- When all code is accepted, run the **release acceptance review**
  (`<pkg>/docs/release-review.md`):
  `$H review-release --state <state>`. The release base is recorded at the
  first graph registration of the release or at `lead outline` (see
  `status` → `releaseReview.base`); pass `--base` only to override it. An independent
  reviewer checks the accepted target against the brief, acceptance criteria,
  owner answers and the deploy topology (`release.topology`: gateway/proxy
  configs, production env files). Blocking findings are fixed by works (plan
  them like any task), then run `review-release` again on the new target.
  If `review-release` prints `BRIEF_MISSING`, the release has no brief.
  There is no `.harness/work/<graph-id>.brief.md` next to a registered
  graph, and no brief document (a required task-source document, or one
  named as the brief or requirements) in the pinned context. Pin the brief
  document to the task, or write the `.brief.md` and register the graph
  again, then rerun the review.
  Before the review, `review-release` needs a full `harness gates` run on
  the target: all gates, with no skips and no carry-over (alpha.71). If there
  is none, it ran on another target, or a gate definition changed since,
  `review-release` runs it itself and refuses when a gate fails. Fix the
  failure with a work. `release done` refuses without a passing full run.
  `release done` refuses in both modes until the latest round on the current
  target is approved without blocking findings (only an explicit
  `release.review: advisory` makes it a warning); open non-blocking notes do
  not hold the release — mention them in the report.
- When all code is accepted, delivered and checked, write the final report:
  `$H release done --state <state> --summary "<what was done, what is left>"`.
  Until then the view says «код принят, ведущий ещё работает: <your last
  note>» and progress stays below 100 %; it refuses while a work or rework is
  still open.
