package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"omni-agent/internal/protocol"
	"omni-agent/internal/wsframe"
)

func main() {
	token := os.Args[1]
	mode := os.Args[2] // "quiet" or "heartbeat"
	url := "ws://127.0.0.1:8787/agent/ws?token=" + token
	conn, err := wsframe.Dial(url, false, nil, "")
	if err != nil {
		fmt.Println("dial err:", err)
		return
	}
	fmt.Println("connected", time.Now().Format("15:04:05"))
	authEnv, _ := protocol.NewEnvelope(protocol.TypeAuth, protocol.AuthPayload{Token: token, Version: "probe"})
	b, _ := json.Marshal(authEnv)
	_ = conn.WriteText(b)

	connectedAt := time.Now()
	go func() {
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				fmt.Println("read ended:", err, "after", time.Since(connectedAt), "at", time.Now().Format("15:04:05"))
				os.Exit(0)
			}
		}
	}()

	if mode == "heartbeat" {
		for range time.Tick(15 * time.Second) {
			env, _ := protocol.NewEnvelope(protocol.TypeHeartbeat, protocol.HeartbeatPayload{UptimeSec: 1})
			b, _ := json.Marshal(env)
			_ = conn.WriteText(b)
			fmt.Println("sent heartbeat", time.Now().Format("15:04:05"))
		}
	} else {
		select {} // sleep forever
	}
}
