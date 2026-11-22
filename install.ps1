# OmniMesh Edge Agent — Windows installer
#
# Usage (elevated PowerShell):
#   .\install.ps1 `
#     -Server "wss://mesh.example.com" `
#     -Token "omni_xxxxxxxxxxxx" `
#     -Name "my-pc" `
#     -Labels "windows-pc,edge"
#
# The agent binary (omni-agent-windows-amd64.exe) must sit next to this
# script, or pass -Binary C:\path\to\omni-agent.exe.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Name = $env:COMPUTERNAME,
  [string]$Labels = "",
  [string]$Binary = ""
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ── admin check ──────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail "run from an elevated PowerShell session" }

# ── locate binary ────────────────────────────────────────────────────────
if (-not $Binary) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $candidate = Join-Path $scriptDir "omni-agent-windows-amd64.exe"
  if (Test-Path $candidate) { $Binary = $candidate }
}
if (-not $Binary -or -not (Test-Path $Binary)) { Fail "agent binary not found next to the script; pass -Binary" }

# ── install binary + config ──────────────────────────────────────────────
$installDir = "$env:ProgramData\omni-agent"
Info "creating $installDir"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

Info "copying binary"
Copy-Item $Binary (Join-Path $installDir "omni-agent.exe") -Force

Info "writing config.json"
$config = @{
  server          = $Server
  registrationKey = $Token
  name            = $Name
}
if ($Labels) { $config.labels = $Labels.Split(",") | ForEach-Object { $_.Trim() } }
$config | ConvertTo-Json | Set-Content (Join-Path $installDir "config.json") -Encoding UTF8

# ── register Windows service (SCM, auto-start) ───────────────────────────
Info "registering service OmniMeshAgent"
& (Join-Path $installDir "omni-agent.exe") service install
if ($LASTEXITCODE -ne 0) { Fail "service install failed (see output above)" }

Info "done. Check the dashboard — the node appears within seconds."
Info "uninstall: omni-agent.exe service uninstall"
