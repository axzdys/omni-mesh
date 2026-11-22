//go:build windows
// +build windows

package pty

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	modkernel32Pty          = syscall.NewLazyDLL("kernel32.dll")
	procCreatePseudoConsole = modkernel32Pty.NewProc("CreatePseudoConsole")
	procResizePseudoConsole = modkernel32Pty.NewProc("ResizePseudoConsole")
	procClosePseudoConsole  = modkernel32Pty.NewProc("ClosePseudoConsole")
	procInitializeAttrList  = modkernel32Pty.NewProc("InitializeProcThreadAttributeList")
	procUpdateAttrList      = modkernel32Pty.NewProc("UpdateProcThreadAttribute")
	procDeleteAttrList      = modkernel32Pty.NewProc("DeleteProcThreadAttributeList")
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
	createUnicodeEnvironment         = 0x00000400
	infinite                         = 0xFFFFFFFF
)

func packCoord(cols, rows uint16) uintptr {
	return uintptr(uint16(cols)) | uintptr(uint16(rows))<<16
}

// startupInfoEx mirrors C STARTUPINFOEXW (StartupInfo + attribute list ptr).
type startupInfoEx struct {
	syscall.StartupInfo
	attrList uintptr
}

// windowsSession implements Session over a real ConPTY.
type windowsSession struct {
	id      string
	hpc     syscall.Handle
	inWrite syscall.Handle
	outRead syscall.Handle
	proc    syscall.Handle
	done    chan struct{}
	once    sync.Once
	mu      sync.Mutex
}

func openConPTY(id string, cols, rows uint16, shell string) (Session, error) {
	var inRead, inWrite, outRead, outWrite syscall.Handle
	if err := syscall.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("create input pipe: %w", err)
	}
	if err := syscall.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		return nil, fmt.Errorf("create output pipe: %w", err)
	}

	var hpc syscall.Handle
	hr, _, _ := procCreatePseudoConsole.Call(
		packCoord(cols, rows),
		uintptr(inRead),
		uintptr(outWrite),
		0,
		uintptr(unsafe.Pointer(&hpc)),
	)
	if hr != 0 {
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		syscall.CloseHandle(outWrite)
		return nil, fmt.Errorf("CreatePseudoConsole failed: hr=0x%08x", hr)
	}
	// ConPTY duplicates the pipe handles on its side (per the official sample)
	syscall.CloseHandle(inRead)
	syscall.CloseHandle(outWrite)

	if shell == "" {
		shell = os.Getenv("COMSPEC")
		if shell == "" {
			shell = `C:\Windows\System32\cmd.exe`
		}
	}
	cmdLine, err := syscall.UTF16PtrFromString(shell)
	if err != nil {
		closePty(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, err
	}

	var attrSize uintptr
	procInitializeAttrList.Call(0, 1, 0, uintptr(unsafe.Pointer(&attrSize)))
	if attrSize == 0 {
		closePty(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("InitializeProcThreadAttributeList did not report a buffer size")
	}
	attrBuf := make([]byte, attrSize)
	attrList := uintptr(unsafe.Pointer(&attrBuf[0]))
	r1, _, _ := procInitializeAttrList.Call(attrList, 1, 0, uintptr(unsafe.Pointer(&attrSize)))
	if r1 == 0 {
		closePty(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("InitializeProcThreadAttributeList failed")
	}
	r1, _, _ = procUpdateAttrList.Call(
		attrList,
		0,
		procThreadAttributePseudoConsole,
		uintptr(unsafe.Pointer(&hpc)),
		unsafe.Sizeof(hpc),
		0,
		0,
	)
	if r1 == 0 {
		procDeleteAttrList.Call(attrList)
		closePty(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("UpdateProcThreadAttribute failed")
	}

	siEx := &startupInfoEx{}
	siEx.Cb = uint32(unsafe.Sizeof(*siEx)) // sizeof(STARTUPINFOEXW)
	siEx.attrList = attrList

	var pi syscall.ProcessInformation
	err = syscall.CreateProcess(
		nil,
		cmdLine,
		nil,
		nil,
		false,
		extendedStartupInfoPresent|createUnicodeEnvironment,
		nil,
		nil,
		(*syscall.StartupInfo)(unsafe.Pointer(siEx)),
		&pi,
	)
	procDeleteAttrList.Call(attrList)
	if err != nil {
		closePty(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("start shell %q: %w", shell, err)
	}
	syscall.CloseHandle(pi.Thread)

	s := &windowsSession{
		id:      id,
		hpc:     hpc,
		inWrite: inWrite,
		outRead: outRead,
		proc:    pi.Process,
		done:    make(chan struct{}),
	}

	go func() {
		_, _ = syscall.WaitForSingleObject(pi.Process, infinite)
		s.once.Do(func() { close(s.done) })
	}()
	return s, nil
}

func closePty(hpc syscall.Handle) {
	procClosePseudoConsole.Call(uintptr(hpc))
}

func (s *windowsSession) ID() string { return s.id }

func (s *windowsSession) Resize(cols, rows uint16) error {
	hr, _, _ := procResizePseudoConsole.Call(uintptr(s.hpc), packCoord(cols, rows))
	if hr != 0 {
		return fmt.Errorf("ResizePseudoConsole failed: hr=0x%08x", hr)
	}
	return nil
}

func (s *windowsSession) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for n < len(b) {
		m, err := syscall.Write(s.inWrite, b[n:])
		if err != nil {
			return n, err
		}
		if m == 0 {
			break
		}
		n += m
	}
	return n, nil
}

func (s *windowsSession) Read(b []byte) (int, error) {
	return syscall.Read(s.outRead, b)
}

func (s *windowsSession) Done() <-chan struct{} { return s.done }

func (s *windowsSession) Close() error {
	s.once.Do(func() { close(s.done) })
	_ = syscall.TerminateProcess(s.proc, 1)
	closePty(s.hpc)
	_ = syscall.CloseHandle(s.inWrite)
	_ = syscall.CloseHandle(s.outRead)
	_ = syscall.CloseHandle(s.proc)
	return nil
}

var _ = time.Now
