# G3: pull the real local chat models so the Fallback lane serves real tokens.
# Requires ollama installed (https://ollama.com/download) OR `docker compose --profile ai up -d ollama`.
ollama pull phi3:mini
ollama pull llama3.1:8b
Write-Host "Ollama models ready: phi3:mini (fast), llama3.1:8b (default chat)"
