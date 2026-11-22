// Package pty provides cross-platform pseudo-terminal sessions for WebSSH:
// Linux via /dev/ptmx ioctls and Windows via ConPTY — both implemented with
// the Go standard library only (no external dependencies).
package pty

import (
	"fmt"
	"sync"
)

// Session is one interactive shell attached to a PTY.
type Session interface {
	ID() string
	// Resize updates the terminal size.
	Resize(cols, rows uint16) error
	// Write sends bytes to the shell's stdin.
	Write(b []byte) (int, error)
	// Read receives bytes from the shell's stdout/stderr (blocking).
	Read(b []byte) (int, error)
	// Close kills the shell and releases the PTY. Idempotent.
	Close() error
	// Done is closed when the shell process exits.
	Done() <-chan struct{}
}

// Manager tracks live sessions by id.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]Session
}

func NewManager() *Manager {
	return &Manager{sessions: make(map[string]Session)}
}

// Open spawns a shell in a new PTY.
func (m *Manager) Open(id string, cols, rows uint16, shell string) (Session, error) {
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	s, err := openSession(id, cols, rows, shell)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	// supersede any existing session with the same id
	if old, ok := m.sessions[id]; ok {
		_ = old.Close()
	}
	m.sessions[id] = s
	m.mu.Unlock()
	return s, nil
}

// Get returns a live session.
func (m *Manager) Get(id string) (Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	return s, ok
}

// Close terminates a session and removes it.
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("no such pty session: %s", id)
	}
	return s.Close()
}

// List returns the ids of all live sessions (diagnostics).
func (m *Manager) List() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	return ids
}

// CloseAll terminates every session (used on disconnect).
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Close(id)
	}
}
