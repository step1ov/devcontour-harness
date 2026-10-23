// Package label форматирует метки позиций заказа.
package label

import "fmt"

// Неверная реализация для отрицательного прогона: два знака.
func Label(n int) string {
	return fmt.Sprintf("item-%02d", n)
}
