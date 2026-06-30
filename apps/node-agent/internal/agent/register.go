package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/neurionproject/node-agent/internal/config"
)

func httpJSON(method, url string, body any, token string, out any) error {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, rdr)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s -> %d: %s", method, url, resp.StatusCode, string(data))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Register logs in as the node owner, registers a node, and returns a ready config.
func Register(apiURL, email, password, name string) (*config.Config, error) {
	var login struct {
		AccessToken string `json:"accessToken"`
	}
	if err := httpJSON("POST", apiURL+"/api/auth/login", map[string]string{"email": email, "password": password}, "", &login); err != nil {
		return nil, err
	}
	var reg struct {
		NodeID  string `json:"nodeId"`
		NodeKey string `json:"nodeKey"`
	}
	body := map[string]any{"name": name, "supportedJobTypes": SupportedJobTypes()}
	if err := httpJSON("POST", apiURL+"/api/nodes/register", body, login.AccessToken, &reg); err != nil {
		return nil, err
	}
	cfg := &config.Config{}
	cfg.Node = config.Node{
		Name: name, APIURL: apiURL, NodeID: reg.NodeID, NodeKey: reg.NodeKey,
		Modes: []string{"grid"}, MaxConcurrentJobs: 1, WorkingDir: "./neurion-work",
	}
	cfg.Realtime = config.Realtime{Enabled: false, Provider: "openai_compatible", BaseURL: "http://localhost:11434/v1", APIKey: "local-dev"}
	return cfg, nil
}

// RunLoop runs the agent with auto-reconnect until ctx is cancelled.
func RunLoop(ctx context.Context, cfg *config.Config) {
	for {
		if ctx.Err() != nil {
			return
		}
		_ = New(cfg).StartCtx(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}
