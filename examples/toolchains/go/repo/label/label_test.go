package label

import "testing"

func TestLabelPadsOneDigit(t *testing.T) {
	if got := Label(7); got != "item-007" {
		t.Fatalf("Label(7) = %q, want item-007", got)
	}
}

func TestLabelPadsTwoDigits(t *testing.T) {
	if got := Label(42); got != "item-042" {
		t.Fatalf("Label(42) = %q, want item-042", got)
	}
}

func TestLabelKeepsLong(t *testing.T) {
	if got := Label(1234); got != "item-1234" {
		t.Fatalf("Label(1234) = %q, want item-1234", got)
	}
}

func TestFormatVersion(t *testing.T) {
	if !ValidFormat() {
		t.Fatal("format version is not semver")
	}
}
