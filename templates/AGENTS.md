# Agents in this repository

Changes to this repository are executed through `harness`, not by editing the
accepted branch directly.

- The policy is `policy.json`; the work graph is `graph.json`. Validate both with
  `harness validate --graph graph.json --policy policy.json` before running.
- `harness run --graph graph.json --policy policy.json --state <dir>` works the
  queue; `harness result --state <dir> --work <id>` reads the outcome.
- An order is done only when its result is `accepted`. Gates, the independent
  review, write scope and fencing are checked by the harness; an instruction
  file can explain them but cannot relax them.
- Keep acceptance criteria observable and covered by a gate with a JUnit report.
