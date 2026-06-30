package agent

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/neurionproject/node-agent/internal/config"
)

// Telemetry helpers. Stdlib only, no third-party deps. Linux-specific readings
// (/proc) compile everywhere — os.ReadFile just errors on non-Linux and we
// degrade to 0. GPU readings work wherever nvidia-smi is on PATH.

func meminfoKb(key string) int {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, key+":") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				v, _ := strconv.Atoi(f[1])
				return v
			}
		}
	}
	return 0
}

func totalRAMMb() int { return meminfoKb("MemTotal") / 1024 }

func usedRAMMb() int {
	total := meminfoKb("MemTotal")
	avail := meminfoKb("MemAvailable")
	if total == 0 || avail == 0 || avail > total {
		return 0
	}
	return (total - avail) / 1024
}

func cpuModelName() string {
	b, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "model name") {
			if i := strings.Index(line, ":"); i >= 0 {
				return strings.TrimSpace(line[i+1:])
			}
		}
	}
	return ""
}

// cpuStat returns (idle, total) jiffies from the aggregate /proc/stat cpu line.
func cpuStat() (idle, total uint64) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "cpu ") {
			for i, v := range strings.Fields(line)[1:] {
				n, _ := strconv.ParseUint(v, 10, 64)
				total += n
				if i == 3 { // idle is the 4th value
					idle = n
				}
			}
			return idle, total
		}
	}
	return 0, 0
}

// sampleCPULoad returns CPU utilization % over a short window (Linux only).
func sampleCPULoad() float64 {
	if runtime.GOOS != "linux" {
		return 0
	}
	i1, t1 := cpuStat()
	time.Sleep(200 * time.Millisecond)
	i2, t2 := cpuStat()
	dt := float64(t2 - t1)
	di := float64(i2 - i1)
	if dt <= 0 {
		return 0
	}
	load := (1 - di/dt) * 100
	if load < 0 {
		load = 0
	}
	return float64(int(load*10)) / 10
}

// nvidiaQuery returns the first GPU's comma-separated values for the given fields.
func nvidiaQuery(fields string) ([]string, bool) {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return nil, false
	}
	out, err := exec.Command("nvidia-smi", "--query-gpu="+fields, "--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil, false
	}
	line := strings.TrimSpace(strings.Split(string(out), "\n")[0])
	if line == "" {
		return nil, false
	}
	parts := strings.Split(line, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts, true
}

func gpuStaticInfo() (vendor, model string, memMb int) {
	p, ok := nvidiaQuery("name,memory.total")
	if !ok || len(p) < 2 {
		return "", "", 0
	}
	mem, _ := strconv.Atoi(p[1])
	return "nvidia", p[0], mem
}

func gpuLoadTemp() (load, temp float64, ok bool) {
	p, q := nvidiaQuery("utilization.gpu,temperature.gpu")
	if !q || len(p) < 2 {
		return 0, 0, false
	}
	l, _ := strconv.ParseFloat(p[0], 64)
	t, _ := strconv.ParseFloat(p[1], 64)
	return l, t, true
}

// benchmarkRealtime sends one tiny streamed completion to the local backend and
// measures time-to-first-token and tokens/sec, so the node advertises real speed
// at hello (instead of leaving the fields empty).
func benchmarkRealtime(cfg *config.Config, model string) (firstTokenMs int, tokPerSec float64, ok bool) {
	body, _ := json.Marshal(map[string]any{
		"model":    model,
		"messages": []map[string]string{{"role": "user", "content": "Reply with a short greeting."}},
		"stream":   true,
	})
	req, _ := http.NewRequest("POST", cfg.Realtime.BaseURL+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if cfg.Realtime.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.Realtime.APIKey)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, 0, false
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	var firstAt time.Duration
	tokens := 0
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
				if tokens == 0 {
					firstAt = time.Since(start)
				}
				tokens++
			}
		}
	}
	if tokens == 0 {
		return 0, 0, false
	}
	elapsed := time.Since(start).Seconds()
	tps := 0.0
	if elapsed > 0 {
		tps = float64(tokens) / elapsed
	}
	return int(firstAt.Milliseconds()), float64(int(tps*10)) / 10, true
}
