/**
 * A03: основания прежних согласований не меняются от обновления пакета.
 *
 * Эталоны ниже вычислены кодом выпуска 0.1.0-alpha.5 (`c1bb638`, архив
 * sha256 040d2917…bbd0) на тех же входах: встроенные профили, политики и
 * графы примеров и шаблонов, снимок контекста `examples/files-only`. Новый
 * код обязан давать те же digest: иначе согласования и закрепления прежних
 * потребителей стали бы недействительны без изменения их входов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileContextSource, builtinProfiles, profilePin, resolveProfile } from '../src/index.ts';
import {
  contextDigest,
  digestOf,
  executionDigest,
  executionPolicySchema,
  policyDigest,
  workGraphDigest,
  workGraphSchema,
} from '../src/contracts/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ALPHA5_COMMIT = 'c1bb638';
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown;

/**
 * Закрепления встроенных профилей alpha.5. У листа digest — sha256 байтов
 * файла; у составных профилей (extends) — digest композиции, поэтому байты
 * файлов alpha.5 сверяются отдельно (`alpha5Bytes`).
 */
const alpha5Bytes: Record<string, string> = {
  'expo-mobile': 'd7b0ccc451999ef385caa240c74f45f76923b62f2ecb3bd483927e9121c3e58c',
  'nest-api': '678737020a9beeb5cf10573ad1939ed6fe2031502cb04898024dd439ae1a859e',
  'react-native': 'e5c2b262051d0b83493d1945db091803046c5a044d43e659c052d973a0ec8f4c',
};
const alpha5Profiles: Record<string, { version: string; digest: string }> = {
  'expo-mobile': {
    version: '0.2.0',
    digest: 'ae3794dfeeca31741dd63a733b79c54bb5c3c764dd98fc49c5cb28a1c4ff4c70',
  },
  'go-api': {
    version: '0.1.0',
    digest: 'cdd8c2155365ac60294515974dea8116dd53bce38b6b79ffa846c73f2422dfaf',
  },
  'mobile-maestro': {
    version: '0.1.0',
    digest: '063daa6f8bc7180dfdbf47efb87a827de63614744e2a3c3b26849a1d94d23fd7',
  },
  'nest-api': {
    version: '0.1.0',
    digest: 'a72eee6195a1a1b0e5b579fe1f7369c2fa237602baa8563f31e3ab954526aecc',
  },
  'next-product': {
    version: '0.2.0',
    digest: '385213844ba38d5339eae909f4d8547ebaaf8c21cbb18c9a5cbfdd0a0a417fa7',
  },
  'node-checks': {
    version: '0.2.0',
    digest: '1d6a4838d99907b322ede91cce4598dc2628c79cdae3389a45b8bfb3adf38cdf',
  },
  'python-api': {
    version: '0.1.0',
    digest: 'f24cea4f71b6757dcd89746d996c6695bf2a0058c62dc881eebfbd931d02d777',
  },
  'react-native': {
    version: '0.4.0',
    digest: '1cd7cc3969deed0c80cf40cfecaf4df02352ee567637bbd167c5545355431eaf',
  },
  'react-vite-admin': {
    version: '0.2.0',
    digest: 'c38cfdb83adaee6fd14bb6494a580729150ad98dcc0c2158939b923630d83ce9',
  },
};

/** Digest политик примеров и шаблона, вычисленные alpha.5 (`policyDigest`, `executionDigest`). */
const alpha5Policies: Record<string, [policy: string, execution: string]> = {
  'examples/single-task/policy.json': [
    'fe2c6fe7a4c099a27c1b32d2f2fd295a887abcb83ea6f8c41dd408b561e00279',
    '283ae58f297b00c742c2ad627c4ade43748a2e64961bf1148465aa7ca18e8aa2',
  ],
  'examples/single-task/policy-same-vendor.json': [
    'ced6702fd14a854c4181f7599cd0a5cdc25e722f912705e25ecff6ed7f8202be',
    '17f3cf8e367da1a9d68d0eeef49fb2019a3523d57f2678730168a6af987c4132',
  ],
  'examples/files-only/policy.json': [
    '442d084cb50aedde30a7717caa5dcd13df1131aeb879ecbf727b4df94dbbb8cc',
    '3174e7f32c76d8fe5cf604c31dd52f22a661903c64742849a073cbff630fc261',
  ],
  'examples/one-vendor/policy.json': [
    '6b56028c2ac6f189ae27d68173747fcce14408d634c9ada991dbfecf466c6c03',
    'c1f938377988a0dc2f800d9879ba85cb5aef1f8cf4e839c0da4ee69e306ee736',
  ],
  'examples/two-vendors/policy.json': [
    '442d084cb50aedde30a7717caa5dcd13df1131aeb879ecbf727b4df94dbbb8cc',
    '3174e7f32c76d8fe5cf604c31dd52f22a661903c64742849a073cbff630fc261',
  ],
  'templates/policy.json': [
    'b4741da15eb62f971f180a2b32c9ed377542bb92ee58555334098a71dde74498',
    '00a92347092e5cb36cf2eed0ff93fd5153a4675eb5564eee0a2487e9f713a1de',
  ],
};

/** Digest графов (`workGraphDigest`) и их поручений (`digestOf(order)` — orderDigest standalone). */
const alpha5Graphs: Record<string, [graph: string, orders: string[]]> = {
  'examples/single-task/graph.json': [
    '03c03e691a045303bd67c36feea3a01cf177f0331ebb39cf3e8d5468a190157f',
    ['78c5c6b1b8dfbf40c5449821c58b65c183cb59acca0353872ae8bc6bdf8ab6f9'],
  ],
  'examples/files-only/graph.json': [
    'd065ebd563bb1eb3e7d06250db53619cb3576eda5a9a2e1bf9190fdc703d828f',
    ['aef81e41d3b4b8814b62ed2405e1e4b319115181a79aa0426653d2feb29ba988'],
  ],
  'templates/graph.json': [
    'b42f7cebb641b01bd3bb2d7663f768e7250dd141c94354f95414f46e36db5010',
    ['d6bbedbe7eca1816d7cd6b39f9f2bbf8db04564ddc4f47dd1abadef1aeffa138'],
  ],
};

/**
 * Необязательные поля политики, добавленные после alpha.5. Для каждого:
 * политика без поля сохраняет digest alpha.5 (проверка выше), политика с полем
 * проходит схему, а её основание меняется явно (`changes`) либо остаётся
 * прежним (`unchanged` — поле не входит в основание). Новое поле — новая
 * строка таблицы: молчаливая переинтерпретация прежнего согласования здесь
 * не проходит.
 */
type RawPolicy = { repositories: Record<string, unknown>[] } & Record<string, unknown>;
const additiveFields: {
  id: string;
  apply: (raw: RawPolicy) => void;
  basis: 'changes' | 'unchanged';
}[] = [
  {
    id: 'repositories[].toolchain',
    apply: (raw) => {
      raw.repositories[0]!.toolchain = { tools: { node: '>=24' } };
    },
    basis: 'changes',
  },
  {
    // HP09: повтор протокола ревью; умолчание не подставляется в политику.
    id: 'reviewProtocolRetries',
    apply: (raw) => {
      raw.reviewProtocolRetries = 2;
    },
    basis: 'changes',
  },
];

test('A03/profiles: встроенные профили alpha.5 на месте, их байты и закрепления не изменились', (t) => {
  const ids = builtinProfiles();
  for (const [id, pin] of Object.entries(alpha5Profiles)) {
    assert.ok(ids.includes(id), 'профиль alpha.5 удалён: ' + id);
    const bytes = readFileSync(join(root, 'profiles', id + '.json'));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      alpha5Bytes[id] ?? pin.digest,
      id + ': байты',
    );
    assert.deepEqual(profilePin(resolveProfile(id)), { id, ...pin }, id + ': закрепление');
  }
  // Перекрёстно — байты файлов коммита выпуска, если он есть в клоне.
  let blobs = 0;
  for (const id of Object.keys(alpha5Profiles)) {
    let old: Buffer;
    try {
      old = execFileSync('git', ['show', `${ALPHA5_COMMIT}:profiles/${id}.json`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    assert.ok(old.equals(readFileSync(join(root, 'profiles', id + '.json'))), id + ': ≠ git');
    blobs++;
  }
  t.diagnostic(`сверено с ${ALPHA5_COMMIT}: ${blobs}/${Object.keys(alpha5Profiles).length} файлов`);
});

test('A03/host-digests: политики, графы, поручения и контекст прежних примеров дают digest alpha.5', async () => {
  for (const [path, [policy, execution]] of Object.entries(alpha5Policies)) {
    const parsed = executionPolicySchema.parse(json(path));
    assert.equal(policyDigest(parsed), policy, path + ': policyDigest');
    assert.equal(executionDigest(parsed), execution, path + ': executionDigest');
  }
  for (const [path, [graph, orders]] of Object.entries(alpha5Graphs)) {
    const parsed = workGraphSchema.parse(json(path));
    assert.equal(workGraphDigest(parsed), graph, path + ': workGraphDigest');
    assert.deepEqual(
      parsed.orders.map((o) => digestOf(o)),
      orders,
      path + ': orderDigest',
    );
  }
  const context = await new FileContextSource(join(root, 'examples/files-only/context')).snapshot([
    'norms',
  ]);
  assert.equal(
    contextDigest(context),
    '9ed30e1e06a909889c82a899ef37f6f3011292bc5ad81a9acd79d8ef969bda2d',
    'contextDigest files-only',
  );
});

for (const field of additiveFields)
  test(`A03/additive-field ${field.id}: без поля — digest alpha.5, с полем — основание ${field.basis === 'changes' ? 'меняется явно' : 'прежнее'}`, () => {
    for (const [path, [policy, execution]] of Object.entries(alpha5Policies)) {
      const raw = json(path) as RawPolicy;
      const without = executionPolicySchema.parse(structuredClone(raw));
      assert.equal(policyDigest(without), policy, path);
      assert.equal(executionDigest(without), execution, path);
      field.apply(raw);
      const withField = executionPolicySchema.parse(raw);
      if (field.basis === 'changes') assert.notEqual(executionDigest(withField), execution, path);
      else assert.equal(executionDigest(withField), execution, path);
    }
  });
