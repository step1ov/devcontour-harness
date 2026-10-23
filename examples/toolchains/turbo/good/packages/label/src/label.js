// Метка позиции заказа: номер дополняется нулями до трёх знаков.
export function label(n) {
  return `item-${String(n).padStart(3, '0')}`;
}
