# G3: prepare the local Ollama engine so the Fallback lane serves real tokens.
# Requires ollama installed (https://ollama.com/download) OR `docker compose --profile ai up -d ollama`.
#
# Residency matters more than it looks. Ollama's default TTL unloads a model
# after 5 minutes of inactivity, and reloading it costs seconds of dead time on
# the very first message a user sends (measured: ~9 s for a 7B on a CPU-only
# laptop, far worse for a 20B). Chat requests reach Ollama through the
# OpenAI-compatible /v1 layer, which does NOT carry a keep_alive field — so the
# only way to change that TTL for real traffic is the server-side default set
# here. An application-level preload alone would be undone by the first /v1 call.
[CmdletBinding()]
param(
    # -1 pins models until they are explicitly evicted. Use e.g. '2h' on a shared
    # machine where the memory is needed for other work.
    [string]$KeepAlive = '-1',
    # Start at 1. Every extra resident model costs RAM (or VRAM); raising this
    # before measuring produces evictions, which is slower than not caching.
    [int]$MaxLoadedModels = 1,
    [switch]$SkipPull
)

$ErrorActionPreference = 'Stop'

if (-not $SkipPull) {
    ollama pull phi3:mini
    ollama pull llama3.1:8b
    Write-Host 'Ollama models ready: phi3:mini (fast), llama3.1:8b (default chat)'
}

Write-Host "=== model residency: OLLAMA_KEEP_ALIVE=$KeepAlive OLLAMA_MAX_LOADED_MODELS=$MaxLoadedModels ==="
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', $KeepAlive, 'User')
[Environment]::SetEnvironmentVariable('OLLAMA_MAX_LOADED_MODELS', "$MaxLoadedModels", 'User')

# The server reads these at startup, so a running instance keeps the old values.
$running = Get-Process -Name 'ollama app', 'ollama' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host ''
    Write-Host 'Ollama is already running with the previous settings.' -ForegroundColor Yellow
    Write-Host 'Quit it from the tray icon and reopen it, then check:' -ForegroundColor Yellow
    Write-Host '    ollama ps      # the UNTIL column should read "Forever"' -ForegroundColor Yellow
} else {
    Write-Host 'Start Ollama; the new settings apply on launch.'
}
