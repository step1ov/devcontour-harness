// Package label форматирует метки позиций заказа.
package label

import "fmt"

// Label возвращает метку позиции.
func Label(n int) string {
	return fmt.Sprintf("item-%d", n)
}
