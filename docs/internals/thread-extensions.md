# Thread extensions

> For maintainers. Using T3 Code? See [Skills and MCP](../user/skills-and-mcp.md).

Thread extensions are the capability-gated management surface for provider skills and MCP servers.
The design separates provider-owned inventory, event-sourced desired state, and runtime-applied
state so the server never rewrites provider configuration.

## Lifecycle

1. The server resolves the thread, project, provider instance, and canonical workspace path. RPC
   callers provide identities, never a filesystem path.
2. The provider management facet reads raw skill and MCP inventory for that workspace. Inventory is
   contextual and stays out of the server bootstrap and welcome payloads.
3. The thread extensions service overlays the thread's desired overrides and returns a revisioned
   snapshot. WebSocket subscribers receive the same snapshot shape.
4. Draft MCP intents travel on thread bootstrap. The decider emits the standard MCP override events
   immediately after thread creation and before the first turn command, so projection and replay use
   the same event shape as later changes.
5. Override commands append thread events. The projector reconstructs the sparse skill and MCP maps
   and their monotonic desired revision from the event log.
6. The provider reactor reconciles the desired revision at a safe runtime boundary and exposes its
   applied revision, pending revision, and retryable error. A failed provider process does not make
   pending desired state look applied.

This gives the clients three distinct signals: inventory revision, desired override revision, and
applied override revision. Client state rejects stale snapshots and optimistic writes include the
expected desired revision, so multiple clients converge through the normal command/event stream.

## Provider management facet

The optional provider extensions facet declares separate capabilities for skill inventory, MCP
inventory and status, refresh, thread overrides, reconnect, and authentication. Unsupported facets
are represented by capabilities rather than provider-name checks. Providers without the facet keep
their existing chat behavior.

Raw inventory is cached at the provider boundary by canonical workspace and domain. Explicit
refresh bypasses that cache. Provider notifications invalidate it and wake subscribers; there is no
polling loop and no second long-lived management process alongside an active session.

Draft snapshots use a prepared provider runtime and issue one global MCP status request without a
provider thread ID. The result is cached until explicit refresh. A global null result means the
server has not started (or is unavailable); it is not promoted to a failure because pre-thread
discovery cannot distinguish those cases. After thread creation, only thread-scoped status is
authoritative.

## Codex

Codex app-server supplies workspace-aware skill inventory, configuration-derived MCP provenance,
and MCP startup and OAuth notifications. Skill IDs are canonical `SKILL.md` paths, which preserves
identity when duplicate names exist. Thread overrides compile into in-memory Codex start/resume
configuration; T3 Code never calls Codex configuration-write methods.

Codex applies changed skill and MCP configuration at a restart-and-resume boundary. During an active
turn the reactor coalesces revisions and waits for the safe boundary. A management runtime prepared
before the first turn is reused only when its workspace and managed MCP credential identity still
match; otherwise it is closed before the correctly configured session runtime starts. Prepared
runtimes used only for management are not visible to the durable thread-session reaper, so the Codex
adapter closes them after the same 30-minute idle window. A management lease cancels and rearms that
timer; starting the first turn cancels it permanently for the now-durable session.

The composer sends selected skills as structured Codex input. The server validates the selected ID,
name, path, and effective enabled state against current inventory immediately before the turn.

## Persistence and scope

Overrides belong to a thread, not a project, provider installation, or skill file. Restart recovery
replays the event log into desired state and reconciliation reapplies it when the provider session
starts. Disabling an extension changes future runtime availability only; projected conversation
history is untouched.

MCP reconnect and authentication actions also resolve through server-owned durable or preview
context. OAuth login is given a finite provider timeout. Its callback uses the server machine's
loopback interface, so clients only open the URL automatically for a known-local connection; remote,
relay, and tunnel clients surface it for completion on the server host. The managed `t3-code` MCP
entry is visible but never toggleable.

## Follow-up providers

Codex is the first full implementation. Claude support is a planned follow-up on these same
contracts and lifecycle; it is not implemented by this feature. Cursor, Grok, OpenCode, and any
other adapter can opt into individual capabilities without changing orchestration or clients.
