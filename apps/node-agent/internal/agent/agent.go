package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/neurionproject/node-agent/internal/config"
)

// workerImages maps a job type to its allowlisted container image (G15).
var workerImages = map[string]string{
	"echo.v1":      "neurion/echo-worker:0.1.0",
	"embedding.v1": "neurion/embedding-worker:0.1.0",
}

type Agent struct {
	cfg  *config.Config
	conn *websocket.Conn
	mu   sync.Mutex // guards conn writes
	sem  chan struct{}
}

func New(cfg *config.Config) *Agent {
	n := cfg.Node.MaxConcurrentJobs
	if n < 1 {
		n = 1
	}
	return &Agent{cfg: cfg, sem: make(chan struct{}, n)}
}

func DetectCapabilities(cfg *config.Config) map[string]any {
	_, dockerErr := exec.LookPath("docker")
	_, nvidiaErr := exec.LookPath("nvidia-smi")
	loaded := realtimeModels(cfg)
	caps := map[string]any{
		"modes":           advertisedModes(cfg, loaded),
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"cpuCores":        runtime.NumCPU(),
		"dockerAvailable": dockerErr == nil,
		"nvidiaAvailable": nvidiaErr == nil,
		"loadedModels":    loaded,
	}
	if m := cpuModelName(); m != "" {
		caps["cpuModel"] = m
	}
	if r := totalRAMMb(); r > 0 {
		caps["ramMb"] = r
	}
	if vendor, model, mem := gpuStaticInfo(); vendor != "" {
		caps["gpuVendor"] = vendor
		caps["gpuModel"] = model
		if mem > 0 {
			caps["gpuMemoryMb"] = mem
		}
	}
	// Warmup benchmark: advertise measured speed when this node can actually serve.
	if len(loaded) > 0 {
		if ft, tps, ok := benchmarkRealtime(cfg, loaded[0]); ok {
			caps["avgFirstTokenMs"] = ft
			caps["avgTokensPerSecond"] = tps
			log.Printf("benchmark %s: first-token %dms, %.1f tok/s", loaded[0], ft, tps)
		}
	}
	return caps
}

// realtimeModels returns the model ids this node serves over the realtime lane.
// Uses the configured list (after a reachability check) or auto-discovers from
// the OpenAI-compatible backend (ds4-server / ollama) via GET /models. Returns
// an empty slice when realtime is off or the backend is unreachable, so the node
// never advertises a lane it cannot actually serve.
func realtimeModels(cfg *config.Config) []string {
	if !cfg.Realtime.Enabled {
		return []string{}
	}
	if len(cfg.Realtime.Models) > 0 {
		if _, err := discoverModels(cfg); err != nil {
			log.Printf("realtime: backend %s unreachable (%v) — not advertising realtime", cfg.Realtime.BaseURL, err)
			return []string{}
		}
		return cfg.Realtime.Models
	}
	models, err := discoverModels(cfg)
	if err != nil {
		log.Printf("realtime: model discovery from %s failed (%v) — not advertising realtime", cfg.Realtime.BaseURL, err)
		return []string{}
	}
	log.Printf("realtime: discovered %d model(s) from %s: %v", len(models), cfg.Realtime.BaseURL, models)
	return models
}

// discoverModels queries the OpenAI-compatible /models endpoint of the realtime backend.
func discoverModels(cfg *config.Config) ([]string, error) {
	req, _ := http.NewRequest("GET", cfg.Realtime.BaseURL+"/models", nil)
	if cfg.Realtime.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.Realtime.APIKey)
	}
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("models endpoint returned %d", resp.StatusCode)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("no models reported")
	}
	return ids, nil
}

// advertisedModes returns the node's modes, dropping "realtime" when there are no
// servable realtime models (backend disabled or unreachable).
func advertisedModes(cfg *config.Config, loaded []string) []string {
	if len(loaded) > 0 {
		return cfg.Node.Modes
	}
	out := make([]string, 0, len(cfg.Node.Modes))
	for _, m := range cfg.Node.Modes {
		if m != "realtime" {
			out = append(out, m)
		}
	}
	return out
}

func (a *Agent) send(v any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.conn.WriteJSON(v)
}

// Start connects, says hello, and runs the heartbeat + read loops until error.
func (a *Agent) Start() error { return a.StartCtx(context.Background()) }

// StartCtx is Start with cancellation: when ctx is done, the connection closes
// and the loops return.
func (a *Agent) StartCtx(ctx context.Context) error {
	wsURL := strings.Replace(a.cfg.Node.APIURL, "http", "ws", 1) + "/ws/nodes"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	a.conn = conn
	defer conn.Close()
	go func() {
		<-ctx.Done()
		a.mu.Lock()
		_ = conn.Close() // serialize with send()'s WriteJSON to avoid a write/close data race
		a.mu.Unlock()
	}()

	if err := a.send(map[string]any{
		"type":         "node.hello",
		"nodeId":       a.cfg.Node.NodeID,
		"nodeKey":      a.cfg.Node.NodeKey,
		"agentVersion": "0.1.0",
		"capabilities": DetectCapabilities(a.cfg),
	}); err != nil {
		return err
	}

	go a.heartbeatLoop()
	log.Printf("connected as node %s", a.cfg.Node.NodeID)
	return a.readLoop()
}

func (a *Agent) heartbeatLoop() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for range t.C {
		metrics := map[string]any{
			"cpuLoad":   sampleCPULoad(),
			"ramUsedMb": usedRAMMb(),
		}
		if load, temp, ok := gpuLoadTemp(); ok {
			metrics["gpuLoad"] = load
			metrics["gpuTempC"] = temp
		}
		if err := a.send(map[string]any{
			"type":    "node.heartbeat",
			"nodeId":  a.cfg.Node.NodeID,
			"metrics": metrics,
		}); err != nil {
			return
		}
	}
}

func (a *Agent) readLoop() error {
	for {
		_, raw, err := a.conn.ReadMessage()
		if err != nil {
			return err
		}
		var msg map[string]any
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg["type"] {
		case "hello.ok":
			log.Println("hello.ok — online")
		case "hello.rejected":
			return fmt.Errorf("hello rejected: %v", msg["reason"])
		case "job.assign":
			if job, ok := msg["job"].(map[string]any); ok {
				go a.runGridJob(job)
			}
		case "realtime.chat.request":
			go a.proxyRealtime(msg)
		}
	}
}

func (a *Agent) runGridJob(job map[string]any) {
	a.sem <- struct{}{}
	defer func() { <-a.sem }()

	jobID, _ := job["id"].(string)
	jobType, _ := job["type"].(string)
	image := workerImages[jobType]
	if image == "" {
		_ = a.send(map[string]any{"type": "job.failed", "jobId": jobID, "errorMessage": "unknown job type"})
		return
	}
	_ = a.send(map[string]any{"type": "job.accepted", "jobId": jobID})

	dir, _ := filepath.Abs(filepath.Join(a.cfg.Node.WorkingDir, jobID)) // absolute: docker bind mounts require it
	if err := os.MkdirAll(dir, 0o755); err != nil {
		_ = a.send(map[string]any{"type": "job.failed", "jobId": jobID, "errorMessage": err.Error()})
		return
	}
	defer os.RemoveAll(dir)

	in, _ := json.Marshal(job["inputJson"])
	if err := os.WriteFile(filepath.Join(dir, "input.json"), in, 0o644); err != nil {
		_ = a.send(map[string]any{"type": "job.failed", "jobId": jobID, "errorMessage": err.Error()})
		return
	}
	_ = a.send(map[string]any{"type": "job.started", "jobId": jobID})

	timeout := a.cfg.Node.Limits.MaxJobSeconds
	if timeout == 0 {
		timeout = 300
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	// G15: hardened sandbox — no network, dropped caps, read-only rootfs,
	// pid/memory/cpu limits, no privilege escalation. Only allowlisted images run.
	args := []string{
		"run", "--rm",
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--read-only",
		"--pids-limit", "256",
		"--memory", "2048m",
		"--cpus", "1",
		"-v", dir + ":/job",
		image,
		"--input", "/job/input.json", "--output", "/job/output.json",
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = a.send(map[string]any{"type": "job.failed", "jobId": jobID, "errorMessage": err.Error() + ": " + stderr.String()})
		return
	}

	out, err := os.ReadFile(filepath.Join(dir, "output.json"))
	if err != nil {
		_ = a.send(map[string]any{"type": "job.failed", "jobId": jobID, "errorMessage": "no output: " + err.Error()})
		return
	}
	var outputJSON any
	_ = json.Unmarshal(out, &outputJSON)
	_ = a.send(map[string]any{"type": "job.completed", "jobId": jobID, "outputJson": outputJSON})
	log.Printf("job %s completed", jobID)
}

func (a *Agent) proxyRealtime(msg map[string]any) {
	reqID, _ := msg["requestId"].(string)
	body, _ := json.Marshal(map[string]any{
		"model":    msg["model"],
		"messages": msg["messages"],
		"stream":   true,
	})
	req, _ := http.NewRequest("POST", a.cfg.Realtime.BaseURL+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if a.cfg.Realtime.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.cfg.Realtime.APIKey)
	}
	// ResponseHeaderTimeout bounds time-to-first-byte (catches a hung/cold ds4
	// backend) without capping total stream duration for long generations.
	client := &http.Client{Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		ResponseHeaderTimeout: 30 * time.Second,
	}}
	resp, err := client.Do(req)
	if err != nil {
		_ = a.send(map[string]any{"type": "realtime.chat.error", "requestId": reqID, "message": "backend unreachable: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		_ = a.send(map[string]any{"type": "realtime.chat.error", "requestId": reqID, "message": fmt.Sprintf("backend %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))})
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) == nil && len(chunk.Choices) > 0 {
			if d := chunk.Choices[0].Delta.Content; d != "" {
				_ = a.send(map[string]any{"type": "realtime.chat.token", "requestId": reqID, "text": d})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		// stream cut short (I/O error, oversized line) — report instead of a false "done"
		_ = a.send(map[string]any{"type": "realtime.chat.error", "requestId": reqID, "message": "stream read error: " + err.Error()})
		return
	}
	_ = a.send(map[string]any{"type": "realtime.chat.done", "requestId": reqID, "usage": map[string]any{}})
}
