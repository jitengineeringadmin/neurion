// Neurion Node agent (Agent 06). Cross-platform Go agent: registers a node,
// connects the API over an outbound WebSocket, sends heartbeats, runs grid jobs
// in a hardened Docker sandbox, and proxies realtime chat to a local model.
//
// Build: cd apps/node-agent && go mod download && go build ./cmd/neurion-node
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/neurionproject/node-agent/internal/agent"
	"github.com/neurionproject/node-agent/internal/config"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "register":
		cmdRegister(os.Args[2:])
	case "start":
		cmdStart(os.Args[2:])
	case "status":
		cmdStatus(os.Args[2:])
	case "test-chat":
		fmt.Println("test-chat: start the agent and send a realtime request from the API")
	case "benchmark", "warmup", "test-job", "update":
		fmt.Printf("neurion-node %s: %q is a no-op in this build\n", version, os.Args[1])
	default:
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Println("neurion-node", version)
	fmt.Println("usage: neurion-node <register|start|status|benchmark|warmup|test-job|test-chat>")
	fmt.Println("  register --realtime --realtime-base-url <url> [--realtime-models a,b]  # serve chat to other people")
}

func orAuto(s string) string {
	if strings.TrimSpace(s) == "" {
		return "(auto-discover)"
	}
	return s
}

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

func cmdRegister(args []string) {
	fs := flag.NewFlagSet("register", flag.ExitOnError)
	api := fs.String("api", "http://localhost:8091", "API base URL")
	name := fs.String("name", "neurion-node", "node name")
	email := fs.String("email", os.Getenv("NODE_EMAIL"), "owner email")
	password := fs.String("password", os.Getenv("NODE_PASSWORD"), "owner password")
	token := fs.String("token", os.Getenv("NODE_TOKEN"), "access token (use instead of email/password when already signed in)")
	out := fs.String("config", "neurion-node.yaml", "config output path")
	realtime := fs.Bool("realtime", false, "serve realtime chat (FAST lane) for other people")
	rtProvider := fs.String("realtime-provider", "ds4", "realtime backend label (ds4 | openai_compatible)")
	rtBaseURL := fs.String("realtime-base-url", "http://localhost:11434/v1", "OpenAI-compatible backend: ds4-server (e.g. http://localhost:8080/v1) or ollama")
	rtModels := fs.String("realtime-models", "", "comma-separated model ids; empty = auto-discover from the backend's /models")
	rtKey := fs.String("realtime-api-key", "local-dev", "bearer token for the realtime backend")
	_ = fs.Parse(args)

	if *token == "" && (*email == "" || *password == "") {
		log.Fatal("provide --token, or --email and --password (or NODE_EMAIL/NODE_PASSWORD)")
	}

	var login struct {
		AccessToken string `json:"accessToken"`
	}
	if *token != "" {
		// already signed in — use the token instead of logging in again
		login.AccessToken = *token
	} else if err := httpJSON("POST", *api+"/api/auth/login", map[string]string{"email": *email, "password": *password}, "", &login); err != nil {
		log.Fatal(err)
	}

	var reg struct {
		NodeID  string `json:"nodeId"`
		NodeKey string `json:"nodeKey"`
	}
	body := map[string]any{"name": *name, "supportedJobTypes": agent.SupportedJobTypes()}
	if err := httpJSON("POST", *api+"/api/nodes/register", body, login.AccessToken, &reg); err != nil {
		log.Fatal(err)
	}

	modes := []string{"grid"}
	rt := config.Realtime{Enabled: false, Provider: "openai_compatible", BaseURL: "http://localhost:11434/v1", APIKey: "local-dev"}
	if *realtime {
		modes = []string{"grid", "realtime"}
		var models []string
		for _, m := range strings.Split(*rtModels, ",") {
			if s := strings.TrimSpace(m); s != "" {
				models = append(models, s)
			}
		}
		rt = config.Realtime{Enabled: true, Provider: *rtProvider, BaseURL: *rtBaseURL, APIKey: *rtKey, Models: models}
	}

	cfg := &config.Config{}
	cfg.Node = config.Node{
		Name:    *name,
		APIURL:  *api,
		NodeID:  reg.NodeID,
		NodeKey: reg.NodeKey,
		Modes:   modes,
	}
	cfg.Realtime = rt
	if err := cfg.Save(*out); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("registered node %s — config written to %s\n", reg.NodeID, *out)
	if *realtime {
		fmt.Printf("realtime serving enabled via %s (%s); models: %s\n", *rtBaseURL, *rtProvider, orAuto(*rtModels))
	}
}

func cmdStart(args []string) {
	fs := flag.NewFlagSet("start", flag.ExitOnError)
	path := fs.String("config", "neurion-node.yaml", "config path")
	_ = fs.Parse(args)

	cfg, err := config.Load(*path)
	if err != nil {
		log.Fatal(err)
	}
	for {
		if err := agent.New(cfg).Start(); err != nil {
			log.Printf("agent stopped: %v — reconnecting in 5s", err)
			time.Sleep(5 * time.Second)
		}
	}
}

func cmdStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	path := fs.String("config", "neurion-node.yaml", "config path")
	_ = fs.Parse(args)
	cfg, err := config.Load(*path)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("node %q id=%s api=%s modes=%v\n", cfg.Node.Name, cfg.Node.NodeID, cfg.Node.APIURL, cfg.Node.Modes)
}
