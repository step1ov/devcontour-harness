<!-- harness guide review: Plan review and approval; independent review of code written outside the harness -->

### 6. Review and approve the plan

With `approvalMode: agent` (the generated default) `run` performs the plan
review under the reviewer rule and approves it.
`$H review-plan --state … --graph … --policy … --author <your runtime>` shows
the findings in advance. With `approvalMode: operator` a human approves with
`$H approve`.

**After a policy change.** An approval belongs to the policy it was made
under: after you edit `.harness/policy.json` (or `lean` changes it) the graph
is `APPROVAL_STALE`, and `review-plan` holds a new round instead of returning
the stored one. When the change does not touch the execution boundary (list
below) — for example a gate timeout — and the last round approved, re-approve
through the CLI with an audit record:
`$H reapprove --state … --policy .harness/policy.json --subject <graph-id> --digest <graph digest> --by "<who>" --reason "<what changed and why the last review still covers it>"`.
A change to isolation, network, tool profiles (or which profile a role or
reviewer uses), the policy `environment`, `protectedPaths`, host steps
(`lifecycle`, `prepare`, `dependencyBuild`, `preflight`), `mode` or
`approvalMode` always
needs a fresh `review-plan` — `reapprove` and `approve` refuse it
(`APPROVAL_REQUIRED`). In operator mode `approve` of an already approved graph
after a policy edit also points to `reapprove`.
Never call library internals (`Engine.approve`, store writes) to approve.

**Which rounds count.** Only a real plan change spends a round: an order
added, removed, or changed in text, criteria, dependencies, write scope,
kind, repository or required context. Reworks of accepted works, your
diagnoses and addenda, owner answers and other context, source revisions,
policy and reviewer changes are free, for plan and contract reviews alike.
In light mode there is no round limit (plan or contract)
at all — the budget is release time and cost (`budgets.group` /
`budgets.total`; `doctor` warns `light-no-budget` without one), and raising
it stays the owner's decision.

**Review rounds that go in circles.** Each plan or contract review round is a
paid call; `status` / `explain` `data.reviews[].line` shows the verdict, rounds
used of the cap and the review spend (in Russian: «одобрено, открытых заметок
2; раундов 3/6; ревью $0.75»). Approval may leave open notes: say so to the
user instead of reporting a clean approval. A finding the reviewer raises
again in other words keeps its ID (`sameAs`, or the same path and rule), so
`rounds` counts how long it has stayed open.

- If a finding is a known limitation you accept, record it in the next round:
  `$H review-plan … --accept-limitation <id> --reason "<why>"`. The reviewer
  sees the reason and does not re-raise it without new evidence. This is not
  an approval; never use it to silence a defect you can fix.
- A blocking finding open for 3 rounds stops the next round before the call
  (`INPUT_REQUIRED`, `data.reviews[].escalation`): give the user the question
  and its options, then record their answer with `--actor operator`
  (`--accept-limitation <id> --reason …`, or `--continue-review <id> --reason …`
  for three more rounds). Do not answer it yourself.

### Review of code written outside the harness

**Code written outside the harness.** When you (or the user) already wrote
the code on a branch — a hotfix, a change made before the harness was set up,
commits added after acceptance — get an independent technical review of
exactly that diff instead of reviewing it yourself:

```sh
$H gates --state <manifest.paths.state> --policy .harness/policy.json --sha <head>   # optional, first
$H review-code --state <manifest.paths.state> --policy .harness/policy.json \
  --base <main> --head <branch> [--role <role>] [--author <who wrote it>]
```

The reviewer is chosen by the role's code review rule against the author's
vendor (`--author` defaults to the role's writer; name yourself when you wrote
the code): another vendor, or the same one only with `same-vendor-allowed`
(`REVIEWER_SAME_VENDOR` otherwise, before any model call; tell the user when
`sameVendor` is true). It reads the diff `merge-base(base, head)..head` in a
read-only checkout of `head`; a `gates --sha` result for that `head` is
attached as `gates`. Exit 0 — approved, 3 — blocking findings; fix them on the
branch and repeat with the same `--base`/`--head`: the reviewer must state
each previous finding. The record says `acceptance: false`: an approved
`review-code` is a review, not acceptance — say so to the user, and use
`run` when the work must be accepted.

Run the heavy commands — `smoke`, `smoke --writer-probe`, `gates`, `run` —
**one at a time**, never in parallel or as concurrent background jobs: they
share the dependency store, ports and CPU, and a parallel run fails for
reasons that are not in the project.

When the project has `lifecycle`, `prepare` or a dependency store, check the
environment alone first — never debug lifecycle or seed through paid attempts:

```sh
$H smoke --state <manifest.paths.state> --policy .harness/policy.json --sha HEAD --human
```

It brings up only the environment (lifecycle, store, prepare, teardown) with
no gates and no model call and times each step. Exit 4 (`LIFECYCLE_FAILED`)
names `failure.class` (`port-busy`, `timeout`, `crash`, `missing-tool`,
`cleanup`, `tree-changed`, `environment`) and `failure.advice`; fix the
environment (free the port, install the tool, raise the step timeout), not
the task code. `"lifecyclePreflight": "cached"` in the policy runs the same
check before every `run`, once per base tree, and stops the run before any
paid attempt.
