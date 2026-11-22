//go:build linux
// +build linux

package service

import (
	"os"
	"os/signal"
	"syscall"
)

func signalNotify(ch chan os.Signal) {
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
}
