# Skills and MCP

The **Skills & MCP** panel shows the extensions available to the current thread. Open it from the
right panel or run **Open Skills & MCP** from the command palette.

## Context follows the thread

T3 Code asks the selected provider for extensions using the thread's workspace, even when the T3
Code server was launched somewhere else. Project skills therefore follow the repository or
worktree attached to the thread. User and system skills remain available alongside them.

The panel groups skills by their source and shows where each skill came from. MCP servers include
their configuration provenance, startup and authentication status, and reported tool and resource
counts after discovery has run. Opening the panel before the first message runs discovery once and
caches the result; use **Refresh** after changing provider-owned MCP configuration.

## Skills

Skills are inventory-only in this panel. Expand the collapsed **Skills** section to inspect each
skill's description, source, and any shadowing or name collision. T3 Code does not change skill
enablement from this panel; the provider's effective inventory determines what appears in the
composer picker.

## MCP controls

MCP switches apply only to the current thread. They do not edit the provider's configuration, and
changing one thread does not change another thread. A disabled MCP server is excluded the next time
the provider runtime is applied. The managed `t3-code` MCP connection cannot be disabled because it
carries T3 Code's own runtime integration.

You can set MCP switches before sending the first message. Draft changes are marked **Will apply
when this thread is created** and are saved with thread creation before the first provider session
starts. This makes the selected MCP set effective for the first turn.

Changes made during an active turn are saved immediately and applied at the next safe provider
boundary. The panel distinguishes the saved setting from the setting currently applied by the
runtime and reports retryable failures instead of pretending a change succeeded.

These controls affect future availability. Disabling an MCP server does not erase messages, tool
calls, or other history already recorded in the thread.

## MCP authentication

When discovery reports **Login required**, select **Authenticate**. T3 Code starts the provider's
login flow in your browser and shows **Waiting for login** until the provider reports completion. A
failed or timed-out login remains retryable from the same row.

When you connect remotely, the provider may finish on a `127.0.0.1` page that your browser cannot
reach. Copy that page's full URL from the browser address bar, including its query string, paste it
into **Paste the redirect URL** in the MCP row, and select **Submit redirect**. T3 Code securely
delivers that callback to the server machine. Local clients reveal the same paste-back control after
a few seconds if the automatic callback does not finish. The row also offers **Copy login URL** if
you need to reopen the provider's authorization page.

## Selecting skills in the composer

Type `$` in the composer to select an available skill for the next message. Selected skills appear as
chips and are sent as structured provider input. Skills with the same name are disambiguated by
their source and path.

The composer revalidates selections before sending. If a selected skill was removed or replaced
after selection, update the selection before sending rather than silently invoking a different
skill.

## Provider availability

The panel follows provider capabilities. Codex supports contextual skill and MCP inventory and
thread overrides. Providers that do not yet expose those capabilities remain usable for chat, but
their unsupported controls are not enabled. Claude support is planned as a follow-up using the same
capability-based contracts.
