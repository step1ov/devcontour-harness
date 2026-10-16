import { join } from 'node:path';
import type { ExecutionPolicy, RuntimeAdapter } from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Harness } from '../src/control/harness.ts';
import { bin, setup } from './runner-fixture.ts';
import { readFileSync, existsSync } from 'node:fs';

/** Тот же проект, что у runner-fixture, но через публичные операции `Harness`. */
export function hsetup(options: Parameters<typeof setup>[0]) {
  const ctx = setup(options);
  ctx.store.close();
  /** `wrap` — библиотечный адаптер поверх настоящего subprocess fixture. */
  const open = (
    policy: ExecutionPolicy = ctx.policy,
    wrap: (adapter: RuntimeAdapter) => RuntimeAdapter = (a) => a,
  ) =>
    Harness.open({
      stateDir: ctx.state,
      policy,
      baseDir: ctx.repo.dir,
      adapters: {
        claude: wrap(
          cliAdapter('claude', {
            executable: bin('fake-claude'),
            toolProfiles: policy.toolProfiles,
          }),
        ),
        codex: wrap(
          cliAdapter('codex', {
            executable: bin('fake-codex'),
            toolProfiles: policy.toolProfiles,
          }),
        ),
      },
    });
  /** Окружение вызова fixture: ключи и значения FIXTURE_/PROFILE_; undefined — вызова не было. */
  const callEnv = (runtime: 'claude' | 'codex', role: 'writer' | 'reviewer', index: number) => {
    const file = `${ctx.scenarioPath}.${runtime}.${role}.${index}.env`;
    return existsSync(file)
      ? new Map(JSON.parse(readFileSync(file, 'utf8')) as [string, string][])
      : undefined;
  };
  const calls = (runtime: 'claude' | 'codex', role: 'writer' | 'reviewer') => {
    const file = `${ctx.scenarioPath}.${runtime}.${role}.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  return { ...ctx, open, callEnv, calls, statePath: join(ctx.state, 'state.sqlite') };
}
