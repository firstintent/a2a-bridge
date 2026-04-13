import { appendFileSync } from "node:fs";

/**
 * Shared logger used by long-lived components (daemon, inbound services,
 * peer adapters, ...). The contract is deliberately tiny: call the
 * returned function with a message string and it is written to an output
 * stream (stderr by default) plus, optionally, an append-only log file.
 *
 * Existing ad-hoc per-component `log()` helpers across the codebase can
 * migrate to this as they are touched; direct rewrites are intentionally
 * out of scope for the task that introduces this module.
 */

export interface LoggerOptions {
  /** Component tag, prefixed on each log line in square brackets. */
  tag: string;
  /** Optional filesystem path the logger appends to. */
  filePath?: string;
  /** Output stream for console logs; defaults to `process.stderr`. */
  stream?: { write(chunk: string): unknown };
}

export type Logger = (msg: string) => void;

export function createLogger(opts: LoggerOptions): Logger {
  const stream = opts.stream ?? process.stderr;
  const tag = opts.tag;
  const filePath = opts.filePath;

  return function log(msg: string): void {
    const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
    try {
      stream.write(line);
    } catch {}
    if (filePath) {
      try {
        appendFileSync(filePath, line);
      } catch {}
    }
  };
}
