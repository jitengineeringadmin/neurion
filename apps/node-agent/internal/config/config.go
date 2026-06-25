package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

type Limits struct {
	MaxCpuPercent int `yaml:"maxCpuPercent"`
	MaxGpuPercent int `yaml:"maxGpuPercent"`
	MaxGpuTempC   int `yaml:"maxGpuTempC"`
	MaxPowerWatts int `yaml:"maxPowerWatts"`
	MaxJobSeconds int `yaml:"maxJobSeconds"`
	MaxDiskMb     int `yaml:"maxDiskMb"`
}

type Realtime struct {
	Enabled  bool     `yaml:"enabled"`
	Provider string   `yaml:"provider"`
	BaseURL  string   `yaml:"baseUrl"`
	APIKey   string   `yaml:"apiKey"`
	Models   []string `yaml:"models"`
}

type Node struct {
	Name              string   `yaml:"name"`
	APIURL            string   `yaml:"apiUrl"`
	NodeID            string   `yaml:"nodeId"`
	NodeKey           string   `yaml:"nodeKey"`
	Modes             []string `yaml:"modes"`
	MaxConcurrentJobs int      `yaml:"maxConcurrentJobs"`
	AllowGpu          bool     `yaml:"allowGpu"`
	AllowedJobTypes   []string `yaml:"allowedJobTypes"`
	WorkingDir        string   `yaml:"workingDir"`
	Limits            Limits   `yaml:"limits"`
}

type Config struct {
	Node     Node     `yaml:"node"`
	Realtime Realtime `yaml:"realtime"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if c.Node.WorkingDir == "" {
		c.Node.WorkingDir = "./neurion-work"
	}
	if c.Node.MaxConcurrentJobs == 0 {
		c.Node.MaxConcurrentJobs = 1
	}
	return &c, nil
}

func (c *Config) Save(path string) error {
	out, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o600)
}
