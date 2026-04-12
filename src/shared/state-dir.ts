import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

/**
 * Resolves the shared runtime state directory for A2aBridge.
 *
 * macOS:  ~/Library/Application Support/A2aBridge
 * Linux:  ${XDG_STATE_HOME:-~/.local/state}/a2a-bridge
 * Override: A2A_BRIDGE_STATE_DIR env var
 *
 * This directory stores daemon pid, managed TUI pid, lock, status, ports, and logs.
 * It is NOT for project-level config (that lives in .a2a-bridge/).
 */
export class StateDirResolver {
  private readonly stateDir: string;

  constructor(envOverride?: string) {
    const override = envOverride ?? process.env.A2A_BRIDGE_STATE_DIR;
    if (override) {
      this.stateDir = override;
    } else if (platform() === "darwin") {
      this.stateDir = join(homedir(), "Library", "Application Support", "A2aBridge");
    } else {
      const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
      this.stateDir = join(xdgState, "a2a-bridge");
    }
  }

  /** Ensure the state directory exists. */
  ensure(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  get dir(): string {
    return this.stateDir;
  }

  get pidFile(): string {
    return join(this.stateDir, "daemon.pid");
  }

  get tuiPidFile(): string {
    return join(this.stateDir, "codex-tui.pid");
  }

  get lockFile(): string {
    return join(this.stateDir, "daemon.lock");
  }

  get statusFile(): string {
    return join(this.stateDir, "status.json");
  }

  get portsFile(): string {
    return join(this.stateDir, "ports.json");
  }

  get logFile(): string {
    return join(this.stateDir, "a2a-bridge.log");
  }

  get killedFile(): string {
    return join(this.stateDir, "killed");
  }
}
