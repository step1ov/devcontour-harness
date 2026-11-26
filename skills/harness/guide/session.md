<!-- harness guide session: Read first in every session: lead begin, who your commands speak for, notes, release outline, resuming -->

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
  your open session `retry` needs an explicit role: `--by lead` for your own
  decision (with the recovery limits) or `--by operator` for a human's
  decision you pass on; without `--by` it is refused (`INVALID_INPUT`).
  `input-answer` without `--actor` is always the operator's, also inside your
  session: an owner's answer you pass on stays the owner's. Your own
  technical answer needs `--actor lead --reason "…"`.
- **Declare the whole release first** — before the first graph, record the
  release outline: stages × components with a rough size and who does them,
  not only the next graph:
  `$H lead outline --state <state> --file outline.json` (before the first
  `run` the state directory is not bound yet: add `--policy <policy>` once —
  it binds and creates the state like `run` does) with
  `{"stages":[{"id":"infra","title":"Инфраструктура","kind":"infra","components":[{"id":"api-infra","title":"API: сборка и gates","size":"S","actor":"writers"}]},{"id":"product","title":"Продукт","kind":"product","components":[{"id":"site","title":"Сайт","size":"M","actor":"writers","works":["site-form"]}]},{"id":"deploy","title":"Выкладка","kind":"deploy","components":[{"id":"staging","title":"Стенд","size":"S","actor":"owner"}]}]}`
  (`kind`: infra | product | deploy | other; `size`: S = 1, M = 1–2, L = 2–3 tasks,
  counted as 1, 2 and 3 in the forecast,
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
- Waiting for a running `harness run`: `$H guide run` («Waiting costs model
  tokens»). With `HARNESS_LEAD_DRIVE=1` in your environment a driver waits
  for you: handle the event in your input, keep `harness run` going in the
  background, then end your turn with a short summary — no `wait` loop, and
  no `lead end` until the release is done or you stop for the owner.
- When you stop: `$H lead end --state <state>`. If approved works are ready
  and nothing runs, it still ends the session but warns
  `READY_WORKS_NOT_RUNNING` (`data.readyNotRunning`): start `$H run` first.
- Release review and the final report: `$H guide release`.

### 10. New session

Nothing is asked again:

0. `$H lead begin --state <paths.state>` first (see «Lead log» above): your
   commands are logged and `retry` needs `--by` from now on.
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
