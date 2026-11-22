//go:build windows
// +build windows

package pty

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// pipeSession is a fallback "PTY" that drives the shell through plain OS
// pipes (no conhost). It works on every Windows build — including ones where
// the ConPTY driver misbehaves (some 24H2+ builds report STATUS_DLL_INIT_FAILED
// when attaching a client to a pseudoconsole) — at the cost of losing
// per-keystroke echo and terminal resize control.
type pipeSession struct {
	id       string
	cmd      *exec.Cmd
	stdin    chan []byte
	mu       sync.Mutex
	out      chan []byte
	done     chan struct{}
	once     sync.Once
	closed   chan struct{}
}

func openPipeSession(id string, cols, rows uint16, shell string) (Session, error) {
	if shell == "" {
		shell = os.Getenv("COMSPEC")
		if shell == "" {
			shell = `C:\Windows\System32\cmd.exe`
		}
	}
	cmd := exec.Command(shell, "/Q", "/K", "PROMPT $P$G") // /Q: cmd stays silent (agent echoes input locally), /K: keeps the prompt visible
	// Command consoles created without a window: keep it invisible
	cmd.SysProcAttr = hideWindowAttr()

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start pipe shell %q: %w", shell, err)
	}

	s := &pipeSession{
		id:     id,
		cmd:    cmd,
		stdin:  make(chan []byte, 32),
		out:    make(chan []byte, 128),
		done:   make(chan struct{}),
		closed: make(chan struct{}),
	}

	// Tell the viewer this is a pipe-mode terminal (no PTY line discipline —
	// backspace editing must happen on the dashboard side via line mode).
	go func() {
		time.Sleep(300 * time.Millisecond)
		select {
		case s.out <- []byte("\r\n[omni] pipe terminal: 建议在工具栏开启「行模式」后再输入（支持退格编辑）\r\n\r\n"):
		case <-s.closed:
		}
	}()

	// stdin pump: Write() enqueues, a single goroutine drains the pipe
	go func() {
		for {
			select {
			case <-s.closed:
				return
			case b := <-s.stdin:
				if _, err := stdinPipe.Write(b); err != nil {
					log.Printf("[pty-pipe %s] stdin write error: %v", id, err)
					return
				} else {
					log.Printf("[pty-pipe %s] stdin wrote %d bytes", id, len(b))
				}
			}
		}
	}()

	// stdout + stderr pump
	pump := func(r interface{ Read([]byte) (int, error) }, tag string) {
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				select {
				case s.out <- chunk:
				case <-s.closed:
					return
				}
			}
			if err != nil {
				log.Printf("[pty-pipe %s] %s read ended: %v", id, tag, err)
				return
			}
		}
	}
	go pump(stdoutPipe, "stdout")
	go pump(stderrPipe, "stderr")

	go func() {
		werr := cmd.Wait()
		log.Printf("[pty-pipe %s] shell exited: %v", id, werr)
		s.once.Do(func() { close(s.done) })
	}()
	return s, nil
}

func (s *pipeSession) ID() string { return s.id }

func (s *pipeSession) Resize(cols, rows uint16) error {
	return nil // not supported without ConPTY
}

func (s *pipeSession) Write(b []byte) (int, error) {
	// normalize bare CR (what xterm sends for Enter) to CRLF for cmd
	normalized := make([]byte, 0, len(b)+4)
	for i := 0; i < len(b); i++ {
		if b[i] == '\r' && (i+1 >= len(b) || b[i+1] != '\n') {
			normalized = append(normalized, '\r', '\n')
		} else {
			normalized = append(normalized, b[i])
		}
	}
	chunk := make([]byte, len(normalized))
	copy(chunk, normalized)
	// local echo: pipe shells have no PTY line discipline, so typed characters
	// would be invisible. Mirror them to the output stream — printable chars
	// as-is, CR rendered as CRLF, backspace as the destructive sequence.
	s.echo(chunk)
	select {
	case s.stdin <- chunk:
		return len(normalized), nil
	case <-time.After(5 * time.Second):
		return 0, fmt.Errorf("pipe stdin timeout")
	}
}

// echo mirrors input bytes to the output channel so the viewer sees what they
// type. Backspace becomes "\b \b" (destructive) which xterm renders correctly.
func (s *pipeSession) echo(b []byte) {
	out := make([]byte, 0, len(b)+8)
	for _, c := range b {
		switch c {
		case '\r':
			out = append(out, '\r', '\n')
		case '\b', 0x7f:
			out = append(out, '\b', ' ', '\b')
		default:
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return
	}
	select {
	case s.out <- out:
	case <-time.After(2 * time.Second):
		/* viewer slow; drop echo rather than block stdin */
	}
}

func (s *pipeSession) Read(b []byte) (int, error) {
	select {
	case chunk := <-s.out:
		n := copy(b, chunk)
		return n, nil
	case <-s.done:
		return 0, fmt.Errorf("shell exited")
	case <-s.closed:
		return 0, fmt.Errorf("session closed")
	}
}

func (s *pipeSession) Done() <-chan struct{} { return s.done }

func (s *pipeSession) Close() error {
	s.once.Do(func() { close(s.done) })
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	if s.cmd.Process != nil {
		_ = killProcessTreeWindows(s.cmd.Process.Pid)
	}
	return nil
}

func hideWindowAttr() *syscall.SysProcAttr {
	// NOTE: no CREATE_NO_WINDOW here — cmd.exe refuses to process
	// interactive stdin when it has no console. In service mode (session 0)
	// any allocated console is invisible to the user anyway.
	return &syscall.SysProcAttr{}
}

// killProcessTreeWindows terminates pid and all descendants via taskkill.
func killProcessTreeWindows(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("bad pid")
	}
	cmd := exec.Command("taskkill", "/F", "/T", "/PID", fmt.Sprint(pid))
	_ = cmd.Run()
	return nil
}
