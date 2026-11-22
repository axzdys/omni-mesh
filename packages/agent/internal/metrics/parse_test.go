package metrics

import (
	"testing"
)

const statSample = `cpu  74608 2520 24433 1117073 6176 4054 0 0 0 0
cpu0 36882 1311 12175 558726 3049 2051 0 0 0 0
btime 1765000000
procs_running 3
procs_blocked 0
ctxt 1234567`

const meminfoSample = `MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB`

const netDevSample = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000    8000    0    0    0     0          0         0  1000000    8000    0    0    0     0       0          0
  eth0: 50000000  32000    0    0    0     0          0       100 25000000  28000    0    0    0     0       0          0
docker0: 80000     600    0    0    0     0          0         0   120000     700    0    0    0     0       0          0
 veth9a: 40000     300    0    0    0     0          0         0    60000     400    0    0    0     0       0          0`

const diskstatsSample = `   8       0 sda 12345 0 987654 3200 54321 0 876543 4100 0 5200 7300 0 0 0 0 0 0
   7       0 loop0 100 0 2000 10 0 0 0 0 0 10 10 0 0 0 0 0 0
 254       0 dm-0 500 0 8000 20 400 0 6000 30 0 50 50 0 0 0 0 0 0
   8      16 sdb 2000 0 40000 100 3000 0 50000 200 0 300 300 0 0 0 0 0 0`

func TestParseProcStat(t *testing.T) {
	s, ok := ParseProcStat(statSample)
	if !ok {
		t.Fatal("expected cpu line found")
	}
	if s.Btime != 1765000000 {
		t.Fatalf("btime = %v", s.Btime)
	}
	if s.Procs != 3 {
		t.Fatalf("procs_running = %v", s.Procs)
	}
	// idle = 1117073 + 6176; total = sum of 10 fields
	if s.Idle != 1117073+6176 {
		t.Fatalf("idle = %v", s.Idle)
	}
	wantTotal := float64(74608 + 2520 + 24433 + 1117073 + 6176 + 4054)
	if s.Total != wantTotal {
		t.Fatalf("total = %v, want %v", s.Total, wantTotal)
	}
}

func TestParseProcMeminfo(t *testing.T) {
	total, avail, ok := ParseProcMeminfo(meminfoSample)
	if !ok {
		t.Fatal("expected ok")
	}
	if total != 16384000 || avail != 8192000 {
		t.Fatalf("total=%v avail=%v", total, avail)
	}
}

func TestParseProcNetDev(t *testing.T) {
	ifaces := ParseProcNetDev(netDevSample)
	if len(ifaces) != 4 {
		t.Fatalf("ifaces = %d", len(ifaces))
	}
	byName := map[string]IfaceBytes{}
	for _, i := range ifaces {
		byName[i.Name] = i
	}
	if byName["eth0"].Rx != 50000000 || byName["eth0"].Tx != 25000000 {
		t.Fatalf("eth0 mismatch: %+v", byName["eth0"])
	}
}

func TestIsPhysicalIface(t *testing.T) {
	cases := map[string]bool{
		"eth0":     true,
		"ens18":    true,
		"wlan0":    true,
		"lo":       false,
		"docker0":  false,
		"veth9abc": false,
		"br-1a2b":  false,
		"tun0":     false,
		"wg0":      false,
	}
	for name, want := range cases {
		if got := IsPhysicalIface(name); got != want {
			t.Fatalf("IsPhysicalIface(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestParseProcDiskstats(t *testing.T) {
	disks := ParseProcDiskstats(diskstatsSample)
	if len(disks) != 2 { // sda + sdb only (loop0, dm-0 skipped)
		t.Fatalf("disks = %+v", disks)
	}
	if disks[0].Name != "sda" || disks[0].ReadSect != 987654 || disks[0].WriteSect != 876543 {
		t.Fatalf("sda mismatch: %+v", disks[0])
	}
}

func TestParseProcLoadavg(t *testing.T) {
	load, procs, ok := ParseProcLoadavg("0.52 0.58 0.59 2/891 12345")
	if !ok || load != 0.52 || procs != 891 {
		t.Fatalf("load=%v procs=%v ok=%v", load, procs, ok)
	}
}

func TestCpuPercent(t *testing.T) {
	prev := CPUTimes{Idle: 1000, Total: 2000}
	cur := CPUTimes{Idle: 1000, Total: 3000} // all 1000 delta busy
	if pct := cpuPercentFrom(prev, cur, true); pct < 99.9 {
		t.Fatalf("pct = %v, want ~100", pct)
	}
	idle := CPUTimes{Idle: 2000, Total: 3000} // all idle
	if pct := cpuPercentFrom(prev, idle, true); pct > 0.1 {
		t.Fatalf("pct = %v, want ~0", pct)
	}
	if pct := cpuPercentFrom(prev, cur, false); pct != 0 {
		t.Fatalf("first sample should be 0, got %v", pct)
	}
}

func TestRate(t *testing.T) {
	if r := rateFrom(100, 600, true, 10); r != 50 {
		t.Fatalf("rate = %v, want 50", r)
	}
	if r := rateFrom(600, 100, true, 10); r != 0 { // counter reset
		t.Fatalf("counter reset rate = %v", r)
	}
}
