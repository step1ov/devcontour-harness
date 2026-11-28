// Поддельный исправный `harness review-release` (тесты `review-release
// --detach`, не модель): ставит метку идущего ревью, как Harness.reviewRelease,
// пишет строку в stdout, ждёт файла `<state>/release-go` (не дольше 30 с),
// пишет `<state>/review-done` со своим pid и снимает метку.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markReleaseReview } from '../../../src/control/detach.ts';

const args = process.argv.slice(2);
const state = args[args.indexOf('--state') + 1]!;
const unmark = markReleaseReview(state);
process.stdout.write('fake review started\n');
for (let end = Date.now() + 30_000; Date.now() < end && !existsSync(join(state, 'release-go'));)
  await new Promise((r) => setTimeout(r, 50));
writeFileSync(join(state, 'review-done'), String(process.pid));
unmark();
