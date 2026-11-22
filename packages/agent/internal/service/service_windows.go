//go:build windows
// +build windows

// Windows service management via the Service Control Manager (advapi32
// raw syscalls, pure stdlib).
package service

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

const (
	scManagerAllAccess   = 0xF003F
	serviceAllAccess     = 0xF01FF
	serviceWin32OwnProc  = 0x10
	serviceAutoStart     = 3
	serviceErrorNormal   = 1
	serviceStopped       = 1
	serviceStartPending  = 2
	serviceRunning       = 4
	serviceAcceptStop    = 1
	serviceAcceptShutdown = 8
)

var (
	modadvapi32                  = syscall.NewLazyDLL("advapi32.dll")
	procOpenSCManagerW           = modadvapi32.NewProc("OpenSCManagerW")
	procCreateServiceW           = modadvapi32.NewProc("CreateServiceW")
	procOpenServiceW             = modadvapi32.NewProc("OpenServiceW")
	procStartServiceW            = modadvapi32.NewProc("StartServiceW")
	procDeleteService            = modadvapi32.NewProc("DeleteService")
	procCloseServiceHandle       = modadvapi32.NewProc("CloseServiceHandle")
	procStartServiceCtrlDispatch = modadvapi32.NewProc("StartServiceCtrlDispatcherW")
	procRegisterCtrlHandlerEx    = modadvapi32.NewProc("RegisterServiceCtrlHandlerExW")
	procSetServiceStatus         = modadvapi32.NewProc("SetServiceStatus")
)

type serviceStatus struct {
	serviceType             uint32
	currentState            uint32
	controlsAccepted        uint32
	win32ExitCode           uint32
	serviceSpecificExitCode uint32
	checkPoint              uint32
	waitHint                uint32
}

type serviceTableEntry struct {
	name *uint16
	proc uintptr
}

const serviceName = "OmniMeshAgent"

var stopOnce sync.Once
var stopChan chan struct{}

// Install registers the service (auto-start, runs `<exe> --service-run`).
func Install() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	binPath := fmt.Sprintf(`"%s" --service-run`, exe)
	sc, _, err2 := procOpenSCManagerW.Call(0, 0, scManagerAllAccess)
	if sc == 0 {
		return fmt.Errorf("OpenSCManager failed: %v (run as Administrator)", err2)
	}
	defer procCloseServiceHandle.Call(sc)
	name, _ := syscall.UTF16PtrFromString(serviceName)
	display, _ := syscall.UTF16PtrFromString("OmniMesh Edge Agent")
	path, _ := syscall.UTF16PtrFromString(binPath)
	svc, _, err2 := procCreateServiceW.Call(
		sc,
		uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(display)),
		serviceAllAccess,
		serviceWin32OwnProc,
		serviceAutoStart,
		serviceErrorNormal,
		uintptr(unsafe.Pointer(path)),
		0, 0, 0, 0, 0,
	)
	if svc == 0 {
		return fmt.Errorf("CreateService failed: %v (running as service already?)", err2)
	}
	defer procCloseServiceHandle.Call(svc)
	// start it right away
	if r, _, _ := procStartServiceW.Call(svc, 0, 0); r == 0 {
		return fmt.Errorf("service created but StartService failed (check config with --config)")
	}
	return nil
}

// Uninstall removes the service.
func Uninstall() error {
	sc, _, err2 := procOpenSCManagerW.Call(0, 0, scManagerAllAccess)
	if sc == 0 {
		return fmt.Errorf("OpenSCManager failed: %v", err2)
	}
	defer procCloseServiceHandle.Call(sc)
	name, _ := syscall.UTF16PtrFromString(serviceName)
	svc, _, err2 := procOpenServiceW.Call(sc, serviceAllAccess, uintptr(unsafe.Pointer(name)))
	if svc == 0 {
		return fmt.Errorf("service not found: %v", err2)
	}
	defer procCloseServiceHandle.Call(svc)
	if r, _, _ := procDeleteService.Call(svc); r == 0 {
		return fmt.Errorf("DeleteService failed")
	}
	return nil
}

// RunAsService runs the agent under SCM control (used with --service-run).
func RunAsService(run func(stop <-chan struct{}) error) error {
	stopChan = make(chan struct{})
	mainCallback := syscall.NewCallback(func(argc uintptr, argv uintptr) uintptr {
		return serviceMain(run)
	})
	table := []serviceTableEntry{
		{nil, mainCallback},
		{nil, 0},
	}
	name, _ := syscall.UTF16PtrFromString(serviceName)
	table[0].name = name
	if r, _, err2 := procStartServiceCtrlDispatch.Call(uintptr(unsafe.Pointer(&table[0]))); r == 0 {
		return fmt.Errorf("StartServiceCtrlDispatcher failed: %v (must run as a service, not interactively)", err2)
	}
	return nil
}

func serviceMain(run func(stop <-chan struct{}) error) uintptr {
	name, _ := syscall.UTF16PtrFromString(serviceName)
	ctrlCallback := syscall.NewCallback(func(ctl uintptr, evType uintptr, evData uintptr, ctx uintptr) uintptr {
		switch ctl {
		case 1: // SERVICE_CONTROL_STOP
			stopOnce.Do(func() { close(stopChan) })
			return 1
		case 5: // SERVICE_CONTROL_SHUTDOWN
			stopOnce.Do(func() { close(stopChan) })
			return 1
		}
		return 1
	})
	handle, _, _ := procRegisterCtrlHandlerEx.Call(uintptr(unsafe.Pointer(name)), ctrlCallback, 0)
	if handle == 0 {
		return 1
	}

	report := func(state, controls, exitCode uint32) {
		st := serviceStatus{
			serviceType:      serviceWin32OwnProc,
			currentState:     state,
			controlsAccepted: controls,
			win32ExitCode:    exitCode,
			waitHint:         5000,
		}
		procSetServiceStatus.Call(handle, uintptr(unsafe.Pointer(&st)))
	}

	report(serviceStartPending, 0, 0)
	// report RUNNING immediately so SCM doesn't kill us while we initialize
	report(serviceRunning, serviceAcceptStop|serviceAcceptShutdown, 0)
	err := run(stopChan)
	code := uint32(0)
	if err != nil {
		code = 1
	}
	report(serviceStopped, 0, code)
	return 0
}
