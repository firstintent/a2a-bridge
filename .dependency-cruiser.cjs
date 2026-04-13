/**
 * dependency-cruiser rules for a2a-bridge.
 *
 * These rules enforce the directory-based architecture documented in
 * docs/design/architecture.md. Violations fail CI via `bun run lint:deps`.
 *
 * Layer map:
 *   src/shared/          zero-dep utilities
 *   src/messages/        shared value objects (BridgeMessage, ...)
 *   src/transport/       plugin<->daemon control plane
 *   src/runtime-plugin/  code running inside the Claude Code MCP plugin
 *   src/runtime-daemon/  code running inside the persistent daemon
 *   src/cli/             user-facing CLI composition root
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are a code smell and a pain to test.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-is-pure',
      severity: 'error',
      comment:
        'src/shared/ must stay self-contained: no inbound dependency on any other layer.',
      from: { path: '^src/shared/' },
      to: {
        path: '^src/(messages|transport|runtime-plugin|runtime-daemon|cli)/',
      },
    },
    {
      name: 'messages-leaf',
      severity: 'error',
      comment:
        'src/messages/ holds shared value objects only; may depend on src/shared but nothing else.',
      from: { path: '^src/messages/' },
      to: {
        path: '^src/(transport|runtime-plugin|runtime-daemon|cli)/',
      },
    },
    {
      name: 'transport-below-business',
      severity: 'error',
      comment:
        'src/transport/ sits below business layers; may depend on src/shared and src/messages only.',
      from: { path: '^src/transport/' },
      to: {
        path: '^src/(runtime-plugin|runtime-daemon|cli)/',
      },
    },
    {
      name: 'plugin-not-daemon',
      severity: 'error',
      comment:
        'Plugin runtime must not import daemon-runtime internals. Go through transport + messages instead.',
      from: { path: '^src/runtime-plugin/' },
      to: { path: '^src/runtime-daemon/' },
    },
    {
      name: 'daemon-not-plugin',
      severity: 'error',
      comment:
        'Daemon runtime must not import plugin-runtime internals. Communicate over transport only.',
      from: { path: '^src/runtime-daemon/' },
      to: { path: '^src/runtime-plugin/' },
    },
    {
      name: 'no-cross-peer',
      severity: 'error',
      comment:
        'Peer adapters must not import each other. Share state through src/runtime-daemon/rooms or interfaces.',
      from: { path: '^src/runtime-daemon/peers/([^/]+)/' },
      to: {
        path: '^src/runtime-daemon/peers/([^/]+)/',
        pathNot: '^src/runtime-daemon/peers/$1/',
      },
    },
    {
      name: 'inbound-does-not-reach-into-peers',
      severity: 'error',
      comment:
        'Inbound service does not touch peer adapter internals; route through rooms.',
      from: { path: '^src/runtime-daemon/inbound/' },
      to: { path: '^src/runtime-daemon/peers/(codex|openclaw|hermes)/' },
    },
    {
      name: 'peers-do-not-reach-into-inbound',
      severity: 'error',
      comment:
        'Peer adapters must not depend on inbound service concrete code.',
      from: { path: '^src/runtime-daemon/peers/' },
      to: { path: '^src/runtime-daemon/inbound/' },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      comment: 'Non-test sources must not import test files.',
      from: { pathNot: '\\.test\\.ts$' },
      to: { path: '\\.test\\.ts$' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreferenced modules probably want deleting.',
      from: { orphan: true, pathNot: '(^src/cli/cli\\.ts$|\\.d\\.ts$|\\.test\\.ts$|tsconfig\\.json$|\\.dependency-cruiser\\.cjs$|scripts/)' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: './tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/[^/]+' },
      text: { highlightFocused: true },
    },
  },
};
