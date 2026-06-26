// Neurion Node — system tray app. Start/stop the node, see status, open the
// dashboard. Auto-registers on first start using the node-owner credentials.
//
// Build (no console window):
//   go build -ldflags "-H windowsgui" -o bin/neurion-tray.exe ./cmd/neurion-tray
package main

import (
	"context"
	_ "embed"
	"os"
	"os/exec"
	"path/filepath"

	"fyne.io/systray"
	"github.com/jit-engineering/neurion/node-agent/internal/agent"
	"github.com/jit-engineering/neurion/node-agent/internal/config"
)

//go:embed icon.ico
var iconData []byte

const (
	defaultAPI = "http://localhost:8091"
	defaultWeb = "http://localhost:3091"
	ownerEmail = "node@neurion.local"
	ownerPass  = "ChangeMe!Node2026"
)

var (
	cancel  context.CancelFunc
	running bool
)

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	d := filepath.Join(dir, "Neurion")
	_ = os.MkdirAll(d, 0o755)
	return filepath.Join(d, "neurion-node.yaml")
}

func loadOrRegister() (*config.Config, error) {
	path := configPath()
	if cfg, err := config.Load(path); err == nil && cfg.Node.NodeID != "" {
		return cfg, nil
	}
	name, _ := os.Hostname()
	if name == "" {
		name = "neurion-node"
	}
	cfg, err := agent.Register(defaultAPI, ownerEmail, ownerPass, name)
	if err != nil {
		return nil, err
	}
	_ = cfg.Save(path)
	return cfg, nil
}

func open(target string) {
	_ = exec.Command("cmd", "/c", "start", "", target).Start()
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
	mCfg := systray.AddMenuItem("Edit config", "open neurion-node.yaml")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "stop and exit")

	setRunning := func(on bool) {
		running = on
		if on {
			mStatus.SetTitle("● running")
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
			mStatus.SetTitle("● error: register failed")
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
		case <-mCfg.ClickedCh:
			_ = exec.Command("notepad", configPath()).Start()
		case <-mQuit.ClickedCh:
			stop()
			systray.Quit()
			return
		}
	}
}
