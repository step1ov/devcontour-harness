// Байтовая граница транспорта: размер считается в UTF-8 байтах. Функции не
// бросают на превышении — отказ (код, текст, статус) формирует хост.

/** UTF-8 байты строки (сырой текст запроса до разбора JSON). */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** UTF-8 байты `JSON.stringify(value)`; значение без JSON-представления — 0. */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value) as string | undefined;
  return json === undefined ? 0 : utf8Bytes(json);
}

/** Размер JSON и помещается ли он в предел (`bytes <= limit`). */
export function checkJsonBytes(value: unknown, limit: number): { bytes: number; within: boolean } {
  const bytes = jsonBytes(value);
  return { bytes, within: bytes <= limit };
}
