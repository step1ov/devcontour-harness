// Package label форматирует метки позиций заказа.
package label

import "fmt"

// Label возвращает метку позиции: номер дополняется нулями до трёх знаков.
func Label(n int) string {
	return fmt.Sprintf("item-%03d", n)
}
