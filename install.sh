#!/usr/bin/env bash
# OmniMesh Edge Agent — Linux installer
#
# Usage:
#   sudo ./install.sh \
#     --server wss://mesh.example.com \
#     --token omni_xxxxxxxxxxxxxxxx \
#     --name my-server \
#     --labels prod,backup
#
# The agent binary (omni-agent-linux-amd64 / -arm64) must sit next to this
# script, or pass --binary /path/to/omni-agent.
set -euo pipefail

SERVER=""
TOKEN=""
NAME=""
LABELS=""
BINARY=""
CONFIG_DIR="/etc/omni-agent"
CONFIG_FILE="$CONFIG_DIR/config.json"

err()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# ── parse args ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token|--regkey) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    --binary) BINARY="$2"; shift 2 ;;
    *) err "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || err "run as root (sudo)"
[[ -n "$SERVER" ]] || err "--server is required (wss://… or ws://…)"
[[ -n "$TOKEN" ]] || err "--token (registration key) is required"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH_SUFFIX="amd64" ;;
  aarch64) ARCH_SUFFIX="arm64" ;;
  *) err "unsupported architecture: $ARCH" ;;
esac

# ── locate binary ────────────────────────────────────────────────────────
if [[ -z "$BINARY" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for cand in "$SCRIPT_DIR/omni-agent-linux-$ARCH_SUFFIX" "$SCRIPT_DIR/omni-agent"; do
    [[ -f "$cand" ]] && BINARY="$cand" && break
  done
fi
[[ -n "$BINARY" && -f "$BINARY" ]] || err "agent binary not found next to the script; pass --binary"

# ── install binary ───────────────────────────────────────────────────────
info "installing binary to /usr/local/bin/omni-agent"
install -m 0755 "$BINARY" /usr/local/bin/omni-agent

# ── write config ─────────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
info "writing $CONFIG_FILE"
LABEL_JSON="[]"
if [[ -n "$LABELS" ]]; then
  LABEL_JSON="[$(echo "$LABELS" | awk -F, '{for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}}')]"
fi
NAME="${NAME:-$(hostname)}"
cat > "$CONFIG_FILE" <<EOF
{
  "server": "$SERVER",
  "registrationKey": "$TOKEN",
  "name": "$NAME",
  "labels": $LABEL_JSON
}
EOF
chmod 600 "$CONFIG_FILE"

# ── systemd unit ─────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1; then
  info "registering systemd service"
  cat > /etc/systemd/system/omni-agent.service <<EOF
[Unit]
Description=OmniMesh Edge Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/omni-agent run --config $CONFIG_FILE
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now omni-agent.service
  info "service started — check with: systemctl status omni-agent"
else
  err "systemd not found — start manually: /usr/local/bin/omni-agent run --config $CONFIG_FILE"
fi

info "done. The node will appear in the OmniMesh dashboard within seconds."
