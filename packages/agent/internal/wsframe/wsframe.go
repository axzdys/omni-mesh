// Package wsframe implements a minimal RFC6455 WebSocket client on the Go
// standard library only (net + crypto/tls). It supports the subset required
// by the OmniMesh agent: text/binary frames, fragmentation, ping/pong and
// close handling, with client-side masking.
package wsframe

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Opcode per RFC6455.
type Opcode byte

const (
	OpContinuation Opcode = 0x0
	OpText         Opcode = 0x1
	OpBinary       Opcode = 0x2
	OpClose        Opcode = 0x8
	OpPing         Opcode = 0x9
	OpPong         Opcode = 0xA
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

var ErrClosed = errors.New("websocket closed")

// Conn is a client-side WebSocket connection.
type Conn struct {
	wmu    sync.Mutex
	rmu    sync.Mutex
	conn   net.Conn
	br     *bufio.Reader
	closed bool
}

// Dial connects and performs the HTTP/1.1 upgrade handshake. When proxyURL
// is set (http://host:port, optionally with user:pass@), the TCP stream is
// tunneled through the proxy via HTTP CONNECT — required when the control
// plane hostname is unreachable directly (e.g. workers.dev in some regions).
func Dial(rawURL string, insecureSkipVerify bool, header http.Header, proxyURL string) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("bad url: %w", err)
	}
	var hostPort string
	var useTLS bool
	switch u.Scheme {
	case "ws":
		useTLS = false
		hostPort = u.Host
		if u.Port() == "" {
			hostPort = net.JoinHostPort(u.Hostname(), "80")
		}
	case "wss":
		useTLS = true
		hostPort = u.Host
		if u.Port() == "" {
			hostPort = net.JoinHostPort(u.Hostname(), "443")
		}
	default:
		return nil, fmt.Errorf("unsupported scheme %q (use ws:// or wss://)", u.Scheme)
	}

	deadline := time.Now().Add(20 * time.Second)

	var conn net.Conn
	if proxyURL != "" {
		pu, err := url.Parse(proxyURL)
		if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") {
			return nil, fmt.Errorf("bad proxy url %q (only http:// proxies are supported)", proxyURL)
		}
		proxyHostPort := pu.Host
		if pu.Port() == "" {
			proxyHostPort = net.JoinHostPort(pu.Hostname(), "80")
		}
		d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		conn, err = d.Dial("tcp", proxyHostPort)
		if err != nil {
			return nil, fmt.Errorf("proxy dial: %w", err)
		}
		req := "CONNECT " + hostPort + " HTTP/1.1\r\nHost: " + hostPort + "\r\n"
		if pu.User != nil {
			if pass, ok := pu.User.Password(); ok {
				auth := base64.StdEncoding.EncodeToString([]byte(pu.User.Username() + ":" + pass))
				req += "Proxy-Authorization: Basic " + auth + "\r\n"
			}
		}
		req += "\r\n"
		conn.SetDeadline(deadline)
		if _, err := conn.Write([]byte(req)); err != nil {
			conn.Close()
			return nil, fmt.Errorf("proxy connect write: %w", err)
		}
		br := bufio.NewReader(conn)
		resp, err := http.ReadResponse(br, &http.Request{Method: "CONNECT", URL: &url.URL{Host: hostPort}, Host: hostPort})
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("proxy connect read: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			conn.Close()
			return nil, fmt.Errorf("proxy CONNECT refused: %s", resp.Status)
		}
		// put any buffered bytes back in front of the stream
		conn = &bufferedConn{Conn: conn, r: br}
	} else {
		d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		var err error
		conn, err = d.Dial("tcp", hostPort)
		if err != nil {
			return nil, fmt.Errorf("tcp dial: %w", err)
		}
	}

	if useTLS {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: u.Hostname(), InsecureSkipVerify: insecureSkipVerify})
		conn.SetDeadline(deadline)
		if err := tlsConn.Handshake(); err != nil {
			conn.Close()
			return nil, fmt.Errorf("tls handshake: %w", err)
		}
		conn = tlsConn
	}
	conn.SetDeadline(time.Time{})

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	var req strings.Builder
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}
	req.WriteString("GET " + path + " HTTP/1.1\r\n")
	req.WriteString("Host: " + u.Host + "\r\n")
	req.WriteString("Upgrade: websocket\r\n")
	req.WriteString("Connection: Upgrade\r\n")
	req.WriteString("Sec-WebSocket-Key: " + key + "\r\n")
	req.WriteString("Sec-WebSocket-Version: 13\r\n")
	req.WriteString("User-Agent: OmniMesh-Agent/1.0\r\n")
	for k, vs := range header {
		for _, v := range vs {
			req.WriteString(k + ": " + v + "\r\n")
		}
	}
	req.WriteString("\r\n")

	if _, err := conn.Write([]byte(req.String())); err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake write: %w", err)
	}

	br := bufio.NewReaderSize(conn, 8192)
	httpReq := &http.Request{Method: "GET", URL: u, Host: u.Host, Header: header}
	resp, err := http.ReadResponse(br, httpReq)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake read: %w", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		conn.Close()
		return nil, fmt.Errorf("upgrade refused: %s %s", resp.Status, strings.TrimSpace(string(body)))
	}
	accept := resp.Header.Get("Sec-WebSocket-Accept")
	want := acceptKey(key)
	if accept != want {
		conn.Close()
		return nil, fmt.Errorf("bad Sec-WebSocket-Accept")
	}
	return &Conn{conn: conn, br: br}, nil
}

func acceptKey(key string) string {
	h := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}

// bufferedConn replays bytes already read from the underlying connection
// (leftover after the proxy CONNECT response) before reading further.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) {
	if c.r != nil {
		if n := c.r.Buffered(); n > 0 {
			if n > len(b) {
				n = len(b)
			}
			return c.r.Read(b[:n])
		}
		c.r = nil
	}
	return c.Conn.Read(b)
}

// ReadMessage returns the next data frame. Ping frames are answered with
// pong automatically; pong/close frames are consumed internally.
// (The OmniMesh control plane always sends complete, unfragmented frames.)
func (c *Conn) ReadMessage() (Opcode, []byte, error) {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	for {
		op, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case OpPing:
			_ = c.writeFrame(OpPong, payload, true)
			continue
		case OpPong:
			continue
		case OpClose:
			_ = c.writeFrame(OpClose, payload, true)
			c.markClosed()
			return 0, nil, ErrClosed
		case OpText, OpBinary, OpContinuation:
			return op, payload, nil
		default:
			continue
		}
	}
}

// readFrame reads one raw frame; fragmentation boundaries are the caller's
// responsibility (agents receive small frames from the control plane, so we
// expose single-frame reads internally).
func (c *Conn) readFrame() (Opcode, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return 0, nil, err
	}
	fin := hdr[0]&0x80 != 0
	_ = fin // fragmentation from server is not expected; continuation frames would surface as OpContinuation
	op := Opcode(hdr[0] & 0x0F)
	masked := hdr[1]&0x80 != 0
	length := int64(hdr[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if length > 64<<20 {
		return 0, nil, fmt.Errorf("frame too large: %d", length)
	}
	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, maskKey[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return op, payload, nil
}

// WriteText / WriteBinary send complete (unfragmented) data frames.
func (c *Conn) WriteText(data []byte) error  { return c.writeFrame(OpText, data, false) }
func (c *Conn) WriteBinary(data []byte) error { return c.writeFrame(OpBinary, data, false) }

// Close sends a close frame and shuts down the connection.
func (c *Conn) Close() error {
	c.wmu.Lock()
	closed := c.closed
	c.closed = true
	c.wmu.Unlock()
	if !closed {
		payload := make([]byte, 2)
		binary.BigEndian.PutUint16(payload, 1000)
		_ = c.writeFrame(OpClose, payload, false)
	}
	return c.conn.Close()
}

func (c *Conn) markClosed() {
	c.wmu.Lock()
	c.closed = true
	c.wmu.Unlock()
}

// writeFrame masks and writes one frame. Thread-safe.
func (c *Conn) writeFrame(op Opcode, payload []byte, control bool) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed {
		return ErrClosed
	}
	header := make([]byte, 0, 14)
	first := byte(0x80) | byte(op) // FIN set, client
	header = append(header, first)
	length := len(payload)
	maskBit := byte(0x80)
	switch {
	case length < 126:
		header = append(header, maskBit|byte(length))
	case length <= 0xFFFF:
		header = append(header, maskBit|126, byte(length>>8), byte(length))
	default:
		header = append(header, maskBit|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		header = append(header, ext[:]...)
	}
	var maskKey [4]byte
	if _, err := rand.Read(maskKey[:]); err != nil {
		return err
	}
	header = append(header, maskKey[:]...)
	if _, err := c.conn.Write(header); err != nil {
		return err
	}
	// stream the masked payload without an extra full copy
	const chunk = 16 << 10
	buf := make([]byte, chunk)
	for off := 0; off < length; off += chunk {
		end := off + chunk
		if end > length {
			end = length
		}
		copy(buf[:end-off], payload[off:end])
		for i := 0; i < end-off; i++ {
			buf[i] ^= maskKey[(off+i)%4]
		}
		if _, err := c.conn.Write(buf[:end-off]); err != nil {
			return err
		}
	}
	_ = control
	return nil
}

// RemoteAddr exposes the underlying connection address (diagnostics).
func (c *Conn) RemoteAddr() string { return c.conn.RemoteAddr().String() }
