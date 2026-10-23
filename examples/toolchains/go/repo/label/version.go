package label

import "golang.org/x/mod/semver"

// FormatVersion — версия формата меток (внешняя зависимость модуля проверяется go.sum).
const FormatVersion = "v1.0.0"

// ValidFormat сообщает, что версия формата — корректная semver.
func ValidFormat() bool { return semver.IsValid(FormatVersion) }
