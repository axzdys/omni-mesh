//go:build linux
// +build linux

package metrics

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

// LinuxCollector reads /proc + statfs.
type LinuxCollector struct {
	root string
	st   *State
}

func NewCollector() (Collector, error) {
	return &LinuxCollector{root: "/", st: &State{}}, nil
}

func (c *LinuxCollector) Sample() (Sample, error) {
	c.st.mu.Lock()
	defer c.st.mu.Unlock()

	now := time.Now()
	dt := 0.0
	if !c.st.lastSample.IsZero() {
		dt = now.Sub(c.st.lastSample).Seconds()
	}

	// CPU + boot time
	statRaw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return Sample{}, fmt.Errorf("read /proc/stat: %w", err)
	}
	cpu, ok := ParseProcStat(string(statRaw))
	if !ok {
		return Sample{}, fmt.Errorf("no cpu line in /proc/stat")
	}
	cpuPct := cpuPercentFrom(c.st.lastCPU, CPUTimes{Idle: cpu.Idle, Total: cpu.Total}, c.st.haveCPU)
	c.st.lastCPU = CPUTimes{Idle: cpu.Idle, Total: cpu.Total}
	c.st.haveCPU = true

	// Memory
	var memUsed, memTotal float64
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		if memTotalKB, memAvailKB, ok := ParseProcMeminfo(string(raw)); ok {
			memTotal = memTotalKB * 1024
			memUsed = (memTotalKB - memAvailKB) * 1024
		}
	}

	// Network (physical interfaces)
	var netInBps, netOutBps float64
	if raw, err := os.ReadFile("/proc/net/dev"); err == nil {
		var rx, tx float64
		for _, i := range ParseProcNetDev(string(raw)) {
			if !IsPhysicalIface(i.Name) {
				continue
			}
			rx += i.Rx
			tx += i.Tx
		}
		netInBps = rateFrom(c.st.lastNet.Rx, rx, c.st.haveNet, dt)
		netOutBps = rateFrom(c.st.lastNet.Tx, tx, c.st.haveNet, dt)
		c.st.lastNet = NetBytes{Rx: rx, Tx: tx}
		c.st.haveNet = true
	}

	// Disk IO (all real block devices, 512B sectors)
	var diskReadBps, diskWriteBps *float64
	if raw, err := os.ReadFile("/proc/diskstats"); err == nil {
		var read, write float64
		for _, d := range ParseProcDiskstats(string(raw)) {
			read += d.ReadSect
			write += d.WriteSect
		}
		if c.st.lastDiskIO != nil && dt > 0 {
			r := rateFrom(c.st.lastDiskIO.Read, read, true, dt) * 512
			w := rateFrom(c.st.lastDiskIO.Write, write, true, dt) * 512
			diskReadBps = &r
			diskWriteBps = &w
		}
		c.st.lastDiskIO = &DiskIOBytes{Read: read, Write: write}
	}

	// Load + procs
	var load1 *float64
	var procs *int
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		if l, p, ok := ParseProcLoadavg(string(raw)); ok {
			load1 = &l
			procs = &p
		}
	}

	// Filesystem usage of the install root
	var diskTotal, diskUsed float64
	var fs syscall.Statfs_t
	if err := syscall.Statfs(c.root, &fs); err == nil {
		total := float64(fs.Blocks) * float64(fs.Bsize)
		free := float64(fs.Bfree) * float64(fs.Bsize)
		diskTotal = total
		diskUsed = total - free
	}

	uptime := float64(now.Unix() - int64(cpu.Btime))
	if uptime < 0 {
		uptime = 0
	}
	bootTs := int64(cpu.Btime)
	if bootTs <= 0 {
		bootTs = 0
	}
	c.st.lastSample = now

	return Sample{
		CPUPercent:   cpuPct,
		MemUsed:      memUsed,
		MemTotal:     memTotal,
		DiskTotal:    diskTotal,
		DiskUsed:     diskUsed,
		DiskReadBps:  diskReadBps,
		DiskWriteBps: diskWriteBps,
		NetInBps:     netInBps,
		NetOutBps:    netOutBps,
		Load1:        load1,
		Procs:        procs,
		UptimeSec:    uptime,
		BootTs:       &bootTs,
	}, nil
}
