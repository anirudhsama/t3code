# Skills and MCP

The **Skills & MCP** panel shows the extensions available to the current thread. Open it from the
right panel or run **Open Skills & MCP** from the command palette.

## Context follows the thread

T3 Code asks the selected provider for extensions using the thread's workspace, even when the T3
Code server was launched somewhere else. Project skills therefore follow the repository or
worktree attached to the thread. User and system skills remain available alongside them.

The panel groups skills by their source and shows where each skill came from. MCP servers include
their configuration provenance, startup and authentication status, and reported tool and resource
counts when the provider supplies them. Use **Refresh** after adding or removing a skill or changing
provider-owned MCP configuration.

## Thread-scoped controls

Skill and MCP switches apply only to the current thread. They do not edit skill files or the
provider's configuration, and changing one thread does not change another thread.

A disabled skill remains visible in the panel but is removed from the composer's skill picker. A
disabled MCP server is excluded the next time the provider runtime is applied. The managed
`t3-code` MCP connection cannot be disabled from the panel because it carries T3 Code's own runtime
integration.

Changes made during an active turn are saved immediately and applied at the next safe provider
boundary. The panel distinguishes the saved setting from the setting currently applied by the
runtime and reports retryable failures instead of pretending a change succeeded.

These controls affect future availability. Disabling a skill or MCP server does not erase messages,
tool calls, or other history already recorded in the thread.

## Selecting skills in the composer

Type `$` in the composer to select an enabled skill for the next message. Selected skills appear as
chips and are sent as structured provider input. Skills with the same name are disambiguated by
their source and path.

The composer revalidates selections before sending. If a selected skill was disabled, removed, or
replaced after selection, update the selection before sending rather than silently invoking a
different skill.

## Provider availability

The panel follows provider capabilities. Codex supports contextual skill and MCP inventory and
thread overrides. Providers that do not yet expose those capabilities remain usable for chat, but
their unsupported controls are not enabled. Claude support is planned as a follow-up using the same
capability-based contracts.
