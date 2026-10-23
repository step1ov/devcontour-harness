<!-- devcontour-harness controller-mode overlay v1. Pinned as a context source; do not edit per project. -->

# Controller mode (devcontour-harness overlay v1)

This attempt runs under devcontour-harness in controller mode. The overlay adds
to the repository's own AGENTS.md files. It does not replace them. Where this
overlay and a product rule disagree about who does an operation, this overlay
decides. Every other product rule still applies.

## Who owns what

| Operation                                                                                       | Owner in this attempt            |
| ----------------------------------------------------------------------------------------------- | -------------------------------- |
| Creating, entering, tearing down and removing Git worktrees                                     | harness controller               |
| Branches, commits, merges, rebases, tags and pushes                                             | harness controller               |
| Running acceptance gates and recording evidence                                                 | harness controller               |
| Moving the task, sessions, checkpoints and work history in Relay or any other tracker           | harness controller               |
| Starting, stopping and cleaning up per-attempt environments (Docker projects, ports, env files) | harness controller via lifecycle |
| Editing files inside the issued write scope                                                     | worker (you)                     |

The worker edits files only inside the write scope that the harness issued for
this work order. When the edits are complete, the worker stops and reports. The
worker leaves every change uncommitted in the given worktree. The controller
stages, commits, verifies, reviews and integrates the change.

## Product rules delegated to the controller

The product AGENTS.md files can tell an agent to do the operations below. In
this mode the controller does them instead, so the worker does not:

1. Create or remove worktrees (`pnpm worktree:create`, `worktree:up`,
   `worktree:down`, `worktree:remove`, or any other worktree registry).
2. Commit, merge into the main branch, or move the task to review.
3. Open Relay sessions or intents, write checkpoints or history, or use the
   `.artifacts/relay/` fallback. The controller keeps the Relay history.
4. Run `pnpm run setup` or any other unpinned skill or agent bootstrap.
5. Start another orchestrator, scheduler or agent, or run `harness` from
   inside the attempt.

## Product rules that still apply

- Code style, architecture, review and naming rules of the touched packages.
  Read the AGENTS.md files on the paths you change before you edit, for
  example `apps/nest-backend/AGENTS.md` and `apps/next-web-app/AGENTS.md`.
- Never hand-edit generated code. To change generated outputs that are in the
  write scope, change the inputs and run the project's pinned generator
  command. In Turbo Starter that command is `pnpm rest-api-sdk:generate`. A
  harness gate regenerates the outputs and rejects any difference.
- Do not change lockfiles, dependencies, generator configuration or harness
  files. The harness protects these paths.
- Do not add tests or test infrastructure where the product forbids it. The
  harness supplies its acceptance checks outside the product code.

## When you cannot proceed

If a product rule cannot be satisfied inside the issued scope, stop. Report the
rule and the reason, and return `completed=false`. Do not widen the scope
yourself.
