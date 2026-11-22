//go:build windows
// +build windows

// ConPTY session dispatch with transparent fallback.
//
// Some Windows 11 24H2+ builds exhibit STATUS_DLL_INIT_FAILED (0xC0000142)
// when a client process attaches to a pseudoconsole created by this host.
// In that mode the client dies instantly and ConPTY produces no output.
// We therefore probe the freshly created ConPTY for banner output during a
// short grace window; on silence we tear it down and fall back to a pipe
// session (cmd.exe driven through stdin/stdout pipes — fully functional for
// interactive commands, without ANSI resize control).
package pty

import (
	"os"
	"time"
)

func openSession(id string, cols, rows uint16, shell string) (Session, error) {
	if os.Getenv("OMNI_FORCE_PIPE_PTY") == "1" {
		return openPipeSession(id, cols, rows, shell)
	}

	s, err := openConPTY(id, cols, rows, shell)
	if err != nil {
		return openPipeSession(id, cols, rows, shell)
	}

	// grace probe: wait up to 2.5s for the first bytes of shell output
	type readResult struct {
		n   int
		err error
	}
	probe := make([]byte, 512)
	ch := make(chan readResult, 1)
	go func() {
		n, rerr := s.Read(probe)
		ch <- readResult{n, rerr}
	}()

	select {
	case r := <-ch:
		if r.err == nil || r.n > 0 {
			if r.n > 0 {
				replay := &probeReplaySession{Session: s, pending: make([]byte, 0, r.n)}
				replay.pending = append(replay.pending, probe[:r.n]...)
				return replay, nil
			}
			return s, nil
		}
		_ = s.Close()
		return openPipeSession(id, cols, rows, shell)
	case <-time.After(2500 * time.Millisecond):
		// No output at all — ConPTY client almost certainly died (0xC0000142
		// mode: conhost holds the pipe open forever while the shell is dead).
		_ = s.Close()
		return openPipeSession(id, cols, rows, shell)
	}
}

// probeReplaySession replays bytes consumed by the health probe before
// handing out fresh reads.
type probeReplaySession struct {
	Session
	mu      chan struct{} // acts as a mutex around pending
	pending []byte
}

func (p *probeReplaySession) lock() func() {
	if p.mu == nil {
		p.mu = make(chan struct{}, 1)
	}
	p.mu <- struct{}{}
	return func() { <-p.mu }
}

func (p *probeReplaySession) Read(b []byte) (int, error) {
	unlock := p.lock()
	if len(p.pending) > 0 {
		n := copy(b, p.pending)
		p.pending = p.pending[n:]
		unlock()
		return n, nil
	}
	unlock()
	return p.Session.Read(b)
}

func (p *probeReplaySession) Close() error {
	unlock := p.lock()
	p.pending = nil
	unlock()
	return p.Session.Close()
}
