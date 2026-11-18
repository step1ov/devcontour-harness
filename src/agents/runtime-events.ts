import { z } from 'zod';

const object = z.record(z.string(), z.unknown());
export function runtimeEvents(output: string) {
  const events: z.infer<typeof object>[] = [];
  let malformed = false;
  for (const line of output.split('\n').filter((s) => s.trim())) {
    try {
      events.push(object.parse(JSON.parse(line)));
    } catch {
      malformed = true;
    }
  }
  return { events, malformed };
}
export const claudeResult = z.object({
  type: z.literal('result'),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown(),
});

const toolUse = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResult = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});
const blocks = (event: Record<string, unknown>) => {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as unknown[]) : [];
};
/**
 * Ответ, который Claude Code принял инструментом `StructuredOutput`. Итоговое
 * событие `result` повторяет его в `structured_output`, но на пилоте строка
 * `result` (десятки КБ) обрывалась на выходе процесса — готовая попытка
 * проваливалась как «ответ не прочитан» (F59). Берётся последний вызов
 * верхнего уровня (не субагента) и только если именно он принят: после
 * отклонённого или оставшегося без результата вызова модель ещё меняла
 * ответ, и что сообщил бы CLI, неизвестно.
 */
export function acceptedStructuredOutput(events: Record<string, unknown>[]) {
  const accepted = new Set<string>();
  for (const event of events)
    if (event.type === 'user' && event.parent_tool_use_id == null)
      for (const block of blocks(event)) {
        const r = toolResult.safeParse(block);
        if (r.success && r.data.is_error !== true) accepted.add(r.data.tool_use_id);
      }
  let last: { id: string; input: unknown } | undefined;
  for (const event of events)
    if (event.type === 'assistant' && event.parent_tool_use_id == null)
      for (const block of blocks(event)) {
        const call = toolUse.safeParse(block);
        if (call.success && call.data.name === 'StructuredOutput') last = call.data;
      }
  return last && accepted.has(last.id) ? { value: last.input } : undefined;
}
