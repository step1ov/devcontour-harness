package label

import (
	"encoding/json"
	"os"
	"testing"
)

type contract struct {
	Prefix   string  `json:"prefix"`
	Width    int     `json:"width"`
	Examples [][]any `json:"examples"`
}

func TestBackendLabelFollowsContract(t *testing.T) {
	raw, err := os.ReadFile("../../contract/label.json")
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	for _, e := range c.Examples {
		n, want := int(e[0].(float64)), e[1].(string)
		if got := Label(n); got != want {
			t.Errorf("Label(%d) = %q, want %q", n, got, want)
		}
	}
}
