package runner

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

func shellScript(cmd string) string {
	if runtime.GOOS == "windows" {
		return cmd
	}
	return cmd
}

func collect(r Result, chunks []string) (out string, errText string) {
	var b strings.Builder
	for _, c := range chunks {
		b.WriteString(c)
	}
	return b.String(), r.Error
}

func TestRunEcho(t *testing.T) {
	e := New()
	var chunks []string
	var res Result
	done := make(chan struct{})
	go func() {
		res = e.Run(ExecRequest{TaskID: "t1", Script: shellScript("echo hello-omnimesh"), Lang: "shell", TimeoutMs: 10000}, func(stream string, data []byte) {
			if stream == "out" {
				chunks = append(chunks, string(data))
			}
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("timeout waiting for run")
	}
	out, errText := collect(res, chunks)
	if errText != "" {
		t.Fatalf("unexpected error: %s", errText)
	}
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("exit code = %v", res.ExitCode)
	}
	if !strings.Contains(out, "hello-omnimesh") {
		t.Fatalf("output missing: %q", out)
	}
}

func TestRunFailingCommand(t *testing.T) {
	e := New()
	var res Result
	var script string
	if runtime.GOOS == "windows" {
		script = "cmd /c exit 7"
	} else {
		script = "exit 7"
	}
	res = e.Run(ExecRequest{TaskID: "t2", Script: script, Lang: "shell", TimeoutMs: 10000}, nil)
	if res.ExitCode == nil || *res.ExitCode != 7 {
		t.Fatalf("exit code = %v, want 7", res.ExitCode)
	}
}

func TestRunTimeout(t *testing.T) {
	e := New()
	var script string
	if runtime.GOOS == "windows" {
		script = "ping -n 30 127.0.0.1 > NUL"
	} else {
		script = "sleep 30"
	}
	start := time.Now()
	res := e.Run(ExecRequest{TaskID: "t3", Script: script, Lang: "shell", TimeoutMs: 800}, nil)
	elapsed := time.Since(start)
	if res.Error != "timeout" {
		t.Fatalf("error = %q, want timeout", res.Error)
	}
	if elapsed > 6*time.Second {
		t.Fatalf("timeout kill took too long: %v", elapsed)
	}
}

func TestEnvInjection(t *testing.T) {
	e := New()
	var out string
	var script string
	if runtime.GOOS == "windows" {
		script = "echo %OMNI_TEST_VAR%"
	} else {
		script = "echo $OMNI_TEST_VAR"
	}
	res := e.Run(ExecRequest{TaskID: "t4", Script: script, Lang: "shell", TimeoutMs: 10000, Env: map[string]string{"OMNI_TEST_VAR": "injected-42"}}, func(stream string, data []byte) {
		out += string(data)
	})
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("exit = %v err=%v", res.ExitCode, res.Error)
	}
	if !strings.Contains(out, "injected-42") {
		t.Fatalf("env not injected: %q", out)
	}
}

func TestCancel(t *testing.T) {
	e := New()
	var script string
	if runtime.GOOS == "windows" {
		script = "ping -n 30 127.0.0.1 > NUL"
	} else {
		script = "sleep 30"
	}
	done := make(chan Result, 1)
	go func() {
		done <- e.Run(ExecRequest{TaskID: "t5", Script: script, Lang: "shell", TimeoutMs: 60000}, nil)
	}()
	time.Sleep(300 * time.Millisecond)
	if !e.Cancel("t5") {
		t.Fatal("cancel returned false")
	}
	select {
	case res := <-done:
		if res.Error == "" && res.ExitCode == nil {
			t.Fatalf("expected terminated result: %+v", res)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancel did not terminate the task")
	}
}
