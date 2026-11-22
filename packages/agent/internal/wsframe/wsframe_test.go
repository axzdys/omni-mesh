package wsframe

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// minimalServer implements just enough of RFC6455 server-side framing for the
// integration test below, using the same primitives the client uses.
type minimalServer struct {
	w    io.Writer
	br   *strings.Reader
	mu   sync.Mutex
	r    io.Reader
}

func serverFrame(op byte, payload []byte, mask bool) []byte {
	_ = mask // server frames are always unmasked in our tests
	out := []byte{0x80 | op}
	n := len(payload)
	if n < 126 {
		out = append(out, byte(n))
	} else {
		out = append(out, 126, byte(n>>8), byte(n))
	}
	out = append(out, payload...)
	return out
}

func (s *minimalServer) readClientFrame() (op byte, payload []byte, err error) {
	hdr := make([]byte, 2)
	if _, err = io.ReadFull(s.r, hdr); err != nil {
		return 0, nil, err
	}
	op = hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0
	length := int(hdr[1] & 0x7F)
	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err = io.ReadFull(s.r, ext); err != nil {
			return
		}
		length = int(ext[0])<<8 | int(ext[1])
	case 127:
		ext := make([]byte, 8)
		if _, err = io.ReadFull(s.r, ext); err != nil {
			return
		}
		length = 0
		for _, b := range ext {
			length = length<<8 | int(b)
		}
	}
	var maskKey []byte
	if masked {
		maskKey = make([]byte, 4)
		if _, err = io.ReadFull(s.r, maskKey); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(s.r, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return op, payload, nil
}

func TestHandshakeAndFrames(t *testing.T) {
	upgrade := make(chan struct{})
	var serverOut []byte
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.ToLower(r.Header.Get("upgrade")) != "websocket" {
			http.Error(w, "expected upgrade", 400)
			return
		}
		challenge := r.Header.Get("Sec-WebSocket-Key")
		w.Header().Set("Upgrade", "websocket")
		w.Header().Set("Connection", "Upgrade")
		w.Header().Set("Sec-WebSocket-Accept", acceptKey(challenge))
		w.WriteHeader(101)

		hj := w.(http.Hijacker)
		conn, rw, err := hj.Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		defer conn.Close()
		close(upgrade)

		// read one masked client text frame
		s := &minimalServer{r: rw.Reader}
		op, payload, err := s.readClientFrame()
		if err != nil {
			t.Errorf("server read: %v", err)
			return
		}
		mu.Lock()
		serverOut = append([]byte(nil), payload...)
		mu.Unlock()
		if op != 0x1 {
			t.Errorf("server read op = %d", op)
		}

		// echo a binary server frame back
		_, _ = conn.Write(serverFrame(0x2, append([]byte("echo:"), payload...), false))
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, err := Dial(wsURL, false, http.Header{"X-Test": {"1"}}, "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	<-upgrade // handshake response written by the time Dial returns, but the goroutine may lag

	sent := []byte("hello omnimesh")
	if err := conn.WriteText(sent); err != nil {
		t.Fatalf("write text: %v", err)
	}

	// wait for server echo
	op, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if op != OpBinary {
		t.Fatalf("op = %d", op)
	}
	if string(payload) != "echo:"+string(sent) {
		t.Fatalf("payload = %q", payload)
	}

	mu.Lock()
	defer mu.Unlock()
	if string(serverOut) != string(sent) {
		t.Fatalf("server received %q, want %q", serverOut, sent)
	}
}

func TestDialRefusesNonUpgrade(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("plain"))
	}))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	if _, err := Dial(wsURL, false, nil, ""); err == nil {
		t.Fatal("expected error on non-101 response")
	}
}

func TestPingAutoPong(t *testing.T) {
	pongCh := make(chan []byte, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Upgrade", "websocket")
		w.Header().Set("Connection", "Upgrade")
		w.Header().Set("Sec-WebSocket-Accept", acceptKey(r.Header.Get("Sec-WebSocket-Key")))
		w.WriteHeader(101)
		conn, rw, _ := http.NewResponseController(w).Hijack()
		if conn == nil {
			t.Error("hijack failed")
			return
		}
		defer conn.Close()
		// send ping
		_, _ = conn.Write(serverFrame(0x9, []byte("ka"), false))
		s := &minimalServer{r: rw.Reader}
		op, payload, err := s.readClientFrame()
		if err != nil {
			return
		}
		if op == 0xA {
			pongCh <- payload
		}
	}))
	defer srv.Close()
	conn, err := Dial("ws"+strings.TrimPrefix(srv.URL, "http"), false, nil, "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, _, err := conn.ReadMessage()
		select {
		case p := <-pongCh:
			if string(p) != "ka" {
				t.Fatalf("pong payload %q", p)
			}
			return
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("no pong observed")
		}
		if err != nil {
			t.Fatalf("read: %v", err)
		}
	}
}
