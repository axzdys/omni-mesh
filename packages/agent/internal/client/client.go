// Package client implements the agent's WebSocket session with the control
// plane: registration, auth, reconnect with exponential backoff, heartbeats,
// metrics reporting, task execution, PTY bridging and file transfers.
package client

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"omni-agent/internal/backoff"
	"omni-agent/internal/config"
	"omni-agent/internal/metrics"
	"omni-agent/internal/protocol"
	"omni-agent/internal/pty"
	"omni-agent/internal/runner"
	"omni-agent/internal/wsframe"
)

const (
	defaultHeartbeatSec = 15
	defaultMetricsSec   = 30
)

// Agent wires everything together.
type Agent struct {
	Cfg       *config.Config
	Version   string
	executor  *runner.Executor
	ptyMgr    *pty.Manager
	collector metrics.Collector
	conn      *wsframe.Conn
	out       chan outMsg
	mu        sync.Mutex
	uptime0   time.Time
	liveTasks map[string]struct{}
	uploads   map[string]*uploadState
}

type outMsg struct {
	data   []byte
	binary bool
}

func New(cfg *config.Config, version string) (*Agent, error) {
	col, err := metrics.NewCollector()
	if err != nil {
		return nil, err
	}
	return &Agent{
		Cfg:       cfg,
		Version:   version,
		executor:  runner.New(),
		ptyMgr:    pty.NewManager(),
		collector: col,
		uptime0:   time.Now(),
		liveTasks: make(map[string]struct{}),
		uploads:   make(map[string]*uploadState),
	}, nil
}

// Run blocks: registers (if needed), connects, and keeps the session alive
// until ctx is cancelled. Returns nil on clean shutdown.
func (a *Agent) Run(ctx context.Context) error {
	bo := backoff.New(1*time.Second, 60*time.Second)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := a.ensureRegistered(ctx); err != nil {
			log.Printf("[agent] registration failed: %v", err)
			if err := bo.Next(ctx); err != nil {
				return err
			}
			continue
		}
		err := a.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("[agent] disconnected: %v — retrying", err)
		a.ptyMgr.CloseAll()
		a.cancelAll()
		if err := bo.Next(ctx); err != nil {
			return err
		}
	}
}

func (a *Agent) cancelAll() {
	for _, id := range a.runningTasks() {
		a.executor.Cancel(id)
	}
}

func (a *Agent) runningTasks() []string {
	// the executor exposes only counts; cancellation by id happens via
	// EXEC_CANCEL messages. On disconnect we cancel through the map below.
	a.mu.Lock()
	defer a.mu.Unlock()
	ids := make([]string, 0, len(a.liveTasks))
	for id := range a.liveTasks {
		ids = append(ids, id)
	}
	return ids
}

func (a *Agent) ensureRegistered(ctx context.Context) error {
	if a.Cfg.Token != "" && a.Cfg.NodeID != "" {
		return nil
	}
	if a.Cfg.RegistrationKey == "" {
		return fmt.Errorf("no token and no registration key configured")
	}
	body, _ := json.Marshal(map[string]any{
		"registrationKey": a.Cfg.RegistrationKey,
		"name":            a.Cfg.Name,
		"labels":          a.Cfg.Labels,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"version":         a.Version,
		"hostname":        hostName(),
	})
	httpURL := strings.TrimSuffix(a.Cfg.Server, "/")
	// registration happens over HTTP(S); translate the ws(s) scheme
	httpURL = strings.Replace(strings.Replace(httpURL, "wss://", "https://", 1), "ws://", "http://", 1)
	regURL := httpURL + "/agent/register"
	req, err := http.NewRequestWithContext(ctx, "POST", regURL, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	httpClient := &http.Client{Timeout: 25 * time.Second}
	if a.Cfg.Proxy != "" {
		if pu, perr := url.Parse(a.Cfg.Proxy); perr == nil {
			httpClient.Transport = &http.Transport{Proxy: http.ProxyURL(pu)}
		}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var payload struct {
		OK   bool `json:"ok"`
		Data struct {
			NodeID string `json:"nodeId"`
			Token  string `json:"token"`
		} `json:"data"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return fmt.Errorf("bad register response: %w", err)
	}
	if resp.StatusCode != 200 || !payload.OK {
		return fmt.Errorf("register rejected: %s (http %d)", payload.Error, resp.StatusCode)
	}
	a.Cfg.NodeID = payload.Data.NodeID
	a.Cfg.Token = payload.Data.Token
	if err := a.Cfg.Save(); err != nil {
		log.Printf("[agent] warning: could not persist config: %v", err)
	}
	log.Printf("[agent] registered as node %s", a.Cfg.NodeID)
	return nil
}

// session performs one full connect->auth->serve cycle; returns on error.
func (a *Agent) session(ctx context.Context) error {
	url := strings.TrimSuffix(a.Cfg.Server, "/") + "/agent/ws?token=" + a.Cfg.Token
	conn, err := wsframe.Dial(url, a.Cfg.InsecureSkipVerify, nil, a.Cfg.Proxy)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	a.conn = conn
	defer func() {
		a.mu.Lock()
		a.conn = nil
		a.mu.Unlock()
		conn.Close()
	}()

	a.out = make(chan outMsg, 256)
	stop := make(chan struct{})
	var stopOnce sync.Once
	defer stopOnce.Do(func() { close(stop) })

	// writer pump starts FIRST so every frame — AUTH included — flows through
	// the single ordered queue; binary chunks and their JSON acknowledgements
	// can never overtake each other
	go func() {
		for {
			select {
			case <-stop:
				return
			case m := <-a.out:
				var err error
				if m.binary {
					err = conn.WriteBinary(m.data)
				} else {
					err = conn.WriteText(m.data)
				}
				if err != nil {
					return
				}
			}
		}
	}()

	// AUTH handshake (enqueued after the pump is draining)
	authEnv, _ := protocol.NewEnvelope(protocol.TypeAuth, protocol.AuthPayload{Token: a.Cfg.Token, Version: a.Version})
	if err := a.sendEnvelope(authEnv); err != nil {
		return err
	}

	// wait for AUTH_OK / AUTH_ERR
	if err := a.awaitAuth(10 * time.Second); err != nil {
		return err
	}
	log.Printf("[agent] connected to %s (node %s)", a.Cfg.Server, a.Cfg.NodeID)

	// heartbeat + metrics tickers
	hb := time.NewTicker(defaultHeartbeatSec * time.Second)
	defer hb.Stop()
	mt := time.NewTicker(metricsInterval())
	defer mt.Stop()

	errCh := make(chan error, 4)

	go func() {
		for {
			select {
			case <-stop:
				return
			case <-hb.C:
				env, _ := protocol.NewEnvelope(protocol.TypeHeartbeat, protocol.HeartbeatPayload{UptimeSec: a.uptimeSec()})
				if err := a.sendEnvelope(env); err != nil {
					errCh <- err
					return
				}
			case <-mt.C:
				a.sendMetrics()
			}
		}
	}()

	// initial metrics right away
	a.sendMetrics()

	// read pump (blocks this function)
	for {
		select {
		case err := <-errCh:
			return err
		case <-ctx.Done():
			return ctx.Err()
		case <-stop:
			return nil
		default:
		}
		op, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		switch op {
		case wsframe.OpText:
			if err := a.handleText(data); err != nil {
				log.Printf("[agent] message handler: %v", err)
			}
		case wsframe.OpBinary:
			a.handleBinary(data)
		}
	}
}

func (a *Agent) awaitAuth(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		op, data, err := a.conn.ReadMessage()
		if err != nil {
			return err
		}
		if op != wsframe.OpText {
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		switch env.T {
		case protocol.TypeAuthOK:
			var ok protocol.AuthOkPayload
			_ = json.Unmarshal(env.D, &ok)
			return nil
		case protocol.TypeAuthErr:
			var e protocol.AuthErrPayload
			_ = json.Unmarshal(env.D, &e)
			return fmt.Errorf("auth rejected: %s", e.Error)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("auth timeout")
		}
	}
}

// sendEnvelope queues a JSON control frame on the ordered outbound queue.
// Ordering with binary frames (file chunks, PTY output) is guaranteed because
// both flows share this queue and the single writer pump.
func (a *Agent) sendEnvelope(env protocol.Envelope) error {
	b, err := json.Marshal(env)
	if err != nil {
		return err
	}
	select {
	case a.out <- outMsg{data: b}:
		return nil
	default:
		return fmt.Errorf("outbound queue full")
	}
}

func (a *Agent) sendOut(m outMsg) {
	select {
	case a.out <- m:
	default:
		log.Printf("[agent] outbound queue full; dropping message")
	}
}

func (a *Agent) uptimeSec() float64 { return time.Since(a.uptime0).Seconds() }

func (a *Agent) sendMetrics() {
	sample, err := a.collector.Sample()
	if err != nil {
		log.Printf("[agent] metrics: %v", err)
		return
	}
	env, _ := protocol.NewEnvelope(protocol.TypeMetrics, protocol.MetricsPayload{
		CPUPercent:   sample.CPUPercent,
		MemUsed:      sample.MemUsed,
		MemTotal:     sample.MemTotal,
		DiskTotal:    sample.DiskTotal,
		DiskUsed:     sample.DiskUsed,
		DiskReadBps:  sample.DiskReadBps,
		DiskWriteBps: sample.DiskWriteBps,
		NetInBps:     sample.NetInBps,
		NetOutBps:    sample.NetOutBps,
		Load1:        sample.Load1,
		Procs:        sample.Procs,
		UptimeSec:    sample.UptimeSec,
		BootTs:       sample.BootTs,
	})
	_ = a.sendEnvelope(env)
}

func metricsInterval() time.Duration {
	s := os.Getenv("OMNI_METRICS_SEC")
	if s != "" {
		var n int
		if _, err := fmt.Sscanf(s, "%d", &n); err == nil && n >= 1 {
			return time.Duration(n) * time.Second
		}
	}
	return defaultMetricsSec * time.Second
}

func hostName() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}
