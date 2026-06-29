# Neurion Node Agent (Go)

Cross-platform agent (Agent 06). Registers a node, connects the API over an
outbound WebSocket, sends heartbeats, runs grid jobs in a hardened Docker
sandbox (G15), and proxies realtime chat to a local OpenAI-compatible model.

## Build

Requires Go 1.22+ (not bundled — install separately).

```bash
cd apps/node-agent
go mod download
go build -o bin/neurion-node ./cmd/neurion-node
```

## Use

```bash
# register (logs in as the node owner, stores nodeId/nodeKey in neurion-node.yaml)
NODE_EMAIL=node@neurion.local NODE_PASSWORD='ChangeMe!Node2026' \
  ./bin/neurion-node register --api http://localhost:8091 --name "Local Test Node"

# run (connects, heartbeats, executes grid jobs + realtime chat)
./bin/neurion-node start --config neurion-node.yaml

./bin/neurion-node status
```

## Notes

- Behaviour mirrors the verified TS reference node at `apps/workers/fake-node/`
  (used for end-to-end testing while Go is unavailable).
- Grid jobs run ONLY allowlisted `neurion/*` images with:
  `--network none --cap-drop ALL --security-opt no-new-privileges --read-only
  --pids-limit 256 --memory 2048m --cpus 1` and a timeout (G15).
- Realtime mode requires a local model endpoint (e.g. ollama) per the config.
