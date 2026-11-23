// Message handlers for the agent session: exec tasks, PTY bridging and
// file transfers.
package client

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"omni-agent/internal/protocol"
	"omni-agent/internal/runner"
)

// ─── JSON message dispatch ───────────────────────────────────────────────

func (a *Agent) handleText(data []byte) error {
	var env protocol.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return err
	}
	switch env.T {
	case protocol.TypeExecReq:
		var p protocol.ExecReqPayload
		if err := json.Unmarshal(env.D, &p); err != nil {
			return err
		}
		a.startExecTask(p)
	case protocol.TypeExecCancel:
		var p protocol.ExecCancelPayload
		if err := json.Unmarshal(env.D, &p); err != nil {
			return err
		}
		a.executor.Cancel(p.TaskID)
	case protocol.TypePtyOpen:
		var p protocol.PtyOpenPayload
		if err := json.Unmarshal(env.D, &p); err != nil {
			return err
		}
		a.openPty(p)
	case protocol.TypePtyResize:
		var p protocol.PtyResizePayload
		if err := json.Unmarshal(env.D, &p); err != nil {
			return err
		}
		if s, ok := a.ptyMgr.Get(p.PtyID); ok {
			_ = s.Resize(p.Cols, p.Rows)
		}
	case protocol.TypePtyClosed:
		var p protocol.PtyClosedPayload
		if err := json.Unmarshal(env.D, &p); err != nil {
			return err
		}
		_ = a.ptyMgr.Close(p.PtyID)
	case protocol.TypeFileReq:
		var p protocol.FileTransferReqPayload
		if err := json.Unmarshal(env.D, &p); err != nil {
			return err
		}
		switch p.Direction {
		case "upload":
			a.beginUpload(p)
		case "download":
			go a.runDownload(p)
		}
	default:
		log.Printf("[agent] unhandled message type %q", env.T)
	}
	return nil
}

// ─── Binary frame dispatch ───────────────────────────────────────────────

func (a *Agent) handleBinary(frame []byte) {
	kind, ch, payload, ok := protocol.DecodeBinaryFrame(frame)
	if !ok {
		return
	}
	switch kind {
	case protocol.KindPtyData:
		if s, found := a.ptyMgr.Get(ch); found {
			n, werr := s.Write(payload)
			if werr != nil {
				log.Printf("[agent] pty %s write error: %v", ch, werr)
			} else {
				log.Printf("[agent] pty %s wrote %d bytes", ch, n)
			}
		} else {
			log.Printf("[agent] pty data for unknown session %s (%d bytes); sessions: %v", ch, len(payload), a.ptyMgr.List())
		}
	case protocol.KindFileData:
		a.appendUploadChunk(ch, payload)
	}
}

// ─── Task execution ──────────────────────────────────────────────────────

func (a *Agent) startExecTask(p protocol.ExecReqPayload) {
	a.mu.Lock()
	a.liveTasks[p.TaskID] = struct{}{}
	a.mu.Unlock()
	go func() {
		req := runner.ExecRequest{
			TaskID:    p.TaskID,
			Script:    p.Script,
			Lang:      p.Lang,
			WorkDir:   p.WorkDir,
			Env:       p.Env,
			TimeoutMs: p.TimeoutMs,
		}
		res := a.executor.Run(req, func(stream string, chunk []byte) {
			env, _ := protocol.NewEnvelope(protocol.TypeExecStream, protocol.ExecStreamPayload{
				TaskID:  p.TaskID,
				Stream:  stream,
				DataB64: base64.StdEncoding.EncodeToString(chunk),
			})
			a.sendEnvelope(env)
		})
		res2 := protocol.ExecResultPayload{
			TaskID:     p.TaskID,
			ExitCode:   res.ExitCode,
			Signal:     res.Signal,
			DurationMs: res.DurationMs,
			Error:      res.Error,
		}
		if len(res.Log) > 0 {
			res2.LogB64 = base64.StdEncoding.EncodeToString(res.Log)
		}
		env, _ := protocol.NewEnvelope(protocol.TypeExecResult, res2)
		if err := a.sendEnvelope(env); err != nil {
			log.Printf("[agent] send result: %v", err)
		}
		a.mu.Lock()
		delete(a.liveTasks, p.TaskID)
		a.mu.Unlock()
	}()
}

// ─── PTY ─────────────────────────────────────────────────────────────────

func (a *Agent) openPty(p protocol.PtyOpenPayload) {
	s, err := a.ptyMgr.Open(p.PtyID, p.Cols, p.Rows, p.Shell)
	if err != nil {
		log.Printf("[agent] pty open %s: %v", p.PtyID, err)
		env, _ := protocol.NewEnvelope(protocol.TypePtyClosed, protocol.PtyClosedPayload{PtyID: p.PtyID, Reason: err.Error()})
		a.sendEnvelope(env)
		return
	}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := s.Read(buf)
			if n > 0 {
				a.sendOut(outMsg{
					data:   protocol.EncodeBinaryFrame(protocol.KindPtyData, p.PtyID, buf[:n]),
					binary: true,
				})
			}
			if err != nil {
				break
			}
		}
		_ = a.ptyMgr.Close(p.PtyID)
		env, _ := protocol.NewEnvelope(protocol.TypePtyClosed, protocol.PtyClosedPayload{PtyID: p.PtyID, Reason: "process exited"})
		a.sendEnvelope(env)
	}()
}

// ─── File transfers ──────────────────────────────────────────────────────

type uploadState struct {
	path     string
	size     int64
	received int64
	file     *os.File
	mu       sync.Mutex
}

func (a *Agent) beginUpload(p protocol.FileTransferReqPayload) {
	st := &uploadState{path: p.Path, size: p.Size}
	a.uploads[p.TransferID] = st
	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.uploads, p.TransferID)
			a.mu.Unlock()
		}()
		<-time.After(60 * time.Second)
		st.mu.Lock()
		defer st.mu.Unlock()
		if st.file != nil && a.uploads[p.TransferID] == st {
			_ = st.file.Close()
			a.ackUpload(p.TransferID, st.received, false, "upload timed out")
		}
	}()
}

func (a *Agent) appendUploadChunk(transferID string, chunk []byte) {
	st, ok := a.uploads[transferID]
	if !ok {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.file == nil {
		_ = os.MkdirAll(filepath.Dir(st.path), 0o755)
		f, err := os.Create(st.path)
		if err != nil {
			a.ackUpload(transferID, 0, true, err.Error())
			a.mu.Lock()
			delete(a.uploads, transferID)
			a.mu.Unlock()
			return
		}
		st.file = f
	}
	n, err := st.file.Write(chunk)
	st.received += int64(n)
	if err != nil {
		a.ackUpload(transferID, st.received, true, err.Error())
		_ = st.file.Close()
		a.mu.Lock()
		delete(a.uploads, transferID)
		a.mu.Unlock()
		return
	}
	if st.size > 0 && st.received >= st.size {
		_ = st.file.Close()
		st.file = nil
		a.ackUpload(transferID, st.received, true, "")
		a.mu.Lock()
		delete(a.uploads, transferID)
		a.mu.Unlock()
	}
}

func (a *Agent) ackUpload(transferID string, received int64, done bool, errText string) {
	env, _ := protocol.NewEnvelope(protocol.TypeFileAck, protocol.FileTransferAckPayload{
		TransferID: transferID,
		Received:   received,
		Done:       done,
		Error:      errText,
	})
	a.sendEnvelope(env)
}

func (a *Agent) runDownload(p protocol.FileTransferReqPayload) {
	f, err := os.Open(p.Path)
	if err != nil {
		a.ackUpload(p.TransferID, 0, true, err.Error())
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		a.ackUpload(p.TransferID, 0, true, err.Error())
		return
	}
	if stat.IsDir() {
		a.ackUpload(p.TransferID, 0, true, fmt.Sprintf("%s is a directory", p.Path))
		return
	}
	var sent int64
	buf := make([]byte, 48*1024)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			a.sendOut(outMsg{
				data:   protocol.EncodeBinaryFrame(protocol.KindFileData, p.TransferID, buf[:n]),
				binary: true,
			})
			sent += int64(n)
		}
		if err != nil {
			break
		}
	}
	a.ackUpload(p.TransferID, sent, true, "")
}
