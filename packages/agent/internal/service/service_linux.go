//go:build linux
// +build linux

// Linux service management: systemd unit install/uninstall (root required).
package service

import (
	"fmt"
	"os"
	"os/exec"
)

const unitPath = "/etc/systemd/system/omni-agent.service"

// Install writes the systemd unit and enables + starts the service.
func Install() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cfgPath := configPathForUnit()
	unit := fmt.Sprintf(`[Unit]
Description=OmniMesh Edge Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s run --config %s
Restart=always
RestartSec=5
Nice=5
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=%s /var/log
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`, exe, cfgPath, dirOf(cfgPath))

	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("write unit (need root): %w", err)
	}
	for _, cmd := range [][]string{
		{"systemctl", "daemon-reload"},
		{"systemctl", "enable", "--now", "omni-agent.service"},
	} {
		if out, err := exec.Command(cmd[0], cmd[1:]...).CombinedOutput(); err != nil {
			return fmt.Errorf("%v: %v — %s", cmd, err, string(out))
		}
	}
	return nil
}

// Uninstall stops and removes the systemd unit.
func Uninstall() error {
	for _, cmd := range [][]string{
		{"systemctl", "disable", "--now", "omni-agent.service"},
	} {
		_ = exec.Command(cmd[0], cmd[1:]...).Run()
	}
	if err := os.Remove(unitPath); err != nil {
		return err
	}
	return exec.Command("systemctl", "daemon-reload").Run()
}

// RunAsService on Linux simply runs the agent in the foreground (systemd
// supervises the process). stop closes when the agent should exit.
func RunAsService(run func(stop <-chan struct{}) error) error {
	stop := make(chan struct{})
	// relay SIGTERM/SIGINT to stop
	sig := make(chan os.Signal, 1)
	signalNotify(sig)
	go func() {
		<-sig
		close(stop)
	}()
	return run(stop)
}

func configPathForUnit() string { return "/etc/omni-agent/config.json" }
func dirOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return "/"
}
