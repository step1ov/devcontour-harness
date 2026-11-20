import type { UpdateData } from '../contracts/index.ts';

/** Текст `harness update --human`: строка исхода, что нового, шаги. */
export function updateText(data: UpdateData): string {
  const out = [data.line];
  const c = data.check;
  if (c?.whatsNew?.length && data.action === 'check') {
    out.push('', 'Что нового:');
    for (const p of c.whatsNew) out.push(`  • ${p}`);
  }
  if (c?.note) out.push('', c.note);
  if (data.steps?.length) {
    out.push('');
    for (const s of data.steps)
      out.push(`  ${s.ok ? '✓' : '✗'} ${s.step}${s.detail ? ': ' + s.detail : ''}`);
  }
  if (data.schedule?.instructions) out.push('', data.schedule.instructions);
  return out.join('\n') + '\n';
}
