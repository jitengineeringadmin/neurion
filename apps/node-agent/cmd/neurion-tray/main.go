// Neurion Node — system tray app. Start/stop the node, see status, open the
// dashboard. Connects to the PRODUCTION network and serves the local ollama
// models over the realtime lane for other people. On first start it reads the owner's
// neurionproject.org credentials from credentials.txt (it writes a template and
// opens it if missing), registers once, then deletes the password file.
//
// Build (no console window):
//   go build -ldflags "-H windowsgui" -o bin/neurion-tray.exe ./cmd/neurion-tray
package main

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"fyne.io/systray"
	"github.com/neurionproject/node-agent/internal/agent"
	"github.com/neurionproject/node-agent/internal/config"
)

//go:embed icon.ico
var iconData []byte

const (
	defaultAPI = "https://neurionproject.org"
	defaultWeb = "https://neurionproject.org/app"
	ollamaBase = "http://127.0.0.1:11434/v1"
)

var (
	cancel  context.CancelFunc
	running bool
)

func apiURL() string {
	if v := os.Getenv("NEURION_API"); v != "" {
		return v
	}
	return defaultAPI
}

func neurionDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	d := filepath.Join(dir, "Neurion")
	_ = os.MkdirAll(d, 0o755)
	return d
}
func configPath() string { return filepath.Join(neurionDir(), "neurion-node.yaml") }
func credsPath() string  { return filepath.Join(neurionDir(), "credentials.txt") }

// readCreds pulls email/password from the env or credentials.txt.
func readCreds() (email, pass string) {
	email, pass = os.Getenv("NEURION_EMAIL"), os.Getenv("NEURION_PASSWORD")
	if email != "" && pass != "" {
		return
	}
	b, err := os.ReadFile(credsPath())
	if err != nil {
		return
	}
	for _, l := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		low := strings.ToLower(l)
		if strings.HasPrefix(low, "email:") {
			email = strings.TrimSpace(l[len("email:"):])
		} else if strings.HasPrefix(low, "password:") {
			pass = strings.TrimSpace(l[len("password:"):])
		}
	}
	return
}

func writeCredsTemplate() {
	tmpl := "# Neurion Node — sign in with your neurionproject.org account.\n" +
		"# Fill these in, save this file, then click \"Start node\" in the tray.\n" +
		"email: \npassword: \n"
	_ = os.WriteFile(credsPath(), []byte(tmpl), 0o600)
}

func loadOrRegister() (*config.Config, error) {
	if cfg, err := config.Load(configPath()); err == nil && cfg.Node.NodeID != "" {
		return cfg, nil
	}
	email, pass := readCreds()
	if email == "" || pass == "" {
		writeCredsTemplate()
		open(credsPath())
		return nil, fmt.Errorf("fill credentials.txt")
	}
	name, _ := os.Hostname()
	if name == "" {
		name = "neurion-node"
	}
	cfg, err := agent.Register(apiURL(), email, pass, name)
	if err != nil {
		return nil, err
	}
	// serve realtime chat from the local ollama models
	cfg.Realtime = config.Realtime{Enabled: true, Provider: "openai_compatible", BaseURL: ollamaBase}
	cfg.Node.Modes = []string{"grid", "realtime"}
	_ = cfg.Save(configPath())
	_ = os.Remove(credsPath()) // the password is no longer needed after registration
	return cfg, nil
}

func open(target string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("cmd", "/c", "start", "", target).Start()
	case "darwin":
		_ = exec.Command("open", target).Start()
	default:
		_ = exec.Command("xdg-open", target).Start()
	}
}

func main() {
	systray.Run(onReady, func() {})
}

func onReady() {
	if len(iconData) > 0 {
		systray.SetIcon(iconData)
	}
	systray.SetTitle("Neurion")
	systray.SetTooltip("Neurion Node")

	mStatus := systray.AddMenuItem("● stopped", "node status")
	mStatus.Disable()
	mStart := systray.AddMenuItem("Start node", "connect and share compute")
	mStop := systray.AddMenuItem("Stop node", "disconnect")
	mStop.Disable()
	systray.AddSeparator()
	mWeb := systray.AddMenuItem("Open dashboard", "open the Neurion web app")
	mCreds := systray.AddMenuItem("Set credentials", "edit credentials.txt (your neurionproject.org account)")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "stop and exit")

	setRunning := func(on bool) {
		running = on
		if on {
			mStatus.SetTitle("● sharing your machine")
			mStart.Disable()
			mStop.Enable()
		} else {
			mStatus.SetTitle("● stopped")
			mStart.Enable()
			mStop.Disable()
		}
	}

	start := func() {
		if running {
			return
		}
		mStatus.SetTitle("● connecting…")
		cfg, err := loadOrRegister()
		if err != nil {
			mStatus.SetTitle("● " + err.Error())
			return
		}
		var ctx context.Context
		ctx, cancel = context.WithCancel(context.Background())
		go agent.RunLoop(ctx, cfg)
		setRunning(true)
	}
	stop := func() {
		if cancel != nil {
			cancel()
		}
		setRunning(false)
	}

	for {
		select {
		case <-mStart.ClickedCh:
			start()
		case <-mStop.ClickedCh:
			stop()
		case <-mWeb.ClickedCh:
			open(defaultWeb)
		case <-mCreds.ClickedCh:
			if _, err := os.Stat(credsPath()); err != nil {
				writeCredsTemplate()
			}
			open(credsPath())
		case <-mQuit.ClickedCh:
			stop()
			systray.Quit()
			return
		}
	}
}
