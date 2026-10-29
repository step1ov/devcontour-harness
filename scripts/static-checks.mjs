import { checkProcesses } from './check-processes.mjs';

// Статические шаги `npm run check` параллельно: lint, typecheck и
// schemas:check только читают исходники (tsc --noEmit, eslint без --fix,
// build-schemas --check) и не зависят друг от друга. Вывод каждого шага
// буферизуется и печатается целиком в исходном порядке; итог — отказ, если
// упал хотя бы один шаг. build, тесты и smoke идут после, последовательно.
const steps = process.argv.slice(2);
if (!steps.length) steps.push('lint', 'typecheck', 'schemas:check');
const npm = process.env.npm_execpath;
const processes = checkProcesses();

const runStep = (name) =>
  new Promise((resolve) => {
    const started = Date.now();
    // npm_execpath есть при запуске из npm-скрипта; иначе — npm из PATH.
    const child = npm
      ? processes.spawn(process.execPath, [npm, 'run', '--silent', name], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : processes.spawn('npm', ['run', '--silent', name], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
    if (!child) return resolve({ name, code: 1, signal: null, ms: 0, out: Buffer.alloc(0) });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('error', (error) => out.push(Buffer.from(String(error) + '\n')));
    child.on('close', (code, signal) =>
      resolve({ name, code: code ?? 1, signal, ms: Date.now() - started, out: Buffer.concat(out) }),
    );
  });

const results = await Promise.all(steps.map(runStep));
for (const r of results) {
  const status = r.code === 0 ? 'ok' : `FAIL (${r.signal ?? 'exit ' + r.code})`;
  console.log(`\n> ${r.name}: ${status}, ${(r.ms / 1000).toFixed(1)} s`);
  if (r.out.length) process.stdout.write(r.out);
}
if (results.some((r) => r.code !== 0)) process.exitCode ||= 1;

await processes.dispose();
