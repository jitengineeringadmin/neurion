# Neurion Node Agent (Go) — superseded, not built or published

> **Read this first.** This agent belongs to the earlier design: a machine
> registered with *our* API and held a WebSocket open to it, so the network only
> existed as long as the company behind it did. The peer network replaced that —
> peers find each other through a distributed index and talk to each other
> directly, and no part of it needs neurionproject.org to be alive.
>
> It is no longer built into releases and no longer offered on the site. The
> source stays here because it is the record of how this worked before, and CI
> still compiles it so it does not quietly rot. If you want to run a machine for
> the network, install the desktop app and leave a way in open — see
> `docs/architecture/run-a-node.md`.

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
