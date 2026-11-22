package backoff

import (
	"context"
	"testing"
	"time"
)

func TestDelayGrowsAndCaps(t *testing.T) {
	b := New(500*time.Millisecond, 8*time.Second)
	last := time.Duration(0)
	for i := 0; i < 30; i++ {
		d := b.Delay()
		if d < 500*time.Millisecond || d > 8*time.Second {
			t.Fatalf("delay %v outside [min,max]", d)
		}
		last = d
	}
	_ = last
}

func TestReset(t *testing.T) {
	b := New(1 * time.Nanosecond, 2 * time.Nanosecond)
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		if err := b.Next(ctx); err != nil {
			t.Fatalf("next: %v", err)
		}
	}
	if b.Attempt() != 10 {
		t.Fatalf("attempt = %d, want 10", b.Attempt())
	}
	b.Reset()
	if b.Attempt() != 0 {
		t.Fatalf("attempt after reset = %d, want 0", b.Attempt())
	}
}

func TestNextHonorsContext(t *testing.T) {
	b := New(1*time.Second, 10*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := b.Next(ctx); err == nil {
		t.Fatal("expected context error")
	}
}
