import type {
  EnvironmentId,
  ProviderExtensionOverrideState,
  ProviderMcpServer,
  ProviderSkill,
  ThreadExtensionsRefreshDomain,
  ThreadExtensionsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AlertTriangle,
  Blocks,
  KeyRound,
  Link2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import {
  extensionPending,
  extensionRetryTarget,
  filterExtensionMcpServers,
  filterExtensionSkills,
  SKILL_GROUPS,
} from "~/extensionsPanelLogic";
import { readLocalApi } from "~/localApi";
import { extensionsEnvironment } from "~/state/extensions";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Switch } from "~/components/ui/switch";

interface ExtensionsPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshot: ThreadExtensionsSnapshot | null;
  loadError: string | null;
  isLoading: boolean;
  durable: boolean;
  activeTurn: boolean;
}

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message.trim() ? value.message : fallback;
}

function formatRefreshTime(value: string | null): string {
  if (!value) return "Not refreshed yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function overrideBadge(state: ProviderExtensionOverrideState) {
  return state === "inherit" ? "Inherit" : state === "enabled" ? "Enabled here" : "Disabled here";
}

function provenanceLabel(skill: ProviderSkill): string {
  return skill.origin?.label ?? skill.origin?.path ?? skill.path ?? skill.scope;
}

const SkillRow = memo(function SkillRow(props: {
  skill: ProviderSkill;
  disabled: boolean;
  pending: boolean;
  onSet: (skill: ProviderSkill, state: ProviderExtensionOverrideState) => void;
}) {
  const collision = props.skill.shadowedBy
    ? `Shadowed by ${props.skill.shadowedBy}`
    : props.skill.precedence !== undefined
      ? `Precedence ${props.skill.precedence}`
      : null;
  return (
    <div
      className="rounded-lg border border-border/65 bg-card/45 px-3 py-2.5"
      data-extension-skill-id={props.skill.id}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {props.skill.displayName ?? props.skill.name}
            </span>
            <Badge size="sm" variant={props.skill.effectiveEnabled ? "success" : "secondary"}>
              {props.skill.effectiveEnabled ? "Available" : "Unavailable"}
            </Badge>
            {collision ? (
              <Badge size="sm" variant="warning">
                {collision}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 font-mono text-[.65rem] text-muted-foreground wrap-anywhere">
            ${props.skill.name}
          </p>
          {props.skill.description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {props.skill.description}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[.68rem] text-muted-foreground">
            <span>Source: {provenanceLabel(props.skill)}</span>
            <span>Provider default: {props.skill.providerEnabled ? "on" : "off"}</span>
            <span>Thread: {overrideBadge(props.skill.threadOverride)}</span>
          </div>
          {props.pending ? (
            <p className="mt-1 text-[.68rem] text-warning-foreground">
              Pending until the current turn completes.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.skill.threadOverride !== "inherit" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Restore provider default for ${props.skill.name}`}
              disabled={props.disabled}
              onClick={() => props.onSet(props.skill, "inherit")}
            >
              <RotateCcw />
            </Button>
          ) : null}
          <Switch
            checked={props.skill.effectiveEnabled}
            disabled={props.disabled}
            aria-label={`${props.skill.effectiveEnabled ? "Disable" : "Enable"} ${props.skill.name} for this thread`}
            onCheckedChange={(checked) =>
              props.onSet(props.skill, checked ? "enabled" : "disabled")
            }
          />
        </div>
      </div>
    </div>
  );
});

function originLabel(origin: ProviderMcpServer["origins"][number]): string {
  return origin.label ?? origin.path ?? origin.scope;
}

const McpRow = memo(function McpRow(props: {
  server: ProviderMcpServer;
  disabled: boolean;
  pending: boolean;
  capabilities: ThreadExtensionsSnapshot["capabilities"]["mcp"];
  onSet: (server: ProviderMcpServer, state: ProviderExtensionOverrideState) => void;
  onReconnect: (server: ProviderMcpServer) => void;
  onAuthenticate: (server: ProviderMcpServer) => void;
}) {
  const effectiveOrigin = props.server.origins.find((origin) => origin.effective);
  const detailsId = `mcp-details-${encodeURIComponent(props.server.id)}`;
  return (
    <div
      className="rounded-lg border border-border/65 bg-card/45 px-3 py-2.5"
      data-extension-mcp-id={props.server.id}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{props.server.name}</span>
            <Badge size="sm" variant={props.server.effectiveEnabled ? "success" : "secondary"}>
              {props.server.effectiveEnabled ? "Available" : "Unavailable"}
            </Badge>
            <Badge
              size="sm"
              variant={props.server.startupStatus === "failed" ? "error" : "outline"}
            >
              {props.server.startupStatus}
            </Badge>
            <Badge
              size="sm"
              variant={props.server.authStatus === "needs-auth" ? "warning" : "outline"}
            >
              {props.server.authStatus}
            </Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[.68rem] text-muted-foreground">
            <span>Origin: {effectiveOrigin ? originLabel(effectiveOrigin) : "provider"}</span>
            <span>Provider default: {props.server.providerEnabled ? "on" : "off"}</span>
            <span>Thread: {overrideBadge(props.server.threadOverride)}</span>
            <span>
              {props.server.toolCount} tools · {props.server.resourceCount} resources ·{" "}
              {props.server.resourceTemplateCount} templates
            </span>
          </div>
          {props.server.managed ? (
            <p className="mt-1.5 flex items-center gap-1 text-[.68rem] text-muted-foreground">
              <Lock className="size-3" />
              Managed by T3 Code and required for runtime coordination.
            </p>
          ) : null}
          {props.server.error ? (
            <p className="mt-1.5 text-xs text-destructive-foreground">{props.server.error}</p>
          ) : null}
          {props.pending ? (
            <p className="mt-1 text-[.68rem] text-warning-foreground">
              Pending until the current turn completes.
            </p>
          ) : null}
          <details id={detailsId} className="mt-1.5 text-[.68rem] text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
            <div className="mt-1.5 space-y-1 border-l border-border pl-2">
              {props.server.origins.length > 0 ? (
                props.server.origins.map((origin, index) => (
                  <p
                    key={`${origin.scope}:${origin.path ?? origin.label ?? index}`}
                    className="wrap-anywhere"
                  >
                    {origin.effective ? "Effective · " : ""}
                    {originLabel(origin)}
                  </p>
                ))
              ) : (
                <p>No provider origin metadata.</p>
              )}
              <p>
                Startup: {props.server.startupStatus} · Auth: {props.server.authStatus}
              </p>
            </div>
          </details>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {props.capabilities.reconnect && props.server.effectiveEnabled ? (
              <Button
                size="xs"
                variant="outline"
                disabled={props.disabled}
                onClick={() => props.onReconnect(props.server)}
              >
                <Link2 />
                Reconnect
              </Button>
            ) : null}
            {props.capabilities.authenticate && props.server.authStatus === "needs-auth" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={props.disabled}
                onClick={() => props.onAuthenticate(props.server)}
              >
                <KeyRound />
                Authenticate
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.server.threadOverride !== "inherit" && props.server.toggleable ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Restore provider default for ${props.server.name}`}
              disabled={props.disabled}
              onClick={() => props.onSet(props.server, "inherit")}
            >
              <RotateCcw />
            </Button>
          ) : null}
          <Switch
            checked={props.server.effectiveEnabled}
            disabled={props.disabled || !props.server.toggleable}
            aria-label={
              props.server.toggleable
                ? `${props.server.effectiveEnabled ? "Disable" : "Enable"} ${props.server.name} for this thread`
                : `${props.server.name} is managed by T3 Code`
            }
            onCheckedChange={(checked) =>
              props.onSet(props.server, checked ? "enabled" : "disabled")
            }
          />
        </div>
      </div>
    </div>
  );
});

export function ExtensionsPanel(props: ExtensionsPanelProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [refreshing, setRefreshing] = useState<ReadonlySet<ThreadExtensionsRefreshDomain>>(
    new Set(),
  );
  const [mutationRevision, setMutationRevision] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const setSkillOverride = useAtomCommand(threadEnvironment.setSkillOverride, {
    reportFailure: false,
  });
  const setMcpOverride = useAtomCommand(threadEnvironment.setMcpOverride, { reportFailure: false });
  const refresh = useAtomCommand(extensionsEnvironment.refresh, { reportFailure: false });
  const reconnectMcp = useAtomCommand(extensionsEnvironment.reconnectMcp, { reportFailure: false });
  const beginMcpAuth = useAtomCommand(extensionsEnvironment.beginMcpAuth, { reportFailure: false });

  useEffect(() => {
    if (mutationRevision !== null && (props.snapshot?.overrideRevision ?? 0) >= mutationRevision) {
      setMutationRevision(null);
    }
  }, [mutationRevision, props.snapshot?.overrideRevision]);

  const mutationDisabled = !props.durable || mutationRevision !== null;
  const pending = props.snapshot ? extensionPending(props.snapshot) : false;
  const filteredSkills = useMemo(
    () => filterExtensionSkills(props.snapshot?.skills ?? [], deferredQuery),
    [deferredQuery, props.snapshot?.skills],
  );
  const filteredMcp = useMemo(
    () => filterExtensionMcpServers(props.snapshot?.mcpServers ?? [], deferredQuery),
    [deferredQuery, props.snapshot?.mcpServers],
  );

  const runMutation = useCallback(
    async (target: {
      kind: "skill" | "mcp";
      id: string;
      state: ProviderExtensionOverrideState;
    }) => {
      const snapshot = props.snapshot;
      if (!snapshot || !props.durable || mutationRevision !== null) return;
      setActionError(null);
      const expectedNextRevision = snapshot.overrideRevision + 1;
      setMutationRevision(expectedNextRevision);
      const result =
        target.kind === "skill"
          ? await setSkillOverride({
              environmentId: props.environmentId,
              input: {
                threadId: props.threadId,
                skillId: target.id as ProviderSkill["id"],
                state: target.state,
                expectedRevision: snapshot.overrideRevision,
              },
            })
          : await setMcpOverride({
              environmentId: props.environmentId,
              input: {
                threadId: props.threadId,
                mcpServerId: target.id as ProviderMcpServer["id"],
                state: target.state,
                expectedRevision: snapshot.overrideRevision,
              },
            });
      if (result._tag === "Failure") {
        setMutationRevision(null);
        if (!isAtomCommandInterrupted(result))
          setActionError(
            errorMessage(
              squashAtomCommandFailure(result),
              "Could not update this thread override.",
            ),
          );
      }
    },
    [
      mutationRevision,
      props.durable,
      props.environmentId,
      props.snapshot,
      props.threadId,
      setMcpOverride,
      setSkillOverride,
    ],
  );
  const setSkill = useCallback(
    (skill: ProviderSkill, state: ProviderExtensionOverrideState) => {
      void runMutation({ kind: "skill", id: skill.id, state });
    },
    [runMutation],
  );
  const setMcp = useCallback(
    (server: ProviderMcpServer, state: ProviderExtensionOverrideState) => {
      void runMutation({ kind: "mcp", id: server.id, state });
    },
    [runMutation],
  );

  const runRefresh = useCallback(
    async (domain: ThreadExtensionsRefreshDomain) => {
      if (!props.durable || refreshing.has(domain)) return;
      setRefreshing((current) => new Set(current).add(domain));
      setActionError(null);
      const result = await refresh({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, domain },
      });
      setRefreshing((current) => {
        const next = new Set(current);
        next.delete(domain);
        return next;
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        setActionError(
          errorMessage(squashAtomCommandFailure(result), `Could not refresh ${domain}.`),
        );
    },
    [props.durable, props.environmentId, props.threadId, refresh, refreshing],
  );

  const runMcpAction = useCallback(
    async (kind: "reconnect" | "auth", server: ProviderMcpServer) => {
      setActionError(null);
      const input = {
        environmentId: props.environmentId,
        input: { threadId: props.threadId, mcpServerId: server.id },
      };
      const result = kind === "reconnect" ? await reconnectMcp(input) : await beginMcpAuth(input);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          setActionError(
            errorMessage(
              squashAtomCommandFailure(result),
              `Could not ${kind === "auth" ? "authenticate" : "reconnect"} ${server.name}.`,
            ),
          );
        return;
      }
      if (kind === "auth" && "authorizationUrl" in result.value && result.value.authorizationUrl) {
        try {
          await readLocalApi()?.shell.openExternal(result.value.authorizationUrl);
        } catch (error) {
          setActionError(errorMessage(error, `Could not open authentication for ${server.name}.`));
        }
      }
    },
    [beginMcpAuth, props.environmentId, props.threadId, reconnectMcp],
  );
  const reconnect = useCallback(
    (server: ProviderMcpServer) => {
      void runMcpAction("reconnect", server);
    },
    [runMcpAction],
  );
  const authenticate = useCallback(
    (server: ProviderMcpServer) => {
      void runMcpAction("auth", server);
    },
    [runMcpAction],
  );

  const retry = useCallback(() => {
    if (!props.snapshot) return;
    const target = extensionRetryTarget(props.snapshot);
    if (target) void runMutation(target);
  }, [props.snapshot, runMutation]);

  const errors = [
    ...new Map(
      (props.snapshot?.errors ?? []).map((error) => [
        `${error.domain}:${error.retryable}:${error.message}`,
        error,
      ]),
    ).values(),
  ];
  const retryable = errors.some((error) => error.retryable);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="flex items-start gap-2">
          <Blocks className="mt-0.5 size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">Skills &amp; MCP</h2>
            <p className="mt-0.5 truncate font-mono text-[.68rem] text-muted-foreground">
              {props.snapshot
                ? `${props.snapshot.provider} (${props.snapshot.providerInstanceId}) · ${props.snapshot.cwd}`
                : "Resolving provider and workspace…"}
            </p>
            <p className="mt-1 text-[.68rem] text-muted-foreground">
              Last refresh: {formatRefreshTime(props.snapshot?.refreshedAt ?? null)}
            </p>
          </div>
        </div>
        <label className="relative mt-3 block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            nativeInput
            size="sm"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search skills and MCP servers"
            className="pl-6"
          />
        </label>
        <p className="mt-2 text-[.68rem] leading-relaxed text-muted-foreground">
          Disabling controls future availability for this thread. It does not erase skill
          instructions or MCP history already in the conversation.
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          {!props.durable ? (
            <div className="rounded-lg border border-info/25 bg-info/5 p-3 text-xs text-info-foreground">
              Send the first message to create this thread before changing overrides. The contextual
              inventory below is read-only.
            </div>
          ) : null}
          {pending ? (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning-foreground">
              Revision {props.snapshot?.overrideRevision} is saved and pending
              {props.activeTurn ? " until the current turn completes" : " provider reconciliation"}.
            </div>
          ) : null}
          {props.loadError || actionError || errors.length > 0 ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive-foreground">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  {props.loadError ? <p>{props.loadError}</p> : null}
                  {actionError ? <p>{actionError}</p> : null}
                  {errors.map((error) => (
                    <p key={`${error.domain}:${error.retryable}:${error.message}`}>
                      {error.domain}: {error.message}
                    </p>
                  ))}
                </div>
                {retryable && props.durable ? (
                  <Button size="xs" variant="outline" disabled={mutationDisabled} onClick={retry}>
                    Retry
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {props.isLoading && !props.snapshot ? (
            <p className="text-xs text-muted-foreground">Loading contextual extensions…</p>
          ) : null}

          <section aria-labelledby="extensions-skills-heading">
            <div className="mb-2 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <h3
                  id="extensions-skills-heading"
                  className="text-xs font-semibold uppercase tracking-wider"
                >
                  Skills
                </h3>
                <p className="text-[.68rem] text-muted-foreground">
                  {props.snapshot?.skills.length ?? 0} discovered
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={
                  !props.durable ||
                  !props.snapshot?.capabilities.skills.refresh ||
                  refreshing.has("skills") ||
                  props.snapshot?.loading.skills
                }
                onClick={() => void runRefresh("skills")}
              >
                <RefreshCw />
                {refreshing.has("skills") || props.snapshot?.loading.skills
                  ? "Refreshing"
                  : "Refresh"}
              </Button>
            </div>
            {props.snapshot && !props.snapshot.capabilities.skills.inventory ? (
              <div className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                {props.snapshot.provider} does not expose contextual skill inventory yet.
              </div>
            ) : (
              <div className="space-y-4">
                {props.snapshot && !props.snapshot.capabilities.skills.threadOverride ? (
                  <p className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                    {props.snapshot.provider} exposes these skills but does not support per-thread
                    skill controls.
                  </p>
                ) : null}
                {SKILL_GROUPS.map((group) => {
                  const groupSkills = filteredSkills.filter((skill) =>
                    (group.scopes as readonly string[]).includes(skill.scope),
                  );
                  if (groupSkills.length === 0) return null;
                  return (
                    <div key={group.id}>
                      <h4 className="mb-1.5 text-[.68rem] font-medium text-muted-foreground">
                        {group.label} · {groupSkills.length}
                      </h4>
                      <div className="space-y-1.5">
                        {groupSkills.map((skill) => (
                          <SkillRow
                            key={skill.id}
                            skill={skill}
                            disabled={
                              mutationDisabled ||
                              !props.snapshot?.capabilities.skills.threadOverride
                            }
                            pending={pending && skill.threadOverride !== "inherit"}
                            onSet={setSkill}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {filteredSkills.length === 0 ? (
                  <p className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                    No matching skills. Disabled skills remain searchable here.
                  </p>
                ) : null}
              </div>
            )}
          </section>

          <section aria-labelledby="extensions-mcp-heading">
            <div className="mb-2 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <h3
                  id="extensions-mcp-heading"
                  className="text-xs font-semibold uppercase tracking-wider"
                >
                  MCP servers
                </h3>
                <p className="text-[.68rem] text-muted-foreground">
                  {props.snapshot?.mcpServers.length ?? 0} configured
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={
                  !props.durable ||
                  !props.snapshot?.capabilities.mcp.inventory ||
                  refreshing.has("mcp") ||
                  props.snapshot?.loading.mcp
                }
                onClick={() => void runRefresh("mcp")}
              >
                <RefreshCw />
                {refreshing.has("mcp") || props.snapshot?.loading.mcp ? "Refreshing" : "Refresh"}
              </Button>
            </div>
            {props.snapshot && !props.snapshot.capabilities.mcp.inventory ? (
              <div className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                {props.snapshot.provider} does not expose MCP inventory or thread-local enablement
                yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {props.snapshot && !props.snapshot.capabilities.mcp.threadOverride ? (
                  <p className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                    {props.snapshot.provider} exposes MCP inventory but does not support per-thread
                    MCP controls.
                  </p>
                ) : null}
                {props.snapshot && !props.snapshot.capabilities.mcp.liveStatus ? (
                  <p className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                    Live MCP startup and authentication status is unavailable from this provider.
                  </p>
                ) : null}
                {filteredMcp.map((server) => (
                  <McpRow
                    key={server.id}
                    server={server}
                    disabled={mutationDisabled || !props.snapshot?.capabilities.mcp.threadOverride}
                    pending={pending && server.threadOverride !== "inherit"}
                    capabilities={props.snapshot!.capabilities.mcp}
                    onSet={setMcp}
                    onReconnect={reconnect}
                    onAuthenticate={authenticate}
                  />
                ))}
                {filteredMcp.length === 0 ? (
                  <p className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                    No matching MCP servers.
                  </p>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
