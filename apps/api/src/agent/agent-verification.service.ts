import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface VerificationCommand {
  executable: string;
  args: string[];
  label: string;
}

interface CommandResult {
  command: VerificationCommand;
  ok: boolean;
  output: string;
  exitCode: number | string;
}

@Injectable()
export class AgentVerificationService {
  constructor(private readonly config: ConfigService) {}

  async verify(cwd: string, signal?: AbortSignal): Promise<string> {
    const commands = await this.detect(cwd);
    if (!commands.length) {
      return [
        "VERIFICATION PASSED",
        "No supported automated checks were detected in this project.",
        "Manual review is still recommended.",
      ].join("\n");
    }

    const results: CommandResult[] = [];
    for (const command of commands) {
      results.push(await this.run(command, cwd, signal));
      if (!results[results.length - 1]?.ok) break;
    }
    const passed = results.every((result) => result.ok);
    const lines = [passed ? "VERIFICATION PASSED" : "VERIFICATION FAILED"];
    for (const result of results) {
      lines.push(
        `\n$ ${result.command.label}\nexit: ${result.exitCode}\n${result.output || "(no output)"}`,
      );
    }
    if (!passed)
      lines.push(
        "\nFix the reported error and run verify_project again before finishing.",
      );
    return lines.join("\n").slice(0, 24_000);
  }

  private async detect(cwd: string): Promise<VerificationCommand[]> {
    const packagePath = join(cwd, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
          packageManager?: string;
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};
        const manager = this.packageManager(cwd, pkg.packageManager);
        const executable =
          process.platform === "win32" ? `${manager}.cmd` : manager;
        const selected: string[] = [];
        for (const name of ["typecheck", "test", "lint", "build"]) {
          const body = scripts[name];
          if (!body || /no tests yet|no test specified/i.test(body)) continue;
          selected.push(name);
          if (selected.length >= 3) break;
        }
        return selected.map((name) => ({
          executable,
          args: ["run", name],
          label: `${manager} run ${name}`,
        }));
      } catch {
        return [];
      }
    }

    if (existsSync(join(cwd, "go.mod")))
      return [
        { executable: "go", args: ["test", "./..."], label: "go test ./..." },
      ];
    if (existsSync(join(cwd, "Cargo.toml")))
      return [{ executable: "cargo", args: ["test"], label: "cargo test" }];
    if (
      existsSync(join(cwd, "pytest.ini")) ||
      existsSync(join(cwd, "tests")) ||
      existsSync(join(cwd, "test"))
    ) {
      const python = process.platform === "win32" ? "python.exe" : "python3";
      return [
        {
          executable: python,
          args: ["-m", "pytest", "-q"],
          label: `${python} -m pytest -q`,
        },
      ];
    }
    return [];
  }

  private packageManager(
    cwd: string,
    declared?: string,
  ): "pnpm" | "yarn" | "npm" {
    const name = String(declared ?? "").split("@")[0];
    if (name === "pnpm" || existsSync(join(cwd, "pnpm-lock.yaml")))
      return "pnpm";
    if (name === "yarn" || existsSync(join(cwd, "yarn.lock"))) return "yarn";
    return "npm";
  }

  private run(
    command: VerificationCommand,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const timeout = Math.max(
      10_000,
      Math.min(
        10 * 60_000,
        Number(this.config.get("AGENT_VERIFY_TIMEOUT_MS") ?? 180_000),
      ),
    );
    return new Promise((resolveResult) => {
      const executable =
        process.platform === "win32"
          ? (process.env.ComSpec ?? "cmd.exe")
          : command.executable;
      const args =
        process.platform === "win32"
          ? ["/d", "/s", "/c", command.executable, ...command.args]
          : command.args;
      execFile(
        executable,
        args,
        {
          cwd,
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          signal,
        },
        (error, stdout, stderr) => {
          const combined = `${stdout ?? ""}${stderr ?? ""}`.trim();
          const details = error as NodeJS.ErrnoException & {
            code?: number | string;
            killed?: boolean;
          };
          const timeoutMessage = details?.killed
            ? `Timed out after ${Math.round(timeout / 1000)} seconds.\n`
            : "";
          resolveResult({
            command,
            ok: !error,
            output:
              `${timeoutMessage}${combined || error?.message || ""}`.slice(
                0,
                7_000,
              ),
            exitCode: error ? (details.code ?? "unknown") : 0,
          });
        },
      );
    });
  }
}
