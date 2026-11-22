// Package config loads/saves the agent configuration file and merges
// environment variables. Flag values (set in main) always win.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Config is the on-disk agent configuration.
type Config struct {
	Server             string   `json:"server"`                       // ws(s)://host[:port]
	Token              string   `json:"token,omitempty"`              // node token after registration
	NodeID             string   `json:"nodeId,omitempty"`             // nd_… after registration
	RegistrationKey    string   `json:"registrationKey,omitempty"`    // only for first registration
	Name               string   `json:"name,omitempty"`
	Labels             []string `json:"labels,omitempty"`
	InsecureSkipVerify bool     `json:"insecureSkipVerify,omitempty"` // allow self-signed TLS for wss://
	Proxy              string   `json:"proxy,omitempty"`              // http://[user:pass@]host:port — tunnel for WSS + registration
	ShellOverride      string   `json:"shell,omitempty"`

	path string `json:"-"`
}

// SetPath pins the config file location (used by -config flag).
func (c *Config) SetPath(p string) { c.path = p }

// Path returns the active config location.
func (c *Config) Path() string {
	if c.path != "" {
		return c.path
	}
	return DefaultPath()
}

// DefaultPath returns the platform-default config file location.
func DefaultPath() string {
	if runtime.GOOS == "windows" {
		root := os.Getenv("ProgramData")
		if root == "" {
			root = `C:\ProgramData`
		}
		return filepath.Join(root, "omni-agent", "config.json")
	}
	if _, err := os.Stat("/etc/omni-agent/config.json"); err == nil {
		return "/etc/omni-agent/config.json"
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		return filepath.Join(home, ".omni-agent", "config.json")
	}
	return "/etc/omni-agent/config.json"
}

// Load reads the config file; a missing file yields an empty config.
func Load(path string) (*Config, error) {
	cfg := &Config{path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	cfg.applyEnv()
	return cfg, nil
}

// applyEnv merges OMNI_* environment variables (file values win over env? —
// flags win over everything; env wins over file).
func (c *Config) applyEnv() {
	if v := os.Getenv("OMNI_SERVER"); v != "" {
		c.Server = v
	}
	if v := os.Getenv("OMNI_TOKEN"); v != "" {
		c.Token = v
	}
	if v := os.Getenv("OMNI_NODE_ID"); v != "" {
		c.NodeID = v
	}
	if v := os.Getenv("OMNI_REG_KEY"); v != "" {
		c.RegistrationKey = v
	}
	if v := os.Getenv("OMNI_NAME"); v != "" {
		c.Name = v
	}
	if v := os.Getenv("OMNI_LABELS"); v != "" {
		c.Labels = splitLabels(v)
	}
	if v := os.Getenv("OMNI_INSECURE"); v == "1" || v == "true" {
		c.InsecureSkipVerify = true
	}
	if v := os.Getenv("OMNI_PROXY"); v != "" {
		c.Proxy = v
	}
	if v := os.Getenv("OMNI_SHELL"); v != "" {
		c.ShellOverride = v
	}
}

// Save persists the config atomically.
func (c *Config) Save() error {
	path := c.Path()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// splitLabels parses "a,b ,c" into ["a","b","c"].
func splitLabels(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		if r != ' ' {
			cur += string(r)
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
