// Package runner executes scripts/commands on behalf of the control plane,
// streaming stdout/stderr chunks and enforcing timeouts with process-tree
// kills on all platforms.
package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ExecRequest is the runner-level request (mirrors protocol.ExecReqPayload).
type ExecRequest struct {
	TaskID    string
	Script    string
	Lang      string            // shell | python
	WorkDir   string            // optional
	Env       map[string]string // extra env vars
	TimeoutMs int64
}

// Result mirrors protocol.ExecResultPayload.
type Result struct {
	TaskID     string
	ExitCode   *int
	Signal     *string
	DurationMs int64
	Error      string
	Log        []byte // combined stdout+stderr (capped at maxResultLog)
}

// StreamFn receives stdout/stderr chunks ("out"/"err").
type StreamFn func(stream string, data []byte)

const (
	chunkSize    = 32 * 1024
	maxBuffered  = 64 * 1024 * 1024 // safety cap per stream
	// maxResultLog caps the combined log shipped in EXEC_RESULT: after base64
	// it must stay well under the 1MiB WebSocket message limit.
	maxResultLog = 512 * 1024
)

// Executor runs commands.
type Executor struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc // taskID -> cancel
}

func New() *Executor {
	return &Executor{running: make(map[string]context.CancelFunc)}
}

// Cancel kills a running task (no-op when unknown).
func (e *Executor) Cancel(taskID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if cancel, ok := e.running[taskID]; ok {
		cancel()
		return true
	}
	return false
}

// Running returns the number of active tasks.
func (e *Executor) Running() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.running)
}

// Run executes the request synchronously, streaming chunks via StreamFn and
// returning a final Result.
func (e *Executor) Run(req ExecRequest, stream StreamFn) Result {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), timeoutOrDefault(req.TimeoutMs))
	defer func() {
		cancel()
		e.mu.Lock()
		delete(e.running, req.TaskID)
		e.mu.Unlock()
	}()
	e.mu.Lock()
	e.running[req.TaskID] = cancel
	e.mu.Unlock()

	cmd, cleanup, err := buildCommand(ctx, req)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		return Result{TaskID: req.TaskID, Error: err.Error(), DurationMs: ms(start)}
	}
	if req.WorkDir != "" {
		cmd.Dir = req.WorkDir
	}
	cmd.Env = mergedEnv(req.Env)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{TaskID: req.TaskID, Error: err.Error(), DurationMs: ms(start)}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{TaskID: req.TaskID, Error: err.Error(), DurationMs: ms(start)}
	}
	if err := cmd.Start(); err != nil {
		return Result{TaskID: req.TaskID, Error: err.Error(), DurationMs: ms(start)}
	}

	// accumulate a capped copy of the combined output for EXEC_RESULT while
	// still streaming every chunk upstream
	var logMu sync.Mutex
	var logBuf []byte
	wrappedStream := func(s string, data []byte) {
		logMu.Lock()
		if len(logBuf) < maxResultLog {
			room := maxResultLog - len(logBuf)
			if len(data) > room {
				data = data[:room]
			}
			logBuf = append(logBuf, data...)
		}
		logMu.Unlock()
		if stream != nil {
			stream(s, data)
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pump(stdout, "out", wrappedStream) }()
	go func() { defer wg.Done(); pump(stderr, "err", wrappedStream) }()

	waitErr := cmd.Wait()
	wg.Wait()

	res := Result{TaskID: req.TaskID, DurationMs: ms(start)}
	logMu.Lock()
	res.Log = logBuf
	logMu.Unlock()
	if ctx.Err() == context.DeadlineExceeded {
		res.Error = "timeout"
		return res
	}
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			code := exitErr.ExitCode()
			res.ExitCode = &code
			if code == -1 {
				res.Error = "terminated"
			}
		} else {
			res.Error = waitErr.Error()
		}
	} else {
		code := 0
		res.ExitCode = &code
	}
	return res
}

func timeoutOrDefault(msv int64) time.Duration {
	if msv <= 0 {
		return 10 * time.Minute
	}
	return time.Duration(msv) * time.Millisecond
}

func pump(r interface{ Read([]byte) (int, error) }, stream string, fn StreamFn) {
	buf := make([]byte, chunkSize)
	total := 0
	for {
		n, err := r.Read(buf)
		if n > 0 && fn != nil && total < maxBuffered {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			fn(stream, chunk)
			total += n
		}
		if err != nil {
			return
		}
	}
}

func ms(start time.Time) int64 { return time.Since(start).Milliseconds() }

// buildCommand assembles the platform-appropriate command. python requests
// are written to a temp file so multi-line scripts work identically on both
// platforms. The returned cleanup removes that temp file.
func buildCommand(ctx context.Context, req ExecRequest) (*exec.Cmd, func(), error) {
	lang := strings.ToLower(req.Lang)
	if lang == "python" || lang == "python3" {
		py := "python3"
		if runtime.GOOS == "windows" {
			py = "python"
		}
		if p, err := exec.LookPath(py); err == nil {
			py = p
		} else if runtime.GOOS != "windows" {
			py = "python3"
		}
		dir := os.TempDir()
		ext := ".py"
		if runtime.GOOS == "windows" {
			dir = os.TempDir()
		}
		tmp, err := os.CreateTemp(dir, "omni-task-*"+ext)
		if err != nil {
			return nil, nil, fmt.Errorf("temp script: %w", err)
		}
		if _, err := tmp.WriteString(req.Script); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return nil, nil, fmt.Errorf("write script: %w", err)
		}
		tmp.Close()
		cleanup := func() { os.Remove(tmp.Name()) }
		cmd := exec.CommandContext(ctx, py, "-u", tmp.Name())
		return cmd, cleanup, nil
	}
	// shell
	if runtime.GOOS == "windows" {
		comspec := os.Getenv("COMSPEC")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		return exec.CommandContext(ctx, comspec, "/d", "/s", "/c", req.Script), nil, nil
	}
	shell := os.Getenv("OMNI_SHELL")
	if shell == "" {
		shell = "/bin/sh"
		if _, err := os.Stat("/bin/bash"); err == nil {
			shell = "/bin/bash"
		}
	}
	return exec.CommandContext(ctx, shell, "-c", req.Script), nil, nil
}

func mergedEnv(extra map[string]string) []string {
	env := os.Environ()
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
