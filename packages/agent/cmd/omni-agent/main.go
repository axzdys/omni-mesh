// OmniMesh Edge Agent — zero-dependency (pure Go stdlib) cross-platform
// probe. Connects outbound to the control plane over WebSocket, reports
// metrics, executes tasks and provides interactive PTY shells.
//
// Usage:
//
//	omni-agent run  -server ws://host:8787 -regkey <key> [-name mypc] [-labels a,b] [-config path]
//	omni-agent service install|uninstall   (systemd on Linux, SCM on Windows)
//	omni-agent --service-run               (invoked by the service manager)
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"omni-agent/internal/client"
	"omni-agent/internal/config"
	"omni-agent/internal/service"
)

var version = "1.0.0"

func main() {
	log.SetFlags(log.Ldate | log.Ltime)

	args := os.Args[1:]

	// service management subcommands
	if len(args) >= 1 && args[0] == "service" {
		args = args[1:]
		if len(args) >= 1 {
			switch args[0] {
			case "install":
				if err := service.Install(); err != nil {
					log.Fatalf("service install failed: %v", err)
				}
				log.Printf("service installed and started")
				return
			case "uninstall":
				if err := service.Uninstall(); err != nil {
					log.Fatalf("service uninstall failed: %v", err)
				}
				log.Printf("service uninstalled")
				return
			}
		}
		log.Fatalf("usage: omni-agent service install|uninstall")
	}

	fs := flag.NewFlagSet("omni-agent", flag.ExitOnError)
	cfgPath := fs.String("config", config.DefaultPath(), "config file path")
	server := fs.String("server", "", "control plane URL, e.g. wss://mesh.example.com")
	token := fs.String("token", "", "existing node token (skip registration)")
	regKey := fs.String("regkey", "", "registration key (first run only)")
	name := fs.String("name", "", "display name (defaults to hostname)")
	labels := fs.String("labels", "", "comma-separated group labels")
	insecure := fs.Bool("insecure", false, "skip TLS certificate verification (self-signed)")
	proxy := fs.String("proxy", "", "HTTP proxy for WSS/registration, e.g. http://127.0.0.1:7897")
	serviceRun := fs.Bool("service-run", false, "internal: run under the service manager")

	if len(args) >= 1 && (args[0] == "run") {
		args = args[1:]
	}
	_ = fs.Parse(args)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg.SetPath(*cfgPath)
	// flags win over file/env
	if *server != "" {
		cfg.Server = *server
	}
	if *token != "" {
		cfg.Token = *token
	}
	if *regKey != "" {
		cfg.RegistrationKey = *regKey
	}
	if *name != "" {
		cfg.Name = *name
	}
	if *labels != "" {
		cfg.Labels = splitLabels(*labels)
	}
	if *insecure {
		cfg.InsecureSkipVerify = true
	}
	if *proxy != "" {
		cfg.Proxy = *proxy
	}
	if cfg.Server == "" {
		// interactive pause: double-clicking the exe from Explorer opens a
		// console that would otherwise flash and vanish before the user can
		// read the error
		fmt.Fprintln(os.Stderr, "\n[错误] 未配置服务器地址")
		fmt.Fprintln(os.Stderr, "  方式一: 在同目录创建 config.json 并填入 {\"server\": \"wss://…\", \"registrationKey\": \"…\"}")
		fmt.Fprintln(os.Stderr, "  方式二: 使用 install-service.bat 一键注册为系统服务")
		fmt.Fprintln(os.Stderr, "\n按回车键退出…")
		bufio.NewReader(os.Stdin).ReadString('\n')
		os.Exit(1)
	}
	if cfg.Name == "" {
		if h, err := os.Hostname(); err == nil && h != "" {
			cfg.Name = h
		} else {
			cfg.Name = "unnamed-node"
		}
	}
	if len(cfg.Labels) == 0 {
		cfg.Labels = []string{runtime.GOOS}
	}

	agent, err := client.New(cfg, version)
	if err != nil {
		log.Fatalf("agent init: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		cancel()
	}()

	run := func(stop <-chan struct{}) error {
		go func() {
			<-stop
			cancel()
		}()
		return agent.Run(ctx)
	}

	if *serviceRun && runtime.GOOS == "windows" {
		// under SCM: logs go nowhere; keep stderr (SCM ignores it) but block
		if err := service.RunAsService(run); err != nil {
			log.Printf("[agent] service error: %v", err)
			os.Exit(1)
		}
		return
	}

	if *serviceRun && runtime.GOOS == "linux" {
		if err := service.RunAsService(run); err != nil {
			log.Printf("[agent] service error: %v", err)
			os.Exit(1)
		}
		return
	}

	log.Printf("omni-agent %s (%s/%s) -> %s  config=%s", version, runtime.GOOS, runtime.GOARCH, cfg.Server, cfg.Path())
	if err := agent.Run(ctx); err != nil && err != context.Canceled {
		log.Printf("[agent] exit: %v", err)
		os.Exit(1)
	}
}

func splitLabels(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
