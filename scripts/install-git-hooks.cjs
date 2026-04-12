#!/usr/bin/env node

/**
 * Dev-only: wire the repo's tracked `.githooks/` directory as the
 * active git hooks directory. Runs from npm's `prepare` lifecycle,
 * which fires on `bun install` / `npm install` in a local clone but
 * NOT on `npm install -g <published-package>`.
 *
 * Silent no-op when:
 *   - not inside a git work tree (e.g. installed from a tarball),
 *   - the `.githooks/` directory is not present (e.g. installed
 *     from the published package without repo sources),
 *   - CI=1 (CI runners manage hooks themselves).
 */

const { execFileSync } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");

if (process.env.CI === "true" || process.env.CI === "1") {
  process.exit(0);
}

const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
})();

if (!repoRoot) process.exit(0);
if (!existsSync(join(repoRoot, ".githooks"))) process.exit(0);

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  console.log(
    "\x1b[32m✔\x1b[0m a2a-bridge: git hooks directory set to .githooks/",
  );
} catch (err) {
  console.warn(
    `\x1b[33m⚠\x1b[0m a2a-bridge: failed to set core.hooksPath (${err.message})`,
  );
}
