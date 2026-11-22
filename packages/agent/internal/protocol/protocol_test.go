package protocol

import (
	"encoding/json"
	"testing"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	env, err := NewEnvelope(TypeExecReq, ExecReqPayload{
		TaskID:    "task_1",
		Script:    "echo hi",
		Lang:      "shell",
		TimeoutMs: 5000,
		Env:       map[string]string{"FOO": "bar"},
	})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(env)
	var back Envelope
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.T != TypeExecReq {
		t.Fatalf("type = %q", back.T)
	}
	var p ExecReqPayload
	if err := json.Unmarshal(back.D, &p); err != nil {
		t.Fatal(err)
	}
	if p.TaskID != "task_1" || p.Script != "echo hi" || p.TimeoutMs != 5000 {
		t.Fatalf("payload mismatch: %+v", p)
	}
	if p.Env["FOO"] != "bar" {
		t.Fatalf("env mismatch: %+v", p.Env)
	}
}

func TestMetricsNullables(t *testing.T) {
	m := MetricsPayload{CPUPercent: 12.5, NetInBps: 100, NetOutBps: 200}
	b, _ := json.Marshal(m)
	s := string(b)
	if want := `"diskReadBps":null`; !contains(s, want) {
		t.Fatalf("expected %s in %s", want, s)
	}
	if want := `"load1":null`; !contains(s, want) {
		t.Fatalf("expected %s in %s", want, s)
	}
}

func TestBinaryFrames(t *testing.T) {
	payload := []byte{0xde, 0xad, 0xbe, 0xef}
	frame := EncodeBinaryFrame(KindPtyData, "term_xyz", payload)
	kind, ch, pl, ok := DecodeBinaryFrame(frame)
	if !ok || kind != KindPtyData || ch != "term_xyz" || string(pl) != string(payload) {
		t.Fatalf("frame mismatch kind=%d ch=%q ok=%v", kind, ch, ok)
	}

	// empty payload
	kind, ch, pl, ok = DecodeBinaryFrame(EncodeBinaryFrame(KindFileData, "ft_1", nil))
	if !ok || ch != "ft_1" || len(pl) != 0 {
		t.Fatalf("empty frame mismatch")
	}

	// truncated
	if _, _, _, ok := DecodeBinaryFrame([]byte{0x01, 10, 'a'}); ok {
		t.Fatal("expected truncated frame to fail")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
