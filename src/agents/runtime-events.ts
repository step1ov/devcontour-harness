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
