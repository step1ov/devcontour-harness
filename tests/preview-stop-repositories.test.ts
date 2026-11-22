import './temp-scope.ts';
/**
 * `preview-stop --preview <id>` без `--repository`: тот же ID превью в
 * нескольких репозиториях — отказ INVALID_INPUT со списком репозиториев, а
 * не остановка всех; `--all` или `--repository` — явный выбор.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError } from '../src/contracts/index.ts';
import type { PreviewReceipt } from '../src/contracts/preview.ts';
import { previewsRoot, stopPreviews, writeReceipt } from '../src/control/preview.ts';

function receipt(stateDir: string, repositoryId: string, id: string): PreviewReceipt {
  const dir = join(previewsRoot(stateDir), repositoryId, id);
  mkdirSync(dir, { recursive: true });
  const at = '2026-11-22T10:00:00.000Z';
  const r: PreviewReceipt = {
    version: 1,
    id,
    repositoryId,
    ref: 'accepted',
    sha: 'a'.repeat(40),
    worktree: join(dir, 'tree'),
    dir,
    log: join(dir, 'app.log'),
    services: false,
    pids: { supervisor: 999_999 },
    starts: {},
    startedAt: at,
    expiresAt: at,
    ttlMs: 60_000,
    idleMs: 0,
    state: 'stopped',
    stoppedAt: at,
  };
  writeReceipt(r);
  return r;
}

test('preview-stop: ID превью в нескольких репозиториях без --repository — INVALID_INPUT со списком; --all и --repository — выбор', async () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-preview-repos-')));
  receipt(stateDir, 'app', 'web');
  receipt(stateDir, 'api', 'web');
  receipt(stateDir, 'api', 'docs');
  const ctx = {
    policy: { repositories: [] },
    baseDir: stateDir,
    stateDir,
  } as unknown as Parameters<typeof stopPreviews>[0];
  await assert.rejects(
    stopPreviews(ctx, { previewId: 'web' }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'INVALID_INPUT' &&
      /api, app/.test(e.message) &&
      /--repository/.test(e.message) &&
      /--all/.test(e.message),
  );
  const both = await stopPreviews(ctx, { previewId: 'web', all: true });
  assert.deepEqual(both.previews.map((r) => r.repositoryId).sort(), ['api', 'app']);
  const one = await stopPreviews(ctx, { previewId: 'web', repositoryId: 'app' });
  assert.deepEqual(
    one.previews.map((r) => r.repositoryId),
    ['app'],
  );
  // ID в одном репозитории — без выбора, как прежде.
  const single = await stopPreviews(ctx, { previewId: 'docs' });
  assert.deepEqual(
    single.previews.map((r) => r.repositoryId),
    ['api'],
  );
});
