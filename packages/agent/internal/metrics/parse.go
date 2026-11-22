package metrics

import (
	"strconv"
	"strings"
)

// ─── Pure /proc parsers (Linux) — testable on any platform ───────────────

// CPUStat is the aggregate "cpu" line of /proc/stat.
type CPUStat struct {
	Idle     float64
	Total    float64
	Btime    float64 // boot timestamp (epoch seconds)
	Procs    int
	Ctxt     float64
}

// ParseProcStat parses the aggregate cpu line plus btime from /proc/stat.
func ParseProcStat(content string) (CPUStat, bool) {
	var out CPUStat
	found := false
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) == 0 {
			continue
		}
		switch {
		case fields[0] == "cpu" && len(fields) >= 5:
			// user nice system idle iowait irq softirq steal ...
			var vals []float64
			for _, f := range fields[1:] {
				v, err := strconv.ParseFloat(f, 64)
				if err != nil {
					continue
				}
				vals = append(vals, v)
			}
			if len(vals) >= 4 {
				idle := vals[3] + vals[4] // idle + iowait
				var total float64
				for _, v := range vals {
					total += v
				}
				out.Idle = idle
				out.Total = total
				found = true
			}
		case fields[0] == "btime" && len(fields) >= 2:
			out.Btime, _ = strconv.ParseFloat(fields[1], 64)
		case fields[0] == "procs_running" && len(fields) >= 2:
			out.Procs, _ = strconv.Atoi(fields[1])
		}
	}
	return out, found
}

// ParseProcMeminfo extracts MemTotal and MemAvailable (KB) from /proc/meminfo.
func ParseProcMeminfo(content string) (memTotal, memAvail float64, ok bool) {
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			memTotal, _ = strconv.ParseFloat(fields[1], 64)
		case "MemAvailable:":
			memAvail, _ = strconv.ParseFloat(fields[1], 64)
		}
	}
	return memTotal, memAvail, memTotal > 0
}

// IfaceBytes is one interface's cumulative counters from /proc/net/dev.
type IfaceBytes struct {
	Name string
	Rx   float64
	Tx   float64
}

// ParseProcNetDev parses /proc/net/dev (skipping lo and virtual interfaces
// is the caller's policy).
func ParseProcNetDev(content string) []IfaceBytes {
	var out []IfaceBytes
	for _, line := range strings.Split(content, "\n") {
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		name := strings.TrimSpace(parts[0])
		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseFloat(fields[0], 64)
		tx, _ := strconv.ParseFloat(fields[8], 64)
		out = append(out, IfaceBytes{Name: name, Rx: rx, Tx: tx})
	}
	return out
}

// DiskIO is cumulative sector counters for one block device.
type DiskIO struct {
	Name      string
	ReadSect  float64
	WriteSect float64
}

// ParseProcDiskstats parses /proc/diskstats into per-device IO counters.
func ParseProcDiskstats(content string) []DiskIO {
	var out []DiskIO
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		// major minor name reads reads_merged sectors_read ms_reading
		// writes writes_merged sectors_written ms_writing ...
		if len(fields) < 10 {
			continue
		}
		name := fields[2]
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") ||
			strings.HasPrefix(name, "dm-") || strings.HasPrefix(name, "zram") {
			continue
		}
		rs, _ := strconv.ParseFloat(fields[5], 64)
		ws, _ := strconv.ParseFloat(fields[9], 64)
		out = append(out, DiskIO{Name: name, ReadSect: rs, WriteSect: ws})
	}
	return out
}

// ParseProcLoadavg parses the 1-minute load and process count.
func ParseProcLoadavg(content string) (load1 float64, procs int, ok bool) {
	fields := strings.Fields(content)
	if len(fields) < 1 {
		return 0, 0, false
	}
	load1, _ = strconv.ParseFloat(fields[0], 64)
	// "x/y" runs/total entities
	for _, f := range fields[3:] {
		if strings.Contains(f, "/") {
			parts := strings.SplitN(f, "/", 2)
			procs, _ = strconv.Atoi(parts[1])
			break
		}
	}
	return load1, procs, true
}

// IsPhysicalIface filters loopback/docker/tunnel interfaces.
func IsPhysicalIface(name string) bool {
	if name == "lo" || name == "" {
		return false
	}
	for _, prefix := range []string{"docker", "veth", "br-", "tun", "tap", "wg", "virbr"} {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}
