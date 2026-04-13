# PUBLISH — release runbook for a2a-bridge

This runbook takes a2a-bridge from "all tasks checked on dev" to
"v0.1.0 live on npm, in the Claude Code marketplace, and in the
public ACP registry." Follow the steps in order; every step has a
verification command that must pass before moving on.

The autonomous loop produces every artifact referenced here.
This runbook is what the human operator does the day-of, since
npm publish and marketplace submission need credentials the loop
cannot hold.

## Preconditions

- You are a maintainer with:
  - Push rights to `firstintent/a2a-bridge` on GitHub.
  - Access to the `production` GitHub Actions environment on
    that repo.
  - An npm account with publish rights on
    `@firstintent/a2a-bridge` and a current `NPM_TOKEN` set as
    a repo secret.
  - An Anthropic account for the `/plugin` marketplace form.
  - Two-factor auth configured on npm (we use `--otp`).
- `dev` is green in CI and has no uncommitted changes locally.

## 1. Bump check

Confirm the three manifests line up at the release version.

```bash
git checkout dev
git pull origin dev
bun scripts/check-plugin-versions.js
```

Expected output: `Plugin manifests are version-aligned at 0.1.0.`

If it fails, fix the drift before continuing — the release
workflow enforces the same check and will abort otherwise. The
three files to keep in sync:

- `package.json` → `"version"`
- `plugins/a2a-bridge/.claude-plugin/plugin.json` → `"version"`
- `.claude-plugin/marketplace.json` → `plugins[name="a2a-bridge"].version`

## 2. CHANGELOG finalization

Flip the `## [0.1.0] — Unreleased` header to a dated release
header.

```bash
# Replace `Unreleased` with today's date (YYYY-MM-DD).
$EDITOR CHANGELOG.md
```

The block content was written during P6.9 — only the header
line and any last-minute bullet additions need attention. Keep
the format `## [0.1.0] — 2026-04-13` (two em-dash-separated
fields).

Commit the change on `dev`:

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): finalize 0.1.0 release date"
git push origin dev
```

## 3. Merge dev → main

Open a PR from `dev` to `main`, wait for CI green on both
matrix legs, then merge (squash or merge commit — project has no
convention, pick one and stay consistent).

```bash
gh pr create --base main --head dev \
  --title "Release 0.1.0" \
  --body "See CHANGELOG.md for the changelog block."
# after CI green + review:
gh pr merge --merge
git checkout main
git pull origin main
```

All subsequent commands run from `main`.

## 4. Tag creation

```bash
git tag -a v0.1.0 -m "a2a-bridge 0.1.0"
git push origin v0.1.0
```

The tag push fires `.github/workflows/release.yml`. Watch the
run:

```bash
gh run watch --exit-status
```

## 5. GitHub Actions release run

The `release.yml` workflow has three jobs:

1. **check (ubuntu-latest, macos-latest)** — mirrors
   `bun run check:ci`. Must pass on both.
2. **draft-release** — `npm pack`s the tarball and attaches it
   to a **draft** GitHub release at
   `https://github.com/firstintent/a2a-bridge/releases`. The
   release title and tag both equal `v0.1.0`.
3. **publish-npm** — waits in `pending` state until a reviewer
   approves the `production` environment in the Actions UI.

Open the draft release. Verify:

- Title is `v0.1.0`.
- Tarball is attached (`firstintent-a2a-bridge-0.1.0.tgz`, ~230
  KB).
- Body text is present (pulled from `release.yml` body:).

Do **not** promote the draft to published yet — npm publish
fires first.

## 6. Manual npm publish

In the **Actions** tab, find the `Release` workflow run, click
the `publish-npm` job, and click **Review deployments →
production → Approve and deploy**.

Within a minute, the job will fail on the `npm publish` step
because npm requires a 2FA one-time password that GitHub
Actions can't supply headless. Confirm the failure — it is
expected — and fall through to the local-machine publish:

```bash
git checkout main
git pull origin main
git describe --exact-match HEAD     # should print v0.1.0
bun install --frozen-lockfile
bun run prepublishOnly               # builds dist/cli.js + plugin bundles
npm publish --access=public --otp=<6-digit code from your authenticator>
```

Verify on the npm registry:

```bash
npm view @firstintent/a2a-bridge@0.1.0 version
# → 0.1.0
npm view @firstintent/a2a-bridge dist-tags
# → latest: 0.1.0
```

> The `release.yml` `publish-npm` job is intentionally kept in
> the workflow so the approval UX works the same way when we
> eventually wire `NPM_TOKEN`-based 2FA (npm automation tokens).
> Until then the `--otp` flow above is the manual step.

## 7. Publish the GitHub release

Back on the draft release page on GitHub:

1. Click **Edit**.
2. Uncheck **Set as a pre-release**, check **Set as the latest
   release**.
3. Click **Publish release**.

This surfaces the release to watchers and finalizes the tarball
download URL.

## 8. Marketplace submission

Follow `release/marketplace/SUBMIT.md` from the repo. The short
version:

1. Verify `claude plugin validate plugins/a2a-bridge` and
   `claude plugin validate .claude-plugin/marketplace.json`
   both exit 0.
2. Confirm the three `docs/screenshots/*.png` files referenced
   in `.claude-plugin/marketplace.json` are committed to `main`.
3. Open <https://claude.ai/settings/plugins/submit> and submit
   `https://github.com/firstintent/a2a-bridge` (the form accepts
   a GitHub URL).
4. Do **not** open a PR against `anthropics/claude-plugins-official`
   — it auto-closes.

Forward the submission-confirmation email to the release
tracker.

## 9. ACP registry PR

Follow `release/acp-registry/README.md`. Summary:

1. Fork <https://github.com/agentclientprotocol/registry>.
2. Copy `release/acp-registry/agent.json` and
   `release/acp-registry/icon.svg` into a new `a2a-bridge/`
   directory at the fork's root.
3. Open a PR against `main`.
4. Expect CI to fail the `--auth-check` step — v0.1 does not
   advertise `authMethods`. Comment on the PR linking the
   roadmap entry for post-v0.1 ACP auth and either hold the PR
   or ask the registry maintainers for a waiver. See
   `release/acp-registry/README.md` for the full caveat.

## 10. Post-release smoke test

Verify the published tarball works end-to-end on a clean
machine (or at least a clean directory):

```bash
TMP=$(mktemp -d)
cd "$TMP"
npm init -y >/dev/null
npm install @firstintent/a2a-bridge@0.1.0
./node_modules/.bin/a2a-bridge --version
# → a2a-bridge v0.1.0
./node_modules/.bin/a2a-bridge init --print
# → writes to ~/.a2a-bridge/config.json + prints Gemini/OpenClaw/Zed snippets
./node_modules/.bin/a2a-bridge doctor
# → all required checks pass
```

If any step fails, the release is effectively broken. Fix
immediately:

- Typo in a client snippet or README → ship a `0.1.1` patch
  release via the same flow.
- Missing file in the tarball → check `package.json`'s `files`
  array, publish `0.1.1`.
- Runtime error → revert the tag if possible
  (`npm unpublish @firstintent/a2a-bridge@0.1.0` within 72h of
  the publish) and ship a corrected release.

## 11. Announcement

(Optional but recommended.)

- Post the CHANGELOG URL plus a one-paragraph summary in the
  relevant Anthropic Discord channel.
- Toot/tweet the release link.
- Update the internal release tracker (if any) with the outcome.

## Rollback

If a defect surfaces after publish:

1. **Patch if possible.** Ship a `0.1.1` via the full flow; it
   supersedes `0.1.0` as `latest` on npm.
2. **Deprecate if not.** `npm deprecate @firstintent/a2a-bridge@0.1.0
   "install 0.1.1 instead — [reason]"`. The package stays
   downloadable (existing installs don't break) but npm warns
   on `npm install`.
3. **Unpublish only within 72h.** `npm unpublish
   @firstintent/a2a-bridge@0.1.0 --force` is destructive and
   irreversible after the 72-hour window. Avoid unless the
   release leaks secrets or has legal issues.

## Reference

- Release workflow: `.github/workflows/release.yml`
- Marketplace submission package: `release/marketplace/`
- ACP registry submission package: `release/acp-registry/`
- Version-alignment check: `scripts/check-plugin-versions.js`
- Pre-release verifier: `scripts/check-release-ready.sh`
  (added in P7.6)
