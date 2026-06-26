package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jit-engineering/neurion/node-agent/internal/config"
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
	loaded := []string{}
	if cfg.Realtime.Enabled {
		loaded = cfg.Realtime.Models
	}
	return map[string]any{
		"modes":           cfg.Node.Modes,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"cpuCores":        runtime.NumCPU(),
		"dockerAvailable": dockerErr == nil,
		"nvidiaAvailable": nvidiaErr == nil,
		"loadedModels":    loaded,
	}
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
		_ = conn.Close()
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
		if err := a.send(map[string]any{
			"type":    "node.heartbeat",
			"nodeId":  a.cfg.Node.NodeID,
			"metrics": map[string]any{"cpuLoad": 0, "ramUsedMb": 0},
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
			go a.runGridJob(msg["job"].(map[string]any))
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
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		_ = a.send(map[string]any{"type": "realtime.chat.error", "requestId": reqID, "message": "provider error"})
		if resp != nil {
			resp.Body.Close()
		}
		return
	}
	defer resp.Body.Close()

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
	_ = a.send(map[string]any{"type": "realtime.chat.done", "requestId": reqID, "usage": map[string]any{}})
}
