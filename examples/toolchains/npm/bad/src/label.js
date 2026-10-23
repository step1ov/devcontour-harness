// Неверная реализация для отрицательного прогона: два знака вместо трёх.
export function label(n) {
  return `item-${String(n).padStart(2, '0')}`;
}
