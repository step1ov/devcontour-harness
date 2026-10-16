/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- тест правит сырой JSON политики. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isolationSupport } from '../src/environment/isolation.ts';
import { isolationBackend } from '../src/verification/gates.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

/** Проверка, которая сама пробует запрещённое и пишет в JUnit, что удалось. */
const probe = (paths: { state: string; checkout: string; outside: string }) => `
const fs=require('fs'),net=require('net'),https=require('https'),path=require('path');
const cases=[];const ok=(id,v)=>cases.push('<testcase classname="iso" name="'+id+'">'+(v?'':'<failure message="'+id+'"/>')+'</testcase>');
const tryDo=(f)=>{try{f();return true}catch{return false}};
ok('reads-own-worktree', tryDo(()=>fs.readdirSync('.')));
ok('writes-scratch', tryDo(()=>fs.writeFileSync(path.join(process.env.TMPDIR,'t'),'x')));
ok('controller-db-hidden', !tryDo(()=>fs.readFileSync(${JSON.stringify(paths.state)})));
ok('write-outside-denied', !tryDo(()=>fs.writeFileSync(${JSON.stringify(paths.outside)},'x')));
ok('source-checkout-hidden', !tryDo(()=>fs.readFileSync(${JSON.stringify(paths.checkout)})));
ok('git-in-own-worktree', tryDo(()=>require('child_process').execFileSync('git',['status','--porcelain'],{stdio:'pipe'})));
const done=()=>{fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite>'+cases.join('')+'</testsuite>');process.exit(0)};
const s=net.createServer(c=>c.end('pong')).listen(0,'127.0.0.1',()=>{
  net.connect(s.address().port,'127.0.0.1').on('data',()=>{ok('localhost-works',true);s.close();
    https.get('https://example.com',{timeout:5000},()=>{ok('egress-denied',false);done()}).on('error',()=>{ok('egress-denied',true);done()}).on('timeout',function(){this.destroy()});
  }).on('error',()=>{ok('localhost-works',false);done()});
});`;

test('T29: gate в песочнице ОС — своё дерево и scratch доступны; состояние controller, основной checkout, запись снаружи и сеть наружу закрыты', async (t) => {
  const support = isolationSupport();
  if (!support.ok) {
    // Механизма нет — проверяется отказ в соседнем тесте; здесь нечего проверять.
    t.skip('песочница ОС недоступна: ' + support.detail);
    return;
  }
  const ctx = setup({
    scenario: {
      writer: { ...implement(), recordPrompt: true },
      reviewer: { ...approve(), recordPrompt: true },
    },
    policy: (p: any) => (p.isolation = { mode: 'os', domains: [] }),
  });
  const outside = join(dirname(ctx.state), 'outside-' + ctx.state.split('-').at(-1) + '.txt');
  const script = probe({
    state: join(ctx.state, 'state.sqlite'),
    checkout: join(ctx.repo.dir, 'README.md'),
    outside,
  });
  ctx.policy.repositories[0]!.gates[0]!.command = [process.execPath, '-e', script];
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  const evidence = a.evidence.find((e) => e.gate === 'unit' && e.phase === 'candidate')!;
  assert.deepEqual(
    Object.fromEntries((evidence.tests ?? []).map((x) => [x.id.replace(/^iso\./, ''), x.status])),
    {
      'reads-own-worktree': 'passed',
      'writes-scratch': 'passed',
      'controller-db-hidden': 'passed',
      'write-outside-denied': 'passed',
      'source-checkout-hidden': 'passed',
      'git-in-own-worktree': 'passed',
      'localhost-works': 'passed',
      'egress-denied': 'passed',
    },
    evidence.summary,
  );
  assert.equal(existsSync(outside), false, 'внешняя сверка: файла снаружи нет');
  assert.equal(a.status, 'succeeded', a.error);
  // Writer и reviewer: состояние controller закрыто их собственной песочницей.
  const args = (role: string, i: number) =>
    JSON.parse(
      readFileSync(`${ctx.scenarioPath}.${role}.${i}.prompt`, 'utf8').split('\n---ARGS---\n')[1]!,
    ) as string[];
  const writer = args('writer', 0).join(' ');
  assert.ok(writer.includes(ctx.state), 'writer: каталог состояния назван в запретах');
  const reviewer = args('reviewer', 0).find((x) => x.startsWith('permissions.harness='))!;
  assert.ok(
    reviewer.includes(`"${join(ctx.state, 'state.sqlite')}"="none"`),
    'reviewer: база controller закрыта',
  );
  assert.ok(
    reviewer.includes(`"${join(ctx.repo.dir, 'README.md')}"="none"`),
    'reviewer: основной checkout закрыт',
  );
});

test('T29: без механизма песочницы обязательная изоляция — отказ без запуска команды; снять её можно только явно', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => {
      p.isolation = { mode: 'os', domains: [] };
      p.maxAttempts = 1;
    },
  });
  const marker = join(dirname(ctx.state), 'host-write-' + ctx.state.split('-').at(-1) + '.txt');
  ctx.policy.repositories[0]!.gates[0]!.command = [
    process.execPath,
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`,
  ];
  const original = isolationBackend.check;
  isolationBackend.check = () => ({ ok: false, detail: 'механизм песочницы не найден' });
  try {
    await runAll(ctx);
  } finally {
    isolationBackend.check = original;
  }
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.match(work.failure!, /Изоляция проверок недоступна: механизм песочницы не найден/);
  assert.equal(existsSync(marker), false, 'команда не запускалась на хосте');

  // Явный выбор none — обычный процесс хоста, без скрытого ограничения.
  const none = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => (p.maxAttempts = 1),
  });
  none.policy.repositories[0]!.gates[0]!.command = [
    process.execPath,
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`,
  ];
  await runAll(none);
  assert.equal(existsSync(marker), true, 'isolation.mode: none — команда исполнена на хосте');
});
