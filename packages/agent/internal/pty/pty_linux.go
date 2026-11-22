//go:build linux
// +build linux

// Linux PTY backend: /dev/ptmx + /dev/pts/N via raw ioctls (pure stdlib).
package pty

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"unsafe"
)

const (
	ioctlTIOCGPTN   = 0x80045430 // get pty number
	ioctlTIOCSPTLCK = 0x40045431 // set pty lock (0 = unlock)
	ioctlTIOCSWINSZ = 0x5414     // set window size
	ioctlTIOCSCTTY  = 0x540E     // set controlling terminal
)

type winsize struct {
	rows   uint16
	cols   uint16
	xpixel uint16
	ypixel uint16
}

func ioctl(fd uintptr, req uintptr, arg uintptr) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg)
	if errno != 0 {
		return errno
	}
	return nil
}

// linuxSession implements Session.
type linuxSession struct {
	id     string
	master *os.File
	slave  *os.File
	cmd    *exec.Cmd
	done   chan struct{}
	once   sync.Once
	mu     sync.Mutex
}

func openSession(id string, cols, rows uint16, shell string) (Session, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	// get slave number
	var n uint32
	if err := ioctl(master.Fd(), ioctlTIOCGPTN, uintptr(unsafe.Pointer(&n))); err != nil {
		master.Close()
		return nil, fmt.Errorf("TIOCGPTN: %w", err)
	}
	// unlock the slave
	var zero uint32
	if err := ioctl(master.Fd(), ioctlTIOCSPTLCK, uintptr(unsafe.Pointer(&zero))); err != nil {
		master.Close()
		return nil, fmt.Errorf("TIOCSPTLCK: %w", err)
	}
	slavePath := "/dev/pts/" + strconv.FormatUint(uint64(n), 10)
	slave, err := os.OpenFile(slavePath, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		return nil, fmt.Errorf("open %s: %w", slavePath, err)
	}

	// initial window size
	if err := ioctl(master.Fd(), ioctlTIOCSWINSZ, uintptr(unsafe.Pointer(&winsize{rows: rows, cols: cols}))); err != nil {
		master.Close()
		slave.Close()
		return nil, fmt.Errorf("TIOCSWINSZ: %w", err)
	}

	if shell == "" {
		shell = detectShell()
	}

	cmd := exec.Command(shell)
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "OMNI=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true, // new session, detach from our controlling terminal
		Setctty: true,
		Ctty:    0, // index into (stdin,stdout,stderr) -> the slave
	}

	s := &linuxSession{id: id, master: master, slave: slave, cmd: cmd, done: make(chan struct{})}
	if err := cmd.Start(); err != nil {
		master.Close()
		slave.Close()
		return nil, fmt.Errorf("start shell %q: %w", shell, err)
	}

	go func() {
		_ = cmd.Wait()
		// release the master so Read returns EOF
		_ = master.Close()
		s.once.Do(func() { close(s.done) })
	}()
	return s, nil
}

func detectShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	for _, c := range []string{"/bin/bash", "/bin/sh", "/bin/ash", "/bin/dash"} {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "/bin/sh"
}

func (s *linuxSession) ID() string { return s.id }

func (s *linuxSession) Resize(cols, rows uint16) error {
	return ioctl(s.master.Fd(), ioctlTIOCSWINSZ, uintptr(unsafe.Pointer(&winsize{rows: rows, cols: cols})))
}

func (s *linuxSession) Write(b []byte) (int, error) {
	return s.master.Write(b)
}

func (s *linuxSession) Read(b []byte) (int, error) {
	return s.master.Read(b)
}

func (s *linuxSession) Done() <-chan struct{} { return s.done }

func (s *linuxSession) Close() error {
	s.once.Do(func() {
		// kill the whole process group of the shell
		if s.cmd.Process != nil {
			_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
			_ = s.cmd.Process.Kill()
		}
	})
	_ = s.master.Close()
	_ = s.slave.Close()
	return nil
}
