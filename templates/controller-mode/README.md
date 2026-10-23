# Controller mode (opt-in, v1)

`AGENTS.controller.md` is an overlay for projects whose own AGENTS.md tells an
agent to manage worktrees, commits, merges or Relay history itself. Turbo
Starter is one such project. Under devcontour-harness the controller does
those operations, and the worker only edits files in the scope it was issued.

## How to enable it without deleting product rules

The overlay is delivered to the attempt as a **pinned context source**. It is
not a file committed to the target repository. Some projects forbid new
`.md` files, and their own AGENTS.md files stay unchanged and keep applying.

1. Next to the graph, create the context source directory
   `context/controller-mode/` and copy `AGENTS.controller.md` into it
   unchanged.
2. Put copies of the product AGENTS.md files under
   `context/controller-mode/references/`. Keep their repository paths, for
   example `references/AGENTS.md` and `references/apps/nest-backend/AGENTS.md`.
   Files under `references/` are pinned by SHA-256 and recorded in the
   attempt's provenance, but they are not inlined into the prompt. The worker
   reads the live copies in its worktree.
3. Add `provenance.json` with the overlay version and digest, plus the
   repository path and baseline blob of each referenced AGENTS.md.
   `examples/turbo-starter/setup.mjs` (`controllerContext`) writes this
   layout.
4. Add `"context": ["controller-mode"]` to every order of the graph. Writer
   and reviewers then see the same pinned bytes, and a changed overlay
   requires a new plan approval.
5. Protect the product AGENTS.md files and the harness setup through the
   policy's `protectedPaths`. The worker cannot change the rules it runs
   under.

## What the harness enforces regardless of the text

- A worker commit, a changed HEAD or a write outside `writeScope` makes the
  attempt fail with `scope-violation`. A change to a protected path fails the
  same way.
- The harness creates the attempt worktree. Nothing in the attempt runs the
  project's own `worktree:create`.
- Gates, the independent review and acceptance happen only in the harness.

The overlay is versioned. A new version is a new file, `AGENTS.controller.v2.md`,
with a new `provenance.json` version. Existing pins never change silently.
