package pty

import (
	"strings"
	"testing"
	"time"
)

// Exercises openSession end-to-end: ConPTY when the platform driver works,
// transparent pipe fallback when it doesn't (some Windows 11 24H2+ builds).
// Either way a shell session must produce output.
func TestSessionProducesOutput(t *testing.T) {
	s, err := openSession("func-test", 100, 30, "")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()

	buf := make([]byte, 8192)
	var acc strings.Builder
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		_, _ = s.Write([]byte("echo SESSION_OK\r\n"))
		n, err := s.Read(buf)
		if n > 0 {
			acc.Write(buf[:n])
			if strings.Contains(acc.String(), "SESSION_OK") {
				return // shell round-trip verified
			}
		}
		if err != nil {
			t.Logf("read err: %v", err)
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("no SESSION_OK echo received; got: %q", acc.String()[:minLen(acc.Len(), 400)])
}

func minLen(a, b int) int {
	if a < b {
		return a
	}
	return b
}
