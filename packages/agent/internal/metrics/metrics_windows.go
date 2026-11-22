//go:build windows
// +build windows

// Windows metrics collector using raw syscalls only (no external deps):
//   - CPU:      kernel32!GetSystemTimes
//   - Memory:   kernel32!GlobalMemoryStatusEx
//   - Network:  iphlpapi!GetIfTable (MIB_IFTABLE)
//   - Disks:    kernel32!GetDiskFreeSpaceExW + GetDriveTypeW
//   - Uptime:   kernel32!GetTickCount64
package metrics

import (
	"syscall"
	"time"
	"unsafe"
)

var (
	modkernel32             = syscall.NewLazyDLL("kernel32.dll")
	modiphlpapi             = syscall.NewLazyDLL("iphlpapi.dll")
	procGlobalMemoryStatusEx = modkernel32.NewProc("GlobalMemoryStatusEx")
	procGetSystemTimes       = modkernel32.NewProc("GetSystemTimes")
	procGetTickCount64       = modkernel32.NewProc("GetTickCount64")
	procGetDiskFreeSpaceExW  = modkernel32.NewProc("GetDiskFreeSpaceExW")
	procGetLogicalDrives     = modkernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW        = modkernel32.NewProc("GetDriveTypeW")
	procGetIfTable           = modiphlpapi.NewProc("GetIfTable")
)

type memoryStatusEx struct {
	dwLength                uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

type filetime struct {
	dwLowDateTime  uint32
	dwHighDateTime uint32
}

func (f filetime) value() uint64 {
	return uint64(f.dwHighDateTime)<<32 | uint64(f.dwLowDateTime)
}

const (
	maxInterfaceNameLen = 256
	maxlenPhysAddr      = 8
	maxlenIfDescr       = 256
	// INTERNAL_IF_OPER_STATUS: IF_OPERATIONAL = 5 (0=non-op, 1=unreachable, 2=disconnected, 3=connecting, 4=connected)
	ifOperOperational = 5
	driveFixed        = 3
	// interface types to skip
	ifTypeLoopback     = 24
	ifTypeSoftwareLoop = 23
	ifTypeTunnel       = 131
)

type mibIfRow struct {
	wszName        [maxInterfaceNameLen]uint16
	dwIndex        uint32
	dwType         uint32
	dwMtu          uint32
	dwSpeed        uint32
	dwPhysAddrLen  uint32
	bPhysAddr      [maxlenPhysAddr]byte
	dwAdminStatus  uint32
	dwOperStatus   uint32
	dwLastChange   uint32
	dwInOctets     uint32
	dwInUcastPkts  uint32
	dwInNUcastPkts uint32
	dwInDiscards   uint32
	dwInErrors     uint32
	dwInUnknownProto uint32
	dwOutOctets    uint32
	dwOutUcastPkts uint32
	dwOutNUcastPkts uint32
	dwOutDiscards  uint32
	dwOutErrors    uint32
	dwOutQLen      uint32
	dwDescrLen     uint32
	bDescr         [maxlenIfDescr]byte
}

type mibIfTable struct {
	nRows uint32
	table [1]mibIfRow
}

// WindowsCollector implements Collector.
type WindowsCollector struct {
	st *State
}

func NewCollector() (Collector, error) {
	return &WindowsCollector{st: &State{}}, nil
}

func (c *WindowsCollector) Sample() (Sample, error) {
	c.st.mu.Lock()
	defer c.st.mu.Unlock()

	now := time.Now()
	dt := 0.0
	if !c.st.lastSample.IsZero() {
		dt = now.Sub(c.st.lastSample).Seconds()
	}

	var s Sample

	// ── CPU ──
	var idleFT, kernelFT, userFT filetime
	r1, _, _ := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idleFT)),
		uintptr(unsafe.Pointer(&kernelFT)),
		uintptr(unsafe.Pointer(&userFT)),
	)
	if r1 != 0 {
		idle := float64(idleFT.value() / 10) // 100ns ticks -> microseconds-ish scale; ratios only matter
		total := float64((kernelFT.value() + userFT.value()) / 10)
		cpuPct := cpuPercentFrom(c.st.lastCPU, CPUTimes{Idle: idle, Total: total}, c.st.haveCPU)
		c.st.lastCPU = CPUTimes{Idle: idle, Total: total}
		c.st.haveCPU = true
		s.CPUPercent = cpuPct
	}

	// ── Memory ──
	var mstat memoryStatusEx
	mstat.dwLength = uint32(unsafe.Sizeof(mstat))
	r1, _, _ = procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&mstat)))
	if r1 != 0 {
		s.MemTotal = float64(mstat.ullTotalPhys)
		s.MemUsed = float64(mstat.ullTotalPhys - mstat.ullAvailPhys)
	}

	// ── Network (physical interfaces) ──
	if rx, tx, ok := netBytesWindows(); ok {
		s.NetInBps = rateFrom(c.st.lastNet.Rx, rx, c.st.haveNet, dt)
		s.NetOutBps = rateFrom(c.st.lastNet.Tx, tx, c.st.haveNet, dt)
		c.st.lastNet = NetBytes{Rx: rx, Tx: tx}
		c.st.haveNet = true
	}

	// ── Disks ──
	total, used := diskUsageWindows()
	s.DiskTotal = total
	s.DiskUsed = used
	// per-disk IO counters are not available without PDH; report null

	// ── Uptime ──
	tick, _, _ := procGetTickCount64.Call()
	if tick != 0 {
		s.UptimeSec = float64(tick) / 1000
		boot := now.Unix() - int64(s.UptimeSec)
		if boot < 0 {
			boot = 0
		}
		s.BootTs = &boot
	}

	c.st.lastSample = now
	return s, nil
}

// netBytesWindows sums In/Out octets across operational physical interfaces.
func netBytesWindows() (rx, tx float64, ok bool) {
	var size uint32
	// first call with NULL table returns the required buffer size (ERROR_INSUFFICIENT_BUFFER)
	r1, _, _ := procGetIfTable.Call(0, uintptr(unsafe.Pointer(&size)), 0)
	_ = r1
	if size == 0 {
		return 0, 0, false
	}
	buf := make([]byte, size)
	r1, _, _ = procGetIfTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 1)
	if r1 != 0 {
		return 0, 0, false
	}
	table := (*mibIfTable)(unsafe.Pointer(&buf[0]))
	rowSize := unsafe.Sizeof(mibIfRow{})
	for i := uint32(0); i < table.nRows; i++ {
		row := (*mibIfRow)(unsafe.Pointer(uintptr(unsafe.Pointer(&table.table[0])) + uintptr(i)*rowSize))
		if row.dwType == ifTypeLoopback || row.dwType == ifTypeSoftwareLoop || row.dwType == ifTypeTunnel {
			continue
		}
		if row.dwOperStatus != ifOperOperational {
			continue
		}
		rx += float64(row.dwInOctets)
		tx += float64(row.dwOutOctets)
	}
	return rx, tx, true
}

// diskUsageWindows sums capacity/usage across fixed drives.
func diskUsageWindows() (total, used float64) {
	drives, _, _ := procGetLogicalDrives.Call()
	if drives == 0 {
		return 0, 0
	}
	for i := 0; i < 26; i++ {
		if drives&(1<<uint(i)) == 0 {
			continue
		}
		letter := string(rune('A' + i))
		root, _ := syscall.UTF16PtrFromString(letter + ":\\")
		dtype, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(root)))
		if dtype != driveFixed {
			continue
		}
		var freeBytes, totalBytes, totalFree uint64
		r1, _, _ := procGetDiskFreeSpaceExW.Call(
			uintptr(unsafe.Pointer(root)),
			uintptr(unsafe.Pointer(&freeBytes)),
			uintptr(unsafe.Pointer(&totalBytes)),
			uintptr(unsafe.Pointer(&totalFree)),
		)
		if r1 != 0 {
			total += float64(totalBytes)
			used += float64(totalBytes - freeBytes)
		}
	}
	return total, used
}
