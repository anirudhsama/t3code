import type {
  EnvironmentId,
  ProjectId,
  ProviderExtensionOverrideState,
  ProviderInstanceId,
  ProviderMcpOverrides,
  ProviderMcpServer,
  ProviderSkill,
  ThreadExtensionsRefreshDomain,
  ThreadExtensionsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AlertTriangle,
  Blocks,
  ChevronDown,
  ChevronRight,
  Clipboard,
  KeyRound,
  Link2,
  Lock,
  RefreshCw,
  Search,
} from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import {
  advanceMcpAuthState,
  applyDraftMcpOverrides,
  createMcpAuthWaitingState,
  effectiveMcpOriginLabel,
  extensionPending,
  extensionRetryTarget,
  filterExtensionMcpServers,
  filterExtensionSkills,
  mcpStatusLabel,
  type McpAuthUiState,
  SKILL_GROUPS,
} from "~/extensionsPanelLogic";
import { readLocalApi } from "~/localApi";
import { extensionsEnvironment } from "~/state/extensions";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";

interface ExtensionsPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId | null;
  providerInstanceId: ProviderInstanceId | null;
  snapshot: ThreadExtensionsSnapshot | null;
  loadError: string | null;
  isLoading: boolean;
  durable: boolean;
  activeTurn: boolean;
  draftMcpOverrides: ProviderMcpOverrides;
  isAuthClientLocal: boolean;
  skillsCollapsed?: boolean;
  onSetDraftMcpOverride: (
    mcpServerId: ProviderMcpServer["id"],
    state: ProviderExtensionOverrideState,
  ) => void;
}

function claudeMcpLoginCommand(serverName: string): string {
  const argument = /^[A-Za-z0-9._-]+$/.test(serverName)
    ? serverName
    : `'${serverName.replaceAll("'", `'\\''`)}'`;
  return `claude mcp login ${argument}`;
}

function inventoryCount(value: number | undefined, singular: string): string | undefined {
  return value === undefined ? undefined : `${value} ${value === 1 ? singular : `${singular}s`}`;
}

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message.trim() ? value.message : fallback;
}

function formatRefreshTime(value: string | null): string {
  if (!value) return "Not refreshed yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function provenanceLabel(skill: ProviderSkill): string {
  return skill.origin?.label ?? skill.origin?.path ?? skill.path ?? skill.scope;
}

function originLabel(origin: ProviderMcpServer["origins"][number]): string {
  return origin.label ?? origin.path ?? origin.scope;
}

function serverInfoLabel(serverInfo: unknown): string | null {
  if (!serverInfo || typeof serverInfo !== "object") return null;
  const info = serverInfo as { name?: unknown; title?: unknown; version?: unknown };
  const name =
    typeof info.title === "string" ? info.title : typeof info.name === "string" ? info.name : null;
  const version = typeof info.version === "string" ? info.version : null;
  return [name, version].filter(Boolean).join(" · ") || null;
}

function ExtensionRowsSkeleton({ label }: { label: string }) {
  return (
    <div
      className="space-y-2 rounded-lg border border-border/65 bg-card/25 p-3"
      role="status"
      aria-label={label}
    >
      <p className="text-xs font-medium text-foreground/80">{label}</p>
      {["w-2/3", "w-1/2", "w-3/5"].map((width) => (
        <div key={width} className="space-y-2 rounded-md border border-border/50 p-2.5">
          <Skeleton className={`h-3 ${width} rounded-full`} />
          <Skeleton className="h-2.5 w-1/3 rounded-full" />
        </div>
      ))}
    </div>
  );
}

const SkillRow = memo(function SkillRow({ skill }: { skill: ProviderSkill }) {
  const collision = skill.shadowedBy
    ? `Shadowed by ${skill.shadowedBy}`
    : skill.precedence !== undefined
      ? `Precedence ${skill.precedence}`
      : null;
  return (
    <div
      className="rounded-lg border border-border/65 bg-card/45 px-3 py-2.5"
      data-extension-skill-id={skill.id}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate text-sm font-medium">{skill.displayName ?? skill.name}</span>
        {collision ? (
          <Badge size="sm" variant="warning">
            {collision}
          </Badge>
        ) : null}
      </div>
      {skill.description ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
      ) : null}
      <p className="mt-1.5 text-[.68rem] text-muted-foreground wrap-anywhere">
        {provenanceLabel(skill)}
      </p>
    </div>
  );
});

export const McpRow = memo(function McpRow(props: {
  server: ProviderMcpServer;
  durable: boolean;
  disabled: boolean;
  pending: boolean;
  authState: McpAuthUiState | null;
  callbackUrl: string;
  capabilities: ThreadExtensionsSnapshot["capabilities"]["mcp"];
  onSet: (server: ProviderMcpServer, state: ProviderExtensionOverrideState) => void;
  onReconnect: (server: ProviderMcpServer) => void;
  onAuthenticate: (server: ProviderMcpServer) => void;
  onCopyAuthUrl: (url: string) => void;
  onCallbackUrlChange: (value: string) => void;
  onRelayCallback: (server: ProviderMcpServer) => void;
}) {
  const status = mcpStatusLabel(props.server, props.durable);
  const info = serverInfoLabel(props.server.serverInfo);
  const authPending =
    props.authState?.phase === "beginning" || props.authState?.phase === "waiting";
  const authUrl =
    props.authState?.phase === "waiting" ? props.authState.authorizationUrl : undefined;
  return (
    <div
      className="rounded-lg border border-border/65 bg-card/45 px-3 py-2.5"
      data-extension-mcp-id={props.server.id}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{props.server.name}</span>
            <Badge size="sm" variant="secondary">
              {effectiveMcpOriginLabel(props.server)}
            </Badge>
            {status ? (
              <Badge
                size="sm"
                variant={
                  status === "Failed"
                    ? "error"
                    : status === "Login required"
                      ? "warning"
                      : status === "Ready"
                        ? "success"
                        : "outline"
                }
              >
                {status}
              </Badge>
            ) : null}
          </div>
          {props.pending ? (
            <p className="mt-1 text-[.68rem] text-warning-foreground">
              {props.durable
                ? "Pending provider reconciliation."
                : "Will apply when this thread is created."}
            </p>
          ) : null}
          {props.capabilities.authenticate && props.server.authStatus === "needs-auth" ? (
            <div className="mt-2 space-y-1.5">
              <Button
                size="sm"
                variant="default"
                disabled={authPending}
                onClick={() => props.onAuthenticate(props.server)}
              >
                <KeyRound />
                {props.authState?.phase === "beginning"
                  ? "Starting login…"
                  : props.authState?.phase === "waiting"
                    ? "Waiting for login…"
                    : "Authenticate"}
              </Button>
              {authUrl ? (
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 flex-1 text-[.68rem] leading-relaxed text-muted-foreground">
                    Complete authentication in the browser that opened.
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`Copy authentication URL for ${props.server.name}`}
                    onClick={() => props.onCopyAuthUrl(authUrl)}
                  >
                    <Clipboard />
                    Copy login URL
                  </Button>
                </div>
              ) : null}
              {props.authState?.phase === "waiting" && props.authState.pasteVisible ? (
                <div className="space-y-1.5 rounded-md border border-border/65 bg-muted/30 p-2">
                  <p className="text-[.68rem] font-medium text-foreground/80">
                    Paste the redirect URL
                  </p>
                  <p className="text-[.68rem] leading-relaxed text-muted-foreground">
                    After authorizing, copy the full 127.0.0.1 redirect URL from the browser address
                    bar and paste it here.
                  </p>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Input
                      nativeInput
                      size="sm"
                      type="url"
                      autoComplete="off"
                      spellCheck={false}
                      value={props.callbackUrl}
                      onChange={(event) => props.onCallbackUrlChange(event.currentTarget.value)}
                      placeholder="http://127.0.0.1:…/callback/…?code=…"
                      aria-label={`Redirect URL for ${props.server.name}`}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        props.callbackUrl.trim().length === 0 ||
                        props.authState.relayState === "submitting"
                      }
                      onClick={() => props.onRelayCallback(props.server)}
                    >
                      {props.authState.relayState === "submitting"
                        ? "Sending…"
                        : props.authState.relayState === "submitted"
                          ? "Send again"
                          : "Submit redirect"}
                    </Button>
                  </div>
                  {props.authState.relayState === "submitted" ? (
                    <p className="text-[.68rem] text-muted-foreground">
                      Redirect sent. Waiting for the provider to finish login…
                    </p>
                  ) : null}
                  {props.authState.openError ? (
                    <p className="text-xs text-destructive-foreground">
                      {props.authState.openError}
                    </p>
                  ) : null}
                  {props.authState.relayError ? (
                    <p className="text-xs text-destructive-foreground">
                      {props.authState.relayError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {props.authState?.phase === "error" ? (
                <p className="text-xs text-destructive-foreground">{props.authState.message}</p>
              ) : null}
            </div>
          ) : props.server.authStatus === "needs-auth" ? (
            <div className="mt-2 space-y-1 text-[.68rem] leading-relaxed text-muted-foreground">
              <p>Authenticate with Claude Code on the machine running this T3 Code server.</p>
              <p className="font-mono">{claudeMcpLoginCommand(props.server.name)}</p>
            </div>
          ) : null}
          <details className="mt-2 text-[.68rem] text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
            <div className="mt-1.5 space-y-1 border-l border-border pl-2">
              {props.server.origins.length > 0 ? (
                <>
                  {props.server.origins.length > 1 ? (
                    <p>Defined in: {props.server.origins.map(originLabel).join(", ")}</p>
                  ) : null}
                  <p>
                    Active:{" "}
                    {originLabel(
                      props.server.origins.find((origin) => origin.effective) ??
                        props.server.origins[0]!,
                    )}
                  </p>
                </>
              ) : (
                <p>Definition source not reported by the provider.</p>
              )}
              {props.server.managed ? (
                <p className="flex items-center gap-1">
                  <Lock className="size-3" />
                  Managed by T3 Code and required for runtime coordination.
                </p>
              ) : null}
              {info ? <p>Server: {info}</p> : null}
              {props.server.statusObserved ? (
                <p>
                  {[
                    inventoryCount(props.server.toolCount, "tool"),
                    inventoryCount(props.server.resourceCount, "resource"),
                    inventoryCount(props.server.resourceTemplateCount, "template"),
                  ]
                    .filter((count): count is string => count !== undefined)
                    .join(" · ") || "Inventory counts not reported."}
                </p>
              ) : (
                <p>
                  {props.durable
                    ? "Status appears once discovery runs or the session starts."
                    : "Status appears once discovery runs."}
                </p>
              )}
              {props.durable && props.server.startupStatus === "failed" && props.server.error ? (
                <p className="text-destructive-foreground">{props.server.error}</p>
              ) : null}
              {props.capabilities.reconnect && props.durable && props.server.effectiveEnabled ? (
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
            </div>
          </details>
        </div>
        <Switch
          checked={props.server.effectiveEnabled}
          disabled={props.disabled || !props.server.toggleable}
          aria-label={
            props.server.toggleable
              ? `${props.server.effectiveEnabled ? "Disable" : "Enable"} ${props.server.name} for this thread`
              : `${props.server.name} is managed by T3 Code`
          }
          onCheckedChange={(checked) => props.onSet(props.server, checked ? "enabled" : "disabled")}
        />
      </div>
    </div>
  );
});

export function ExtensionsPanel(props: ExtensionsPanelProps) {
  const panelRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const persistedSkillsCollapsed = useRightPanelStore(
    (state) =>
      selectThreadRightPanelState(state.byThreadKey, panelRef).extensionsSkillsCollapsed ?? true,
  );
  const skillsCollapsed = props.skillsCollapsed ?? persistedSkillsCollapsed;
  const setSkillsCollapsed = useRightPanelStore((state) => state.setExtensionsSkillsCollapsed);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [refreshing, setRefreshing] = useState<ReadonlySet<ThreadExtensionsRefreshDomain>>(
    new Set(),
  );
  const [mutationRevision, setMutationRevision] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [authStates, setAuthStates] = useState<Readonly<Record<string, McpAuthUiState>>>({});
  const [callbackUrls, setCallbackUrls] = useState<Readonly<Record<string, string>>>({});
  const setMcpOverride = useAtomCommand(threadEnvironment.setMcpOverride, { reportFailure: false });
  const refresh = useAtomCommand(extensionsEnvironment.refresh, { reportFailure: false });
  const refreshPreview = useAtomCommand(extensionsEnvironment.refreshPreview, {
    reportFailure: false,
  });
  const reconnectMcp = useAtomCommand(extensionsEnvironment.reconnectMcp, { reportFailure: false });
  const beginMcpAuth = useAtomCommand(extensionsEnvironment.beginMcpAuth, { reportFailure: false });
  const relayMcpAuthCallback = useAtomCommand(extensionsEnvironment.relayMcpAuthCallback, {
    reportFailure: false,
  });

  useEffect(() => {
    const delayed = Object.entries(authStates).filter(
      ([, state]) => state.phase === "waiting" && !state.pasteVisible,
    );
    if (delayed.length === 0) return;
    const timeout = window.setTimeout(() => {
      setAuthStates((current) => {
        const next = { ...current };
        for (const [serverId] of delayed) {
          const state = next[serverId];
          if (state?.phase === "waiting") next[serverId] = { ...state, pasteVisible: true };
        }
        return next;
      });
    }, 4_000);
    return () => window.clearTimeout(timeout);
  }, [authStates]);

  useEffect(() => {
    if (mutationRevision !== null && (props.snapshot?.overrideRevision ?? 0) >= mutationRevision) {
      setMutationRevision(null);
    }
  }, [mutationRevision, props.snapshot?.overrideRevision]);

  const pending = props.snapshot ? extensionPending(props.snapshot) : false;
  const displayedMcp = useMemo(
    () =>
      props.durable
        ? (props.snapshot?.mcpServers ?? [])
        : applyDraftMcpOverrides(props.snapshot?.mcpServers ?? [], props.draftMcpOverrides),
    [props.draftMcpOverrides, props.durable, props.snapshot?.mcpServers],
  );
  const filteredSkills = useMemo(
    () => filterExtensionSkills(props.snapshot?.skills ?? [], deferredQuery),
    [deferredQuery, props.snapshot?.skills],
  );
  const filteredMcp = useMemo(
    () => filterExtensionMcpServers(displayedMcp, deferredQuery),
    [deferredQuery, displayedMcp],
  );

  const runRefresh = useCallback(
    async (domain: ThreadExtensionsRefreshDomain) => {
      if (refreshing.has(domain)) return;
      if (!props.durable && (!props.projectId || !props.providerInstanceId)) return;
      setRefreshing((current) => new Set(current).add(domain));
      setActionError(null);
      const result = props.durable
        ? await refresh({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, domain },
          })
        : await refreshPreview({
            environmentId: props.environmentId,
            input: {
              threadId: props.threadId,
              projectId: props.projectId!,
              providerInstanceId: props.providerInstanceId!,
              domain,
            },
          });
      setRefreshing((current) => {
        const next = new Set(current);
        next.delete(domain);
        return next;
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setActionError(
          errorMessage(squashAtomCommandFailure(result), `Could not refresh ${domain}.`),
        );
      }
    },
    [
      props.durable,
      props.environmentId,
      props.projectId,
      props.providerInstanceId,
      props.threadId,
      refresh,
      refreshPreview,
      refreshing,
    ],
  );

  useEffect(() => {
    if (!props.snapshot) return;
    let shouldRefresh = false;
    let changed = false;
    const next = { ...authStates };
    for (const server of props.snapshot.mcpServers) {
      const state = authStates[server.id];
      if (!state) continue;
      const advanced = advanceMcpAuthState(state, server);
      shouldRefresh ||= advanced.refresh;
      if (advanced.state === null) {
        delete next[server.id];
        changed = true;
      } else if (advanced.state !== state) {
        next[server.id] = advanced.state;
        changed = true;
      }
    }
    if (changed) setAuthStates(next);
    if (shouldRefresh) void runRefresh("mcp");
  }, [authStates, props.snapshot, runRefresh]);

  const setMcp = useCallback(
    async (server: ProviderMcpServer, state: ProviderExtensionOverrideState) => {
      if (!server.toggleable) return;
      if (!props.durable) {
        props.onSetDraftMcpOverride(server.id, state);
        return;
      }
      const snapshot = props.snapshot;
      if (!snapshot || mutationRevision !== null) return;
      setActionError(null);
      setMutationRevision(snapshot.overrideRevision + 1);
      const result = await setMcpOverride({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          mcpServerId: server.id,
          state,
          expectedRevision: snapshot.overrideRevision,
        },
      });
      if (result._tag === "Failure") {
        setMutationRevision(null);
        if (!isAtomCommandInterrupted(result)) {
          setActionError(
            errorMessage(squashAtomCommandFailure(result), "Could not update this MCP override."),
          );
        }
      }
    },
    [
      mutationRevision,
      props.durable,
      props.environmentId,
      props.onSetDraftMcpOverride,
      props.snapshot,
      props.threadId,
      setMcpOverride,
    ],
  );

  const reconnect = useCallback(
    async (server: ProviderMcpServer) => {
      if (!props.durable) return;
      setActionError(null);
      const result = await reconnectMcp({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, mcpServerId: server.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setActionError(
          errorMessage(squashAtomCommandFailure(result), `Could not reconnect ${server.name}.`),
        );
      }
    },
    [props.durable, props.environmentId, props.threadId, reconnectMcp],
  );

  const authenticate = useCallback(
    async (server: ProviderMcpServer) => {
      if (
        authStates[server.id]?.phase === "beginning" ||
        authStates[server.id]?.phase === "waiting"
      ) {
        return;
      }
      if (!props.durable && (!props.projectId || !props.providerInstanceId)) return;
      setActionError(null);
      setAuthStates((current) => ({ ...current, [server.id]: { phase: "beginning" } }));
      setCallbackUrls((current) => ({ ...current, [server.id]: "" }));
      const result = await beginMcpAuth({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          mcpServerId: server.id,
          ...(!props.durable
            ? {
                projectId: props.projectId!,
                providerInstanceId: props.providerInstanceId!,
              }
            : {}),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setAuthStates((current) => ({
            ...current,
            [server.id]: {
              phase: "error",
              message: errorMessage(
                squashAtomCommandFailure(result),
                `Could not authenticate ${server.name}.`,
              ),
            },
          }));
        }
        return;
      }
      const authorizationUrl = result.value.authorizationUrl;
      if (!authorizationUrl) {
        setAuthStates((current) => ({
          ...current,
          [server.id]: { phase: "error", message: "The provider did not return a login URL." },
        }));
        return;
      }
      setAuthStates((current) => ({
        ...current,
        [server.id]: createMcpAuthWaitingState({
          authorizationUrl,
          localClient: props.isAuthClientLocal,
          ...(server.error ? { baselineError: server.error } : {}),
        }),
      }));
      try {
        const localApi = readLocalApi();
        if (!localApi) throw new Error("The external-link handler is unavailable.");
        await localApi.shell.openExternal(authorizationUrl);
      } catch (error) {
        setAuthStates((current) => {
          const state = current[server.id];
          return state?.phase === "waiting"
            ? {
                ...current,
                [server.id]: {
                  ...state,
                  pasteVisible: true,
                  openError: errorMessage(
                    error,
                    `Could not open authentication for ${server.name}.`,
                  ),
                },
              }
            : current;
        });
      }
    },
    [
      authStates,
      beginMcpAuth,
      props.durable,
      props.environmentId,
      props.projectId,
      props.providerInstanceId,
      props.isAuthClientLocal,
      props.threadId,
    ],
  );

  const relayCallback = useCallback(
    async (server: ProviderMcpServer) => {
      const callbackUrl = callbackUrls[server.id]?.trim() ?? "";
      const state = authStates[server.id];
      if (!callbackUrl || state?.phase !== "waiting" || state.relayState === "submitting") return;
      if (!props.durable && (!props.projectId || !props.providerInstanceId)) return;
      setAuthStates((current) => {
        const currentState = current[server.id];
        if (currentState?.phase !== "waiting") return current;
        const { relayError: _relayError, ...waiting } = currentState;
        return {
          ...current,
          [server.id]: { ...waiting, relayState: "submitting" },
        };
      });
      const result = await relayMcpAuthCallback({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          mcpServerId: server.id,
          callbackUrl,
          ...(!props.durable
            ? {
                projectId: props.projectId!,
                providerInstanceId: props.providerInstanceId!,
              }
            : {}),
        },
      });
      setAuthStates((current) => {
        const currentState = current[server.id];
        if (currentState?.phase !== "waiting") return current;
        const { relayState: _relayState, relayError: _relayError, ...waiting } = currentState;
        if (result._tag === "Failure" && isAtomCommandInterrupted(result)) {
          return {
            ...current,
            [server.id]: waiting,
          };
        }
        return {
          ...current,
          [server.id]:
            result._tag === "Failure"
              ? {
                  ...waiting,
                  relayError: errorMessage(
                    squashAtomCommandFailure(result),
                    "Could not submit the redirect URL.",
                  ),
                }
              : { ...waiting, relayState: "submitted" },
        };
      });
    },
    [
      authStates,
      callbackUrls,
      props.durable,
      props.environmentId,
      props.projectId,
      props.providerInstanceId,
      props.threadId,
      relayMcpAuthCallback,
    ],
  );

  const copyAuthUrl = useCallback((url: string) => {
    if (!navigator.clipboard) {
      setActionError("Clipboard access is unavailable. Copy the URL from the row instead.");
      return;
    }
    void navigator.clipboard.writeText(url).catch((error) => {
      setActionError(errorMessage(error, "Could not copy the authentication URL."));
    });
  }, []);

  const retry = useCallback(() => {
    if (!props.snapshot) return;
    const target = extensionRetryTarget(props.snapshot);
    const server = target
      ? displayedMcp.find((candidate) => candidate.id === target.id)
      : undefined;
    if (target?.kind === "mcp" && server) void setMcp(server, target.state);
  }, [displayedMcp, props.snapshot, setMcp]);

  const errors = [
    ...new Map(
      (props.snapshot?.errors ?? []).map((error) => [
        `${error.domain}:${error.retryable}:${error.message}`,
        error,
      ]),
    ).values(),
  ];
  const mutationDisabled = mutationRevision !== null;
  const retryable = errors.some((error) => error.retryable);
  const initialMcpLoading =
    (props.isLoading && !props.snapshot) ||
    Boolean(props.snapshot?.loading.mcp && props.snapshot.refreshedAt === null);
  const initialSkillsLoading =
    (props.isLoading && !props.snapshot) ||
    Boolean(props.snapshot?.loading.skills && props.snapshot.refreshedAt === null);
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
          MCP changes control future availability and do not erase earlier conversation history.
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
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
                  {initialMcpLoading
                    ? "Discovering MCP servers…"
                    : `${props.snapshot?.mcpServers.length ?? 0} configured`}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={
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
            {initialMcpLoading ? (
              <ExtensionRowsSkeleton label="Discovering MCP servers…" />
            ) : props.snapshot && !props.snapshot.capabilities.mcp.inventory ? (
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
                    durable={props.durable}
                    disabled={mutationDisabled || !props.snapshot?.capabilities.mcp.threadOverride}
                    pending={
                      props.durable
                        ? pending && server.threadOverride !== "inherit"
                        : props.draftMcpOverrides[server.id] !== undefined
                    }
                    authState={authStates[server.id] ?? null}
                    callbackUrl={callbackUrls[server.id] ?? ""}
                    capabilities={props.snapshot!.capabilities.mcp}
                    onSet={(target, state) => void setMcp(target, state)}
                    onReconnect={(target) => void reconnect(target)}
                    onAuthenticate={(target) => void authenticate(target)}
                    onCopyAuthUrl={copyAuthUrl}
                    onCallbackUrlChange={(value) =>
                      setCallbackUrls((current) => ({ ...current, [server.id]: value }))
                    }
                    onRelayCallback={(target) => void relayCallback(target)}
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

          <section aria-labelledby="extensions-skills-heading">
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              aria-expanded={!skillsCollapsed}
              aria-controls="extensions-skills-content"
              onClick={() => setSkillsCollapsed(panelRef, !skillsCollapsed)}
            >
              {skillsCollapsed ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
              <div className="min-w-0 flex-1">
                <h3
                  id="extensions-skills-heading"
                  className="text-xs font-semibold uppercase tracking-wider"
                >
                  Skills
                </h3>
                <p className="text-[.68rem] text-muted-foreground">
                  {initialSkillsLoading
                    ? "Discovering skills…"
                    : `${props.snapshot?.skills.length ?? 0} discovered`}
                </p>
              </div>
            </button>
            {!skillsCollapsed ? (
              <div id="extensions-skills-content" className="mt-2">
                {initialSkillsLoading ? (
                  <ExtensionRowsSkeleton label="Discovering skills…" />
                ) : props.snapshot && !props.snapshot.capabilities.skills.inventory ? (
                  <div className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                    {props.snapshot.provider} does not expose contextual skill inventory yet.
                  </div>
                ) : (
                  <div className="space-y-4">
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
                              <SkillRow key={skill.id} skill={skill} />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {filteredSkills.length === 0 ? (
                      <p className="rounded-lg border border-border/65 p-3 text-xs text-muted-foreground">
                        No matching skills.
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
