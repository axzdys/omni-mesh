// Package protocol defines the JSON envelope + payload contract shared with
// the TypeScript control plane (packages/shared/src/index.ts) and the binary
// stream frame layout.
package protocol

import (
	"encoding/json"
	"time"
)

// Message types (see shared/src/index.ts AgentMsg).
const (
	TypeAuth          = "AUTH"
	TypeAuthOK        = "AUTH_OK"
	TypeAuthErr       = "AUTH_ERR"
	TypeHeartbeat     = "HEARTBEAT"
	TypeMetrics       = "METRICS"
	TypeExecReq       = "EXEC_REQ"
	TypeExecStream    = "EXEC_STREAM"
	TypeExecResult    = "EXEC_RESULT"
	TypeExecCancel    = "EXEC_CANCEL"
	TypePtyOpen       = "PTY_OPEN"
	TypePtyClosed     = "PTY_CLOSED"
	TypePtyResize     = "PTY_RESIZE"
	TypeFileReq       = "FILE_TRANSFER_REQ"
	TypeFileAck       = "FILE_TRANSFER_ACK"
)

// Binary frame kind bytes.
const (
	KindPtyData  = 0x01
	KindFileData = 0x02
)

// Envelope is the top-level WS text-frame JSON structure.
type Envelope struct {
	T  string          `json:"t"`
	ID string          `json:"id,omitempty"`
	TS int64           `json:"ts"`
	D  json.RawMessage `json:"d,omitempty"`
}

func NewEnvelope(t string, d any) (Envelope, error) {
	var raw json.RawMessage
	if d != nil {
		b, err := json.Marshal(d)
		if err != nil {
			return Envelope{}, err
		}
		raw = b
	}
	return Envelope{T: t, TS: time.Now().UnixMilli(), D: raw}, nil
}

// ─── Payloads ────────────────────────────────────────────────────────────

type AuthPayload struct {
	Token   string `json:"token"`
	Version string `json:"version"`
}

type AuthOkPayload struct {
	NodeID        string `json:"nodeId"`
	HeartbeatSec  int    `json:"heartbeatSec"`
	MetricsSec    int    `json:"metricsSec"`
}

type AuthErrPayload struct {
	Error string `json:"error"`
}

type HeartbeatPayload struct {
	UptimeSec float64 `json:"uptimeSec"`
}

type MetricsPayload struct {
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

type ExecReqPayload struct {
	TaskID    string            `json:"taskId"`
	Script    string            `json:"script"`
	Lang      string            `json:"lang,omitempty"` // shell | python
	WorkDir   string            `json:"workDir,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	TimeoutMs int64             `json:"timeoutMs"`
}

type ExecStreamPayload struct {
	TaskID string `json:"taskId"`
	Stream string `json:"stream"` // out | err
	DataB64 string `json:"dataB64"`
}

type ExecResultPayload struct {
	TaskID     string  `json:"taskId"`
	ExitCode   *int    `json:"exitCode"`
	Signal     *string `json:"signal,omitempty"`
	DurationMs int64   `json:"durationMs"`
	Error      string  `json:"error,omitempty"`
}

type ExecCancelPayload struct {
	TaskID string `json:"taskId"`
}

type PtyOpenPayload struct {
	PtyID string `json:"ptyId"`
	Cols  uint16 `json:"cols"`
	Rows  uint16 `json:"rows"`
	Shell string `json:"shell,omitempty"`
}

type PtyResizePayload struct {
	PtyID string `json:"ptyId"`
	Cols  uint16 `json:"cols"`
	Rows  uint16 `json:"rows"`
}

type PtyClosedPayload struct {
	PtyID  string `json:"ptyId"`
	Reason string `json:"reason,omitempty"`
}

type FileTransferReqPayload struct {
	TransferID string `json:"transferId"`
	Direction  string `json:"direction"` // upload (CP->agent) | download (agent->CP)
	Path       string `json:"path"`
	Size       int64  `json:"size"`
}

type FileTransferAckPayload struct {
	TransferID string `json:"transferId"`
	Received   int64  `json:"received"`
	Done       bool   `json:"done"`
	Error      string `json:"error,omitempty"`
}

// ─── Binary frame codec ──────────────────────────────────────────────────

// EncodeBinaryFrame: [kind:1][idLen:1][id][payload]
func EncodeBinaryFrame(kind byte, channelID string, payload []byte) []byte {
	idBytes := []byte(channelID)
	out := make([]byte, 2+len(idBytes)+len(payload))
	out[0] = kind
	out[1] = byte(len(idBytes))
	copy(out[2:], idBytes)
	copy(out[2+len(idBytes):], payload)
	return out
}

// DecodeBinaryFrame splits a binary frame into its parts.
func DecodeBinaryFrame(frame []byte) (kind byte, channelID string, payload []byte, ok bool) {
	if len(frame) < 2 {
		return 0, "", nil, false
	}
	kind = frame[0]
	idLen := int(frame[1])
	if len(frame) < 2+idLen {
		return 0, "", nil, false
	}
	channelID = string(frame[2 : 2+idLen])
	payload = frame[2+idLen:]
	return kind, channelID, payload, true
}
