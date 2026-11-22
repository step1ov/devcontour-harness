/**
 * Строки для человека с длинными именами (P9): имя ветки, ID и refs
 * сокращаются серединой, слова смысла («ещё нет», «локально», вердикт)
 * сохраняются, строка не длиннее предела. Границы — имя 0, у предела и 500
 * символов, RU и EN.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_VIEW_TEXT, operatorViewSchema } from '../src/contracts/index.ts';
import { plainBlocker, type BlockerContext } from '../src/control/blocker-plain.ts';
import { codeReviewLineParts, reviewsOf } from '../src/control/operator-view.ts';
import { remoteOf } from '../src/control/target.ts';
import { elideMiddle, fitLine, named, operatorView } from '../src/projections/index.ts';
import { BLOCKER_PLAIN_MAX } from '../src/projections/blocker-line.ts';
import type { OperatorActivityInput } from '../src/projections/operator-view.ts';
import { at, baseInput, review, work } from './operator-view-input.ts';
import { policyOf, sha } from './engine-fixture.ts';

const branch = (n: number) =>
  n === 0 ? '' : ('origin/' + 'z'.repeat(Math.max(0, n - 'origin/'.length - 4)) + '-end').slice(-n);

test('elideMiddle: начало и конец имени, длина ровно предел, суррогатная пара не режется', () => {
  assert.equal(elideMiddle('abcdef', 6), 'abcdef');
  assert.equal(elideMiddle('abcdefgh', 5), 'ab…gh');
  assert.equal(elideMiddle('abcdefgh', 1), '…');
  assert.equal(elideMiddle('abcdefgh', 0), '');
  const emoji = 'ab😀😀😀cd';
  for (let n = 2; n < emoji.length; n++) {
    const out = elideMiddle(emoji, n);
    assert.ok(out.length <= n, `${n}: ${out}`);
    assert.ok(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out),
      out,
    );
  }
});

test('fitLine: текст шаблона целиком, имена делят остаток, длина ≤ предела', () => {
  for (const n of [0, 1, 50, 150, 199, 200, 201, 500, 5000]) {
    const line = fitLine(
      ['a ', named('x'.repeat(n)), ' b ', named('y'.repeat(n)), ' — не прошла'],
      60,
    );
    assert.ok(line.length <= 60, `${n}: ${line.length}`);
    assert.ok(line.startsWith('a '), line);
    assert.ok(line.endsWith(' — не прошла'), line);
    assert.ok(line.includes(' b '), line);
  }
  // Короткое имя не сокращается, длинное берёт остаток.
  const mixed = fitLine([named('short'), ' / ', named('z'.repeat(500)), ' tail'], 40);
  assert.equal(mixed.length, 40);
  assert.ok(mixed.startsWith('short / z'), mixed);
  // Маска — до сокращения: префикс секрета не остаётся.
  const secret = 'sk-ant-' + 'S'.repeat(40);
  const masked = fitLine(['key ', named(secret), ' end'], 20, (t) => t.replace(secret, '‹masked›'));
  assert.equal(masked, 'key ‹masked› end');
  // Шаблон длиннее предела — обрезка с конца, но не длиннее предела.
  assert.ok(fitLine(['x'.repeat(30), named('n')], 10).length <= 10);
  assert.equal(fitLine(['x'], 0), '');
  assert.equal(fitLine(['😀z'], 2), '…');
});

test('remoteOf: «ещё нет» / «not yet» сохраняются при имени 0, у предела и 500+ символов', () => {
  for (const n of [0, 20, 440, 455, 460, 480, 499, 500, 501, 1000]) {
    const name = branch(n);
    const local = remoteOf('not-pushed', { short: name });
    const pushed = remoteOf('pushed', { short: name });
    for (const [line, words] of [
      [local.line, 'принято локально; ещё нет в удалённой ветке'],
      [local.lineEn, 'accepted locally; not yet on the remote branch'],
      [pushed.line, 'уже в удалённой ветке'],
      [pushed.lineEn, 'already on the remote branch'],
    ] as const) {
      assert.ok(line.length <= 500, `${n}: ${line.length}`);
      assert.ok(line.startsWith(words), `${n}: ${line}`);
      if (n) assert.ok(line.endsWith(name.slice(-4)), `${n}: конец имени виден`);
      if (n && line.length < 500) assert.ok(line.endsWith(name), `${n}: имя целиком`);
    }
    assert.equal(local.state, 'not-pushed');
    if (n > 500) assert.equal(local.trackingRef, undefined, 'имя длиннее договора — поля нет');
  }
});

const target = {
  repositoryId: 'app',
  ref: 'refs/heads/main',
  acceptedSha: sha('a'),
  head: sha('a'),
  commitsSinceAccepted: 0,
  filesSinceAccepted: 0,
};

test('view: строка удалённой ветки ≤ 200 и с «ещё нет» при имени 0, у предела и 500', () => {
  const lengths = [0, 20, 150, 160, 170, 199, 200, 300, 500, 501, 2000];
  const works = lengths.flatMap((n) =>
    (['not-pushed', 'pushed'] as const).map((state) =>
      work(`${state}-${n}`, {
        status: 'done',
        target: { ...target, remote: remoteOf(state, { short: branch(n) }) },
      }),
    ),
  );
  const input = baseInput({ works });
  for (const lang of ['ru', 'en'] as const) {
    const view = operatorView(input, { lang });
    operatorViewSchema.parse(view);
    for (const n of lengths) {
      const local = view.works.find((w) => w.id === `not-pushed-${n}`)!.target!.remote;
      const pushed = view.works.find((w) => w.id === `pushed-${n}`)!.target!.remote;
      assert.equal(local.state, 'not-pushed');
      for (const [r, words] of [
        [
          local,
          lang === 'ru'
            ? 'принято локально; ещё нет в удалённой ветке'
            : 'accepted locally; not yet on the remote branch',
        ],
        [pushed, lang === 'ru' ? 'уже в удалённой ветке' : 'already on the remote branch'],
      ] as const) {
        const line = r.line!;
        assert.ok(line.length <= OPERATOR_VIEW_TEXT.line, `${lang} ${n}: ${line.length}`);
        assert.ok(line.startsWith(words), `${lang} ${n}: ${line}`);
        // Имя длиннее договора (нет trackingRef): точного имени нет — «…».
        if (n > 500) assert.ok(line.endsWith(' …'), `${lang} ${n}: ${line}`);
        else if (n)
          assert.ok(line.endsWith('-end'.slice(-Math.min(4, n))), `${lang} ${n}: ${line}`);
      }
    }
  }
});

test('view: строка «неизвестно (причина)» сохраняет закрывающую скобку', () => {
  const reason = 'r'.repeat(200);
  const input = baseInput({
    works: [
      work('u', {
        status: 'done',
        target: {
          ...target,
          remote: remoteOf('unknown', { reason: { ru: reason, en: reason } }),
        },
      }),
    ],
  });
  const line = operatorView(input).works[0]!.target!.remote.line!;
  assert.ok(line.length <= OPERATOR_VIEW_TEXT.line);
  assert.ok(line.startsWith('неизвестно (') && line.endsWith(')'), line);
});

test('лента: длинные ID и ветка сокращаются, «локально» и хвост фразы остаются', () => {
  const id = 'w'.repeat(80);
  const ref = 'refs/heads/' + 'r'.repeat(200);
  const events: OperatorActivityInput[] = [
    { kind: 'work.accepted', at: at(10), workId: id, attempt: 3, sha: sha('c'), ref },
    {
      kind: 'gate',
      at: at(11),
      workId: id,
      attempt: 1,
      gate: 'g'.repeat(80),
      phase: 'candidate',
      passed: false,
    },
    {
      kind: 'attempt.ended',
      at: at(12),
      workId: id,
      attempt: 2,
      outcome: 'failed',
      reason: { ru: 'окружение — ' + 'x'.repeat(200), en: 'environment — ' + 'x'.repeat(200) },
      uncounted: true,
    },
    {
      kind: 'review',
      at: at(13),
      scope: 'code',
      subject: 's',
      label: `app/writer ${'q'.repeat(500)}..${'w'.repeat(500)}`,
      reviewer: 'codex',
      approved: false,
      blocking: 2,
      round: 4,
      inspection: 'diff-only',
    },
  ] as OperatorActivityInput[];
  const tails = {
    ru: {
      'work.accepted': ', локально',
      'gate.failed': ', кандидат)',
      'attempt.failed': '; попытка не расходуется',
      'review.changes-requested': '; читал diff, ничего не запускал',
    },
    en: {
      'work.accepted': ', locally',
      'gate.failed': ', candidate)',
      'attempt.failed': '; the attempt is not counted',
      'review.changes-requested': '; read the diff, ran nothing',
    },
  } as const;
  for (const lang of ['ru', 'en'] as const) {
    const view = operatorView(baseInput({ works: [work('w')], activity: events }), { lang });
    operatorViewSchema.parse(view);
    for (const [action, tail] of Object.entries(tails[lang])) {
      const row = view.activity!.find((x) => x.action === action)!;
      assert.ok(row, action);
      assert.ok(row.plain.length <= OPERATOR_VIEW_TEXT.activity, `${action}: ${row.plain.length}`);
      assert.ok(row.plain.endsWith(tail), `${lang} ${action}: ${row.plain}`);
    }
    const accepted = view.activity!.find((x) => x.action === 'work.accepted')!.plain;
    assert.ok(accepted.includes(sha('c').slice(0, 12)), accepted);
    assert.ok(
      accepted.includes(lang === 'ru' ? 'принята (попытка 3)' : 'was accepted (attempt 3)'),
    );
    const gate = view.activity!.find((x) => x.action === 'gate.failed')!.plain;
    assert.ok(gate.includes(lang === 'ru' ? ': не прошла (' : ': failed ('), gate);
  }
});

test('ревью кода: refs до 500 символов сокращаются, вердикт и раунды остаются', () => {
  const counts = { blocking: 2, notes: 1, accepted: 0 };
  const verdict = {
    ru: ': не одобрено, открытых блокирующих 2, открытых заметок 1;',
    en: ': not approved, 2 open blocking findings, 1 open note;',
  };
  const ns = [1, 40, 60, 100, 500];
  const reviews = ns.map((n) => {
    const r = {
      repositoryId: 'p'.repeat(80),
      role: 'r'.repeat(80),
      refs: { base: 'refs/heads/' + 'q'.repeat(n), head: 'refs/heads/' + 'w'.repeat(n - 1) + 'Z' },
      approved: false,
      round: 7,
    };
    const ru = codeReviewLineParts(r, counts, 'ru');
    const en = codeReviewLineParts(r, counts, 'en');
    const join = (p: typeof ru) => p.map((x) => (typeof x === 'string' ? x : x.name)).join('');
    return review(`c${n}`, {
      kind: 'code',
      approved: false,
      line: join(ru),
      lineEn: join(en),
      lineParts: { ru, en },
    });
  });
  for (const lang of ['ru', 'en'] as const) {
    const view = operatorView(baseInput({ reviews }), { lang });
    operatorViewSchema.parse(view);
    for (const n of ns) {
      const line = view.reviews.find((r) => r.subject === `c${n}`)!.line!;
      assert.ok(line.length <= OPERATOR_VIEW_TEXT.line, `${lang} ${n}: ${line.length}`);
      assert.ok(line.startsWith(lang === 'ru' ? 'код ' : 'code '), line);
      assert.ok(line.includes(verdict[lang]), `${lang} ${n}: вердикт: ${line}`);
      assert.ok(line.endsWith(lang === 'ru' ? '; раундов 7' : '; rounds 7'), line);
      assert.ok(line.includes('Z:'), `${lang} ${n}: конец head виден: ${line}`);
    }
  }
});

test('ревью плана: ID предмета 80 символов сокращается, хвост строки остаётся', () => {
  const subject = 's'.repeat(80);
  const tail = '; раундов 3/6; ревью $0.25 + вызовов без стоимости 1; ждёт решения оператора';
  const ru = [`план `, { name: subject }, `: ${'x'.repeat(60)}${tail}`];
  const view = operatorView(
    baseInput({
      reviews: [
        review(subject, {
          line: ru.map((p) => (typeof p === 'string' ? p : p.name)).join(''),
          lineParts: { ru, en: ru },
        }),
      ],
    }),
  );
  const line = view.reviews[0]!.line!;
  assert.ok(line.length <= OPERATOR_VIEW_TEXT.line, String(line.length));
  assert.ok(line.endsWith(tail), line);
});

test('маска — до сокращения: секрет в refs и в имени ветки не оставляет префикса', () => {
  const secret = 'SECRET' + 'Q'.repeat(294);
  const counts = { blocking: 0, notes: 0, accepted: 0 };
  const parts = codeReviewLineParts(
    {
      repositoryId: 'app',
      role: 'writer',
      refs: { base: 'refs/heads/' + secret, head: 'refs/heads/main' },
      approved: true,
      round: 1,
    },
    counts,
    'ru',
  );
  const huge = 'origin/' + secret + 'z'.repeat(300);
  const input = baseInput({
    reviews: [review('c', { kind: 'code', lineParts: { ru: parts, en: parts } })],
    works: [
      work('t', {
        status: 'done',
        target: { ...target, remote: remoteOf('not-pushed', { short: huge }) },
      }),
      work('s', {
        status: 'done',
        target: { ...target, remote: remoteOf('not-pushed', { short: 'origin/' + secret }) },
      }),
    ],
    mask: { secrets: [secret] },
  });
  const view = operatorView(input);
  const s = JSON.stringify(view);
  assert.ok(!s.includes('SECRETQQ'), s);
  const remote = (id: string) => view.works.find((w) => w.id === id)!.target!.remote;
  assert.equal(remote('t').trackingRef, undefined);
  assert.equal(remote('t').line, 'принято локально; ещё нет в удалённой ветке …');
  assert.ok(
    remote('s').line!.startsWith('принято локально; ещё нет в удалённой ветке origin/‹masked›'),
    remote('s').line,
  );
});

test('блокировка удержания: имя сокращается, «ждёт её конца» остаётся; маска — до сокращения', () => {
  const secret = 'SECRET' + 'Q'.repeat(174);
  const cases = [
    ...[1, 100, 140, 290, 500].map((n) => 'op-' + 'o'.repeat(n)),
    'op-' + secret,
    'op-' + secret + 'o'.repeat(300),
  ];
  const blockers = cases.map((operation) => {
    const ctx = {
      control: { paused: false },
      approvalMode: 'agent',
      work: { hold: { operation, reason: 'r' } },
      statusOf: () => undefined,
    } as unknown as BlockerContext;
    return plainBlocker({ code: 'NOT_READY', message: 'Удержано операцией ' + operation }, ctx);
  });
  const tails = {
    ru: ['удержано операцией ', ' — ждёт её конца'],
    en: ['held by an operation ', ' — waiting for it to finish'],
  } as const;
  for (const b of blockers)
    for (const line of [b.plain, b.plainEn]) {
      assert.ok(line.length <= BLOCKER_PLAIN_MAX, String(line.length));
      assert.ok(line.endsWith(line === b.plain ? tails.ru[1] : tails.en[1]), line);
    }
  const input = baseInput({
    works: blockers.map((b, k) =>
      work(`h${k}`, { blockers: [{ code: 'NOT_READY', message: 'm', ...b }] }),
    ),
    mask: { secrets: [secret] },
  });
  for (const lang of ['ru', 'en'] as const) {
    const view = operatorView(input, { lang });
    operatorViewSchema.parse(view);
    assert.ok(!JSON.stringify(view).includes('SECRETQ'), lang);
    cases.forEach((operation, k) => {
      const plain = view.works.find((w) => w.id === `h${k}`)!.blockers[0]!.plain!;
      const [head, tail] = tails[lang];
      assert.ok(plain.length <= OPERATOR_VIEW_TEXT.plain, `${lang} ${k}: ${plain.length}`);
      assert.ok(
        plain.startsWith(head + 'op') || plain === head + '…' + tail,
        `${lang} ${k}: ${plain}`,
      );
      assert.ok(plain.endsWith(tail), `${lang} ${k}: ${plain}`);
      if (operation.length <= 100) assert.equal(plain, head + operation + tail);
    });
  }
});

test('ревью из загрузчика: план, контракт и код приходят частями, хвост и маска сохраняются', () => {
  const secret = 'SECRET' + 'Q'.repeat(294);
  const base = {
    round: 3,
    approved: false,
    findings: [],
    at: at(5),
    reviewerRuntime: 'codex',
    sameVendor: false,
  };
  const plan = { ...base, kind: 'plan', subject: 's'.repeat(80) };
  const contract = { ...base, kind: 'contract', subject: 'k'.repeat(80) };
  const code = {
    ...base,
    subject: 'c1',
    repositoryId: 'app',
    role: 'writer',
    refs: { base: 'refs/heads/' + secret, head: 'refs/heads/' + 'w'.repeat(400) + 'Z' },
  };
  const v = {
    locals: (k: string) =>
      k === 'reviews'
        ? [{ value: plan }, { value: contract }]
        : k === 'code-reviews'
          ? [{ value: code }]
          : [],
  };
  const { reviews } = reviewsOf(v as never, policyOf());
  assert.equal(reviews.length, 3);
  assert.ok(
    reviews.every((r) => r.lineParts),
    'загрузчик передаёт части',
  );
  for (const lang of ['ru', 'en'] as const) {
    const view = operatorView(baseInput({ reviews, mask: { secrets: [secret] } }), { lang });
    operatorViewSchema.parse(view);
    assert.ok(!JSON.stringify(view).includes('SECRETQ'), lang);
    for (const r of view.reviews) {
      assert.ok(r.line!.length <= OPERATOR_VIEW_TEXT.line, r.line);
      assert.match(
        r.line!,
        lang === 'ru' ? /: не одобрено; раундов 3/ : /: not approved; rounds 3/,
        r.line,
      );
    }
    const codeLine = view.reviews.find((r) => r.kind === 'code')!.line!;
    assert.ok(codeLine.includes('Z:'), codeLine);
  }
  // Короткие имена: строка представления — ровно строка загрузчика.
  const short = reviewsOf(
    {
      locals: (k: string) => (k === 'reviews' ? [{ value: { ...plan, subject: 'g' } }] : []),
    } as never,
    policyOf(),
  ).reviews;
  const view = operatorView(baseInput({ reviews: short }));
  assert.equal(view.reviews[0]!.line, short[0]!.line);
});

test('view: строка без имени ветки не получает «…»', () => {
  const input = baseInput({
    works: (['pushed', 'not-pushed'] as const).map((state) =>
      work(state, { status: 'done', target: { ...target, remote: remoteOf(state, {}) } }),
    ),
  });
  const view = operatorView(input, { lang: 'en' });
  assert.equal(
    view.works.find((w) => w.id === 'pushed')!.target!.remote.line,
    'already on the remote branch',
  );
  assert.equal(
    view.works.find((w) => w.id === 'not-pushed')!.target!.remote.line,
    'accepted locally; not yet on the remote branch',
  );
});
