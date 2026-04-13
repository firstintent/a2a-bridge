/**
 * `a2a-bridge init` config generation (P6.1).
 *
 * Generates a 32-byte hex bearer token, writes a default config file
 * at `<stateDir>/config.json`, and emits the per-client snippets
 * readers copy into Gemini CLI, OpenClaw (`acpx`), and Zed. Re-running
 * is a no-op unless `--force` is passed: we print the existing config
 * so users can re-copy the snippet without rotating tokens.
 *
 * Exported out of `init.ts` so unit tests can inject the state-dir,
 * token factory, and clock without spawning real filesystem roots.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateDirResolver } from "@shared/state-dir";

export interface InitConfig {
  /** Generated or reused 32-byte bearer token (hex). */
  bearerToken: string;
  /** Loopback host advertised to clients. Defaults to `127.0.0.1`. */
  host: string;
  /** A2A listener port. Defaults to 4520 to match `startA2AServer`. */
  port: number;
  /** Epoch-ms when the config was first written. */
  createdAt: number;
}

export interface RunInitConfigOptions {
  /** Override for the state-dir resolver (tests inject a tmp path). */
  stateDir?: StateDirResolver;
  /** Bypass idempotency — overwrite an existing config with fresh values. */
  force?: boolean;
  /** Optional output sink; defaults to `console.log`. */
  log?: (msg: string) => void;
  /** Token generator (32 bytes, hex). Tests inject deterministic factories. */
  randomToken?: () => string;
  /** Clock — tests inject a fixed value. */
  now?: () => number;
  /** Port override (defaults to 4520). */
  port?: number;
  /** Host override (defaults to 127.0.0.1). */
  host?: string;
}

export interface RunInitConfigResult {
  config: InitConfig;
  /** True when the config.json was written this run; false when reused. */
  created: boolean;
  /** Absolute path of the config file. */
  configPath: string;
}

export function runInitConfig(
  options: RunInitConfigOptions = {},
): RunInitConfigResult {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const stateDir = options.stateDir ?? new StateDirResolver();
  stateDir.ensure();

  const configPath = join(stateDir.dir, "config.json");
  const tokenFactory = options.randomToken ?? generateBearerToken;
  const clock = options.now ?? (() => Date.now());

  let config: InitConfig | null = options.force ? null : readExistingConfig(configPath);
  let created = false;
  if (!config) {
    config = {
      bearerToken: tokenFactory(),
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4520,
      createdAt: clock(),
    };
    writeConfig(configPath, config);
    created = true;
    log(`Wrote ${configPath}`);
    log(`Bearer token (32 bytes, hex): ${config.bearerToken}`);
    log("Keep this token private — it gates the A2A JSON-RPC endpoint.");
  } else {
    log(`Using existing config at ${configPath}`);
    log("Pass --force to rotate the bearer token.");
  }

  log("");
  log(renderSnippets(config));
  return { config, created, configPath };
}

/** ---------- helpers ---------- */

function readExistingConfig(path: string): InitConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<InitConfig>;
    if (
      typeof raw.bearerToken === "string" &&
      typeof raw.host === "string" &&
      typeof raw.port === "number" &&
      typeof raw.createdAt === "number"
    ) {
      return {
        bearerToken: raw.bearerToken,
        host: raw.host,
        port: raw.port,
        createdAt: raw.createdAt,
      };
    }
  } catch {
    /* fall through — treat as missing */
  }
  return null;
}

function writeConfig(path: string, config: InitConfig): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function generateBearerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function renderSnippets(config: InitConfig): string {
  const url = `http://${config.host}:${config.port}`;
  return [
    "Per-client config snippets:",
    "",
    "  # Gemini CLI (~/.gemini/settings.json → `remoteAgents`)",
    "  {",
    '    "remoteAgents": [',
    "      {",
    '        "name": "a2a-bridge",',
    `        "agentCardUrl": "${url}/.well-known/agent-card.json",`,
    '        "auth": {',
    '          "type": "bearer",',
    `          "token": "${config.bearerToken}"`,
    "        }",
    "      }",
    "    ]",
    "  }",
    "",
    "  # OpenClaw (acpx.config.agents)",
    "  {",
    '    "agents": {',
    '      "a2a-bridge": {',
    '        "command": "a2a-bridge",',
    '        "args": ["acp"]',
    "      }",
    "    }",
    "  }",
    "",
    "  # Zed (`agent_servers` in settings.json)",
    "  {",
    '    "agent_servers": {',
    '      "a2a-bridge": {',
    '        "command": "a2a-bridge",',
    '        "args": ["acp"]',
    "      }",
    "    }",
    "  }",
    "",
    "The ACP snippets pipe through `a2a-bridge acp` over stdio — no token",
    "is required on that side; the A2A bearer gates only the HTTP endpoint.",
  ].join("\n");
}
