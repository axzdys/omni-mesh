// Package metrics collects system metrics for the agent. Platform-specific
// collectors live in metrics_linux.go / metrics_windows.go; the pure /proc
// parsing logic (used on Linux) is in parse.go and is unit tested.
package metrics

import (
	"sync"
	"time"
)

// Sample is one metrics observation. Pointer fields serialize as JSON null.
type Sample struct {
	CPUPercent   float64  `json:"cpuPercent"`
	MemUsed      float64  `json:"memUsed"`
	MemTotal     float64  `json:"memTotal"`
	DiskTotal    float64  `json:"diskTotal"`
	DiskUsed     float64  `json:"diskUsed"`
	DiskReadBps  *float64 `json:"diskReadBps"`
	DiskWriteBps *float64 `json:"diskWriteBps"`
	NetInBps     float64  `json:"netInBps"`
	NetOutBps    float64  `json:"netOutBps"`
	Load1        *float64 `json:"load1"`
	Procs        *int     `json:"procs"`
	UptimeSec    float64  `json:"uptimeSec"`
	BootTs       *int64   `json:"bootTs"`
}

// Collector produces delta-based samples.
type Collector interface {
	Sample() (Sample, error)
}

// State carries counter deltas between samples.
type State struct {
	mu         sync.Mutex
	lastCPU    CPUTimes
	lastNet    NetBytes
	lastDiskIO *DiskIOBytes
	haveCPU    bool
	haveNet    bool
	lastSample time.Time
}

// CPUTimes are cumulative counters.
type CPUTimes struct {
	Idle  float64
	Total float64
}

// NetBytes are cumulative rx/tx byte counters across physical interfaces.
type NetBytes struct {
	Rx float64
	Tx float64
}

// DiskIOBytes are cumulative sector counts (×512 bytes).
type DiskIOBytes struct {
	Read  float64
	Write float64
}

// cpuPercentFrom computes utilization between two cumulative readings.
func cpuPercentFrom(prev, cur CPUTimes, havePrev bool) float64 {
	if !havePrev || cur.Total <= prev.Total {
		return 0
	}
	idleDelta := cur.Idle - prev.Idle
	totalDelta := cur.Total - prev.Total
	if totalDelta <= 0 {
		return 0
	}
	pct := (1 - idleDelta/totalDelta) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct
}

// rateFrom computes bytes/sec between two cumulative byte counters.
func rateFrom(prev, cur float64, havePrev bool, dtSec float64) float64 {
	if !havePrev || dtSec <= 0 || cur < prev {
		return 0
	}
	return (cur - prev) / dtSec
}
