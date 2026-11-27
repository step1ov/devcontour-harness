<!-- harness guide thin: Thin mode: one writer session per work, handover checked on a clean checkout, the whole flow for the lead -->

### Thin mode in one page

Thin mode (`harnessMode: thin`, alpha.73) uses the light environment (the
writer and gates run on the host with Docker, network, browser and ports,
with a write guard). The flow is thinner than light. The writer is treated
as honest but fallible. Quality comes from a clean-checkout check of the
order's gates and one independent review against the brief. The harness does
not try to prove that the writer could not cheat.

- One **work tree** per work (`worktrees/work-<id>`, branch
  `harness/work-<id>`) and one **writer session** per work. A rejected
  handover goes back into the same session (`codex exec resume` /
  `claude --resume`) with the reason, gate tails and open finding ids.
- A **handover** is one attempt. The harness commits the work tree, merges
  it into the current target on a fresh checkout, runs the order's gates
  there, then the consumers' checks and requirements, then one review of the
  whole merge against the target, then a CAS of the target. Ignored and
  untracked files (build output) never reach the check.
- The work tree is kept until the work is accepted or cancelled.
  Accepting it removes the tree, the branch and the sessions.

### Set up

1. `$H init --repository <repo> --harness-mode thin`. This writes
   `harnessMode: thin` and `review.passes: { code: off }` (thin has one review
   per handover).
2. `$H doctor --policy .harness/policy.json` names the mode. It warns
   `THIN_NO_RESUME` when the writer CLI cannot resume a session (then every
   handover is a new session with a summary of the tree; update the CLI). It
   warns `THIN_REVIEW_PASSES` when a second review pass is on.

### Plan: 3–5 works

`$H plan-request` asks for 3–5 tasks in thin mode. Each work is one coherent
user scenario through every layer it needs (API, UI, data, tests), together
with the test infrastructure it needs. Split only by repository or into parts
that are truly independent. Each work lists its exact gates, because the
writer runs exactly these commands and the harness reruns them. `plan-check`
returns `advice: THIN_PLAN_SIZE` when the plan has fewer than 3 or more than
5 works. This is advice, not a refusal. Plan review and approval work as in
`guide review`.

### Run and wait

Start the run detached so it outlives your turn:
`$H run --detach --log <file> --graph … --policy … --state … --author …`.
Then wait with `$H wait --state <state>` (a long timeout, not a `status`
loop). Under the lead driver (`HARNESS_LEAD_DRIVE=1`, `$H lead drive`, see
`guide run`), end your turn instead; the driver wakes you on events.

### What wakes you

- **The work ran out of handovers** (`maxAttempts`, default 3). A rejection
  does not stop the work: the same session gets it, even when it is the same
  failure as before. Thin has no "same defect twice" stop. After the last
  handover, diagnose the failure (`guide recovery`: explain, `diagnose`,
  `retry --by lead`). After a lead diagnosis, a recovery decision or a
  changed order, the next handover is a **new session** with a summary of
  the tree and your diagnosis. `retry --reset` (the way back after the
  handovers or the neutral limit run out) resets the budget and keeps the
  tree and the branch; the next handover is a new session with the summary.
  Only `retry --start-over` (implies the reset) starts the work over from the
  target: the tree, the branch and the session are discarded, once.
- **`gate-environment`** (needs-lead, not counted, no queue pause, no
  holds). A handover check failed on the environment twice: a gate failed
  with an environment class, a gate timed out with no failing test, or the
  environment setup failed. Each gets one automatic rerun. On a tree from
  earlier handovers a setup failure (a conflicted manifest, say) does not stop
  the handover: the writer gets its output and fixes the files. Read the gate
  output in the failure, fix the environment or the gate command, then run
  `retry --by lead`.
- **`merge-conflict`** (needs-lead, not counted). The first conflict at
  verification is retried without you: the harness merges the target into
  the work branch, and the writer resolves the conflicted files (it edits
  them only; the harness concludes the merge). You get it only when the
  conflict repeats: `retry --by lead` does the same again, or change the
  order of the works.
- **Questions** from the writer: technical ones are yours (`input-answer
--actor lead --reason …`), product ones go to the owner, as in
  `guide recovery`. A technical question rated 10 is still yours when every
  area it names is `internal` or `migration`; `contract`, `api`, `product`,
  `acceptance`, no area or a critical path go to the owner. Before answering
  a migration question, check it is additive or reversible: a migration that
  deletes, truncates or irreversibly rewrites user data, or has no rollback,
  is the owner's — do not answer it, pass it on. The answer reaches the same
  session.
- **Release ready**: all works accepted.

The target moving between the review and the CAS is not your event. The
check is redone once without the writer. If the target moves again, the
next handover re-checks the same candidate without the writer, and it is
not counted.

### Release

As in `guide release`: `$H review-release --state <state>` runs the full
gates on a clean checkout of the target head and the release review against
the brief, the owner's answers and the failure paths. The review lists every
blocker in one round and checks the documentation against the target
(blocking with `release.docs: required`, a note with the default `advisory`).
Findings become one fixes work that goes through the same thin flow. When
the release has a docs step, that fixes work updates the docs too and you
name it the docs work (`--docs-work <fix-id>`, the label alone is not
enough); no separate docs work for the roots of its repository. Then
`release done`.

### What thin mode does NOT have

- No candidate phase and no candidate→integration reuse (B2), no derived gate
  applicability (B1; explicit `when` still applies), no infrastructure holds
  of other works (C1), no fresh-tree rule (C3), no "same defect twice" stop.
  The writer's own runs inside its session are not attempts.
- No drafts and no draft continuation: the work tree itself carries the work
  between handovers.
- No second review pass on handovers (`review.passes.code: off`).
- No adversarial hardening against the writer. Use `harnessMode: strict` for
  untrusted code or production secrets (the owner's decision).

### Reading the state

`$H status` and `$H explain` read the same records as in light mode (phase
`integration`). In `$H view --work <id>` each attempt shows `writerSession`:
`fresh` (a new session), `resumed` (continued) or `fallback` (a new session
after context overflow or a lost session, in the same attempt, at most once).
The operator view names the mode `thin` (revision 11).
