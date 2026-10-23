// Согласованность общего контракта меток: примеры следуют prefix и width.
// Обе стороны (frontend и backend) проверяют себя по этим же примерам.
import { readFileSync } from 'node:fs';
const contract = JSON.parse(readFileSync(new URL('./label.json', import.meta.url), 'utf8'));
let bad = 0;
for (const [n, expected] of contract.examples) {
  const derived = contract.prefix + String(n).padStart(contract.width, '0');
  if (derived !== expected) {
    console.error(`contract: ${n} → ${expected}, правило даёт ${derived}`);
    bad++;
  }
}
if (!contract.examples.length) bad++;
console.log(
  bad ? 'contract: inconsistent' : `contract: ${contract.examples.length} examples consistent`,
);
process.exit(bad ? 1 : 0);
