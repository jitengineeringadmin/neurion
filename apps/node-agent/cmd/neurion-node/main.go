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
	"time"

	"github.com/jit-engineering/neurion/node-agent/internal/agent"
	"github.com/jit-engineering/neurion/node-agent/internal/config"
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
	out := fs.String("config", "neurion-node.yaml", "config output path")
	_ = fs.Parse(args)

	if *email == "" || *password == "" {
		log.Fatal("provide --email and --password (or NODE_EMAIL/NODE_PASSWORD)")
	}

	var login struct {
		AccessToken string `json:"accessToken"`
	}
	if err := httpJSON("POST", *api+"/api/auth/login", map[string]string{"email": *email, "password": *password}, "", &login); err != nil {
		log.Fatal(err)
	}

	var reg struct {
		NodeID  string `json:"nodeId"`
		NodeKey string `json:"nodeKey"`
	}
	body := map[string]any{"name": *name, "supportedJobTypes": []string{"echo.v1", "embedding.v1"}}
	if err := httpJSON("POST", *api+"/api/nodes/register", body, login.AccessToken, &reg); err != nil {
		log.Fatal(err)
	}

	cfg := &config.Config{}
	cfg.Node = config.Node{
		Name:    *name,
		APIURL:  *api,
		NodeID:  reg.NodeID,
		NodeKey: reg.NodeKey,
		Modes:   []string{"grid"},
	}
	cfg.Realtime = config.Realtime{Enabled: false, Provider: "openai_compatible", BaseURL: "http://localhost:11434/v1", APIKey: "local-dev"}
	if err := cfg.Save(*out); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("registered node %s — config written to %s\n", reg.NodeID, *out)
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
