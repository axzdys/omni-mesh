// Package backoff implements exponential backoff with full jitter for
// agent reconnects.
package backoff

import (
	"context"
	"math"
	"math/rand"
	"time"
)

// Backoff grows exponentially from Min to Max, resetting after a success.
type Backoff struct {
	Min     time.Duration
	Max     time.Duration
	attempt int
	rnd     *rand.Rand
}

func New(min, max time.Duration) *Backoff {
	return &Backoff{Min: min, Max: max, rnd: rand.New(rand.NewSource(time.Now().UnixNano()))}
}

// Reset returns to the minimum delay after a successful connection.
func (b *Backoff) Reset() { b.attempt = 0 }

// Next sleeps for a jittered exponential delay. Honors context cancellation.
func (b *Backoff) Next(ctx context.Context) error {
	b.attempt++
	d := b.Delay()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Delay returns the raw jittered delay without sleeping (testable).
func (b *Backoff) Delay() time.Duration {
	a := b.attempt
	if a < 1 {
		a = 1
	}
	exp := float64(b.Min) * math.Pow(2, float64(a-1))
	if exp > float64(b.Max) || exp <= 0 {
		exp = float64(b.Max)
	}
	// full jitter: uniform in [min, exp]
	jitter := float64(b.Min) + b.rnd.Float64()*(exp-float64(b.Min))
	return time.Duration(jitter)
}

// Attempt exposes the current attempt counter.
func (b *Backoff) Attempt() int { return b.attempt }
