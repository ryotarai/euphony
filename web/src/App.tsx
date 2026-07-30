import {
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiClient, ApiError } from "./api";
import {
  cwdFilterKey,
  SessionNavigation,
} from "./components/SessionNavigation";
import {
  isEditableTarget,
  matchesPrefix,
  normalizePrefix,
  shortcutsEqual,
} from "./keybindings";
import { TerminalView, type ConnectionState } from "./components/TerminalView";
import { TerminalPane } from "./components/TerminalPane";
import { PaneCarousel } from "./components/PaneCarousel";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Session, Settings } from "./types";

const tokenKey = "euphony.token";
interface AppProps {
  initialToken?: string;
  initialSettings?: Settings;
  renderTerminal?: (
    session: Session,
    api: ApiClient,
    active: boolean,
    layoutVersion: number,
    onConnectionChange: (sessionID: string, state: ConnectionState) => void,
    reconnectSignal: number,
  ) => ReactNode;
}

const defaultSettings: Settings = {
  prefix: "Ctrl+B",
  paneTabShortcut: "Meta+L",
  sidebarWidth: 256,
  sidebarCollapsed: false,
};

function sessionActivity(session: Session) {
  if (session.needsAttention) return "attention";
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

function activityLabel(status: string) {
  if (status === "attention") return "Need attention";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function matchesWorkspaceFilter(
  session: Session,
  statusFilters: string[],
  cwdFilters: string[],
) {
  const status = sessionActivity(session);
  return (
    statusFilters.includes(status) ||
    cwdFilters.includes(cwdFilterKey(status, session.cwd))
  );
}

function cwdFilterBelongsToStatus(filter: string, status: string) {
  return filter.startsWith(`${status}\u0000`);
}

export function attentionTransitions(previous: Session[], next: Session[]): Session[] {
  const previousAttention = new Map(
    previous.map((session) => [session.id, Boolean(session.needsAttention)]),
  );
  return next.filter(
    (session) =>
      session.needsAttention &&
      !previousAttention.get(session.id),
  );
}

export function agentLaunchTransitions(
  previous: Session[],
  next: Session[],
): Session[] {
  const previousActivity = new Map(
    previous.map((session) => [session.id, sessionActivity(session)]),
  );
  return next.filter(
    (session) =>
      Boolean(session.agent) &&
      previousActivity.get(session.id) === "terminal" &&
      sessionActivity(session) !== "terminal",
  );
}

function playAttentionTone() {
  if (typeof AudioContext === "undefined") return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.08, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.16);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.16);
  oscillator.addEventListener("ended", () => void context.close(), { once: true });
}

function resolveInitialToken(explicitToken?: string): string {
  if (explicitToken) return explicitToken;

  const parameters = new URLSearchParams(window.location.search);
  const queryToken = parameters.get("token")?.trim();
  if (queryToken) {
    parameters.delete("token");
    const query = parameters.toString();
    const cleanURL = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", cleanURL);
    sessionStorage.setItem(tokenKey, queryToken);
    return queryToken;
  }
  return sessionStorage.getItem(tokenKey) ?? "";
}

function workspaceFromURL(sessions: Session[]): {
  selectedIDs: string[];
  focusedID: string | null;
  statusFilters: string[];
  cwdFilters: string[];
} {
  const parameters = new URLSearchParams(window.location.search);
  const available = new Set(sessions.map((session) => session.id));
  let selectedIDs = parameters.getAll("terminal").filter((id) => available.has(id));
  if (selectedIDs.length === 0) {
    selectedIDs = [parameters.get("session"), parameters.get("split")]
      .filter((id): id is string => Boolean(id && available.has(id)));
  }
  if (selectedIDs.length === 0 && sessions[0]) selectedIDs = [sessions[0].id];
  const focus = parameters.get("focus");
  return {
    selectedIDs,
    focusedID: focus && selectedIDs.includes(focus) ? focus : selectedIDs[0] ?? null,
    statusFilters: parameters.getAll("status"),
    cwdFilters: parameters.getAll("cwd"),
  };
}

function writeWorkspaceToURL(
  selectedIDs: string[],
  focusedID: string | null,
  statusFilters: string[],
  cwdFilters: string[],
  mode: "push" | "replace" = "push",
) {
  const parameters = new URLSearchParams(window.location.search);
  parameters.delete("session");
  parameters.delete("split");
  parameters.delete("terminal");
  parameters.delete("status");
  parameters.delete("cwd");
  selectedIDs.forEach((id) => parameters.append("terminal", id));
  statusFilters.forEach((status) => parameters.append("status", status));
  cwdFilters.forEach((filter) => parameters.append("cwd", filter));
  if (focusedID) parameters.set("focus", focusedID);
  else parameters.delete("focus");
  const query = parameters.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url);
}

export function App({
  initialToken,
  initialSettings,
  renderTerminal = (
    session,
    api,
    active,
    layoutVersion,
    onConnectionChange,
    reconnectSignal,
  ) => (
    <TerminalView
      key={session.id}
      session={session}
      api={api}
      active={active}
      layoutVersion={layoutVersion}
      onConnectionChange={onConnectionChange}
      reconnectSignal={reconnectSignal}
    />
  ),
}: AppProps) {
  const [token, setToken] = useState(() => resolveInitialToken(initialToken));
  const [draftToken, setDraftToken] = useState("");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [selectedIDs, setSelectedIDs] = useState<string[]>([]);
  const [focusedID, setFocusedID] = useState<string | null>(null);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [cwdFilters, setCwdFilters] = useState<string[]>([]);
  const [authError, setAuthError] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [settings, setSettings] = useState(initialSettings ?? defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefixDraft, setPrefixDraft] = useState(settings.prefix);
  const [paneTabShortcutDraft, setPaneTabShortcutDraft] = useState(
    settings.paneTabShortcut,
  );
  const [settingsError, setSettingsError] = useState<{
    field: "prefix" | "paneTabShortcut";
    message: string;
  } | null>(null);
  const [prefixActive, setPrefixActive] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandValue, setCommandValue] = useState("new-terminal");
  const [createOpen, setCreateOpen] = useState(false);
  const [cwdDraft, setCWDDraft] = useState("");
  const [connectionStates, setConnectionStates] = useState<Record<string, ConnectionState>>({});
  const [reconnectSignals, setReconnectSignals] = useState<Record<string, number>>({});
  const commandInputRef = useRef<HTMLInputElement>(null);
  const prefixActiveRef = useRef(false);
  const filterSelectedIDsRef = useRef<Set<string>>(new Set());
  const decomposedStatusFiltersRef = useRef<Set<string>>(new Set());
  const previousSessionsRef = useRef<Session[]>([]);
  const pendingAgentLaunchIDsRef = useRef<Set<string>>(new Set());
  const pendingAttentionAcknowledgementsRef = useRef<Set<string>>(new Set());
  const api = useMemo(() => (token ? new ApiClient(token) : null), [token]);
  const handleConnectionChange = useCallback((sessionID: string, state: ConnectionState) => {
    setConnectionStates((current) =>
      current[sessionID] === state ? current : { ...current, [sessionID]: state },
    );
  }, []);

  useEffect(() => {
    if (!api || initialSettings) return;
    let active = true;
    api.getSettings().then((loaded) => {
      if (!active) return;
      setSettings(loaded);
      setPrefixDraft(loaded.prefix);
    }).catch((error: unknown) => {
      if (active) {
        setRequestError(error instanceof Error ? error.message : "Settings could not be loaded.");
      }
    });
    return () => {
      active = false;
    };
  }, [api, initialSettings]);

  useEffect(() => {
    if (!api) {
      setSessions(null);
      return;
    }
    let active = true;
    api
      .listSessions()
      .then(async (items) => {
        if (!active) return;
        if (items.length === 0) {
          const created = await api.createSession("Terminal");
          if (!active) return;
          items = [created];
        }
        setSessions(items);
        previousSessionsRef.current = items;
        const workspace = workspaceFromURL(items);
        setSelectedIDs(workspace.selectedIDs);
        setFocusedID(workspace.focusedID);
        setStatusFilters(workspace.statusFilters);
        setCwdFilters(workspace.cwdFilters);
        writeWorkspaceToURL(
          workspace.selectedIDs,
          workspace.focusedID,
          workspace.statusFilters,
          workspace.cwdFilters,
          "replace",
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          sessionStorage.removeItem(tokenKey);
          setAuthError(true);
          setToken("");
        } else {
          setRequestError(error instanceof Error ? error.message : "Euphony could not load sessions.");
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!api || !sessions) return;
    const timer = window.setInterval(() => {
      api.listSessions().then((items) => {
        const transitions = attentionTransitions(previousSessionsRef.current, items);
        pendingAgentLaunchIDsRef.current = new Set(
          agentLaunchTransitions(previousSessionsRef.current, items).map((session) => session.id),
        );
        previousSessionsRef.current = items;
        setSessions(items);
        for (const session of transitions) {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Euphony needs attention", {
              body: session.agentTitle || session.cwd,
              tag: `euphony-${session.id}`,
            });
          }
          playAttentionTone();
        }
      }).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [api, sessions !== null]);

  useEffect(() => {
    const promotedID =
      focusedID &&
      selectedIDs.includes(focusedID) &&
      pendingAgentLaunchIDsRef.current.has(focusedID)
        ? focusedID
        : null;
    pendingAgentLaunchIDsRef.current.clear();

    if (promotedID) {
      filterSelectedIDsRef.current.clear();
      decomposedStatusFiltersRef.current.clear();
      setSelectedIDs([promotedID]);
      setFocusedID(promotedID);
      setStatusFilters([]);
      setCwdFilters([]);
      writeWorkspaceToURL([promotedID], promotedID, [], [], "replace");
      return;
    }

    if (!sessions || (statusFilters.length === 0 && cwdFilters.length === 0)) return;
    const matches = sessions
      .filter((session) => matchesWorkspaceFilter(session, statusFilters, cwdFilters))
      .map((session) => session.id);
    const previousMatches = filterSelectedIDsRef.current;
    const next = [
      ...selectedIDs.filter((id) => !previousMatches.has(id)),
      ...matches,
    ].filter((id, index, values) => values.indexOf(id) === index);
    filterSelectedIDsRef.current = new Set(matches);
    if (next.join("\0") !== selectedIDs.join("\0")) {
      setSelectedIDs(next);
      const nextFocus = focusedID && next.includes(focusedID) ? focusedID : next[0] ?? null;
      setFocusedID(nextFocus);
      writeWorkspaceToURL(next, nextFocus, statusFilters, cwdFilters, "replace");
    }
  }, [sessions, statusFilters, cwdFilters, selectedIDs, focusedID]);

  useEffect(() => {
    if (!api || !sessions || !focusedID) return;
    const focused = sessions.find((session) => session.id === focusedID);
    if (
      !focused ||
      !focused.needsAttention ||
      pendingAttentionAcknowledgementsRef.current.has(focusedID)
    ) {
      return;
    }
    pendingAttentionAcknowledgementsRef.current.add(focusedID);
    api.acknowledgeAttention(focusedID).then((acknowledged) => {
      setSessions((current) =>
        current?.map((session) =>
          session.id === acknowledged.id &&
          session.needsAttention
            ? acknowledged
            : session
        ) ?? current
      );
      previousSessionsRef.current = previousSessionsRef.current.map((session) =>
        session.id === acknowledged.id &&
        session.needsAttention
          ? acknowledged
          : session
      );
    }).catch((error: unknown) => {
      setRequestError(
        error instanceof Error
          ? error.message
          : "The terminal attention state could not be acknowledged.",
      );
    }).finally(() => {
      pendingAttentionAcknowledgementsRef.current.delete(focusedID);
    });
  }, [api, sessions, focusedID]);

  useEffect(() => {
    const openCommands = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      setCommandQuery("");
      setCommandValue("new-terminal");
      setCommandOpen(true);
    };
    window.addEventListener("keydown", openCommands, { capture: true });
    return () => window.removeEventListener("keydown", openCommands, { capture: true });
  }, []);

  useEffect(() => {
    if (!commandOpen) return;
    const frame = window.requestAnimationFrame(() => commandInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [commandOpen]);

  useEffect(() => {
    if (!sessions) return;
    const restore = () => {
      const workspace = workspaceFromURL(sessions);
      filterSelectedIDsRef.current.clear();
      decomposedStatusFiltersRef.current.clear();
      setSelectedIDs(workspace.selectedIDs);
      setFocusedID(workspace.focusedID);
      setStatusFilters(workspace.statusFilters);
      setCwdFilters(workspace.cwdFilters);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [sessions]);

  useEffect(() => {
    const clearPrefix = () => {
      prefixActiveRef.current = false;
      setPrefixActive(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!prefixActiveRef.current) {
        if (!matchesPrefix(event, settings.prefix)) return;
        event.preventDefault();
        event.stopPropagation();
        prefixActiveRef.current = true;
        setPrefixActive(true);
        return;
      }
      clearPrefix();
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const command = event.key.toLowerCase();
      if (!["c", "h", "l", "n", "p", "v"].includes(command)) return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "c") {
        void createSession(false);
      } else if (command === "v") {
        void createSession(true);
      } else if (command === "h" || command === "l") {
        const current = Math.max(0, selectedIDs.indexOf(focusedID ?? ""));
        const offset = command === "h" ? -1 : 1;
        const next = selectedIDs[current + offset];
        if (next) focusPane(next);
      } else if (sessions && sessions.length > 0) {
        const current = Math.max(0, sessions.findIndex((item) => item.id === focusedID));
        const offset = command === "p" ? -1 : 1;
        const next = sessions[(current + offset + sessions.length) % sessions.length];
        if (next) selectSession(next.id, false);
      }
    };
    window.addEventListener("keydown", handleKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKey, { capture: true });
    };
  }, [focusedID, selectedIDs, sessions, settings.prefix]);

  function selectSession(id: string, multiple: boolean) {
    let nextIDs: string[];
    if (!multiple) {
      nextIDs = [id];
      setStatusFilters([]);
      setCwdFilters([]);
      filterSelectedIDsRef.current.clear();
      decomposedStatusFiltersRef.current.clear();
    } else if (selectedIDs.includes(id)) {
      const availableSessions = sessions ?? [];
      const session = availableSessions.find((item) => item.id === id);
      const status = session ? sessionActivity(session) : "";
      const key = session ? cwdFilterKey(status, session.cwd) : "";
      const statusOwnsSession = statusFilters.includes(status);
      const cwdOwnsSession = cwdFilters.includes(key);
      if (session && (statusOwnsSession || cwdOwnsSession)) {
        const nextStatusFilters = statusFilters.filter((item) => item !== status);
        let nextCwdFilters = cwdFilters.filter((item) => item !== key);
        if (statusOwnsSession) {
          decomposedStatusFiltersRef.current.add(status);
          const siblingCwdFilters = [
            ...new Set(
              availableSessions
                .filter(
                  (item) =>
                    sessionActivity(item) === status &&
                    item.cwd !== session.cwd,
                )
                .map((item) => cwdFilterKey(status, item.cwd)),
            ),
          ];
          nextCwdFilters = [
            ...cwdFilters.filter(
              (filter) => !cwdFilterBelongsToStatus(filter, status),
            ),
            ...siblingCwdFilters,
          ];
        }
        const matching = availableSessions
          .filter((item) =>
            matchesWorkspaceFilter(item, nextStatusFilters, nextCwdFilters)
          )
          .map((item) => item.id);
        nextIDs = [
          ...new Set([
            ...selectedIDs.filter((item) => item !== id),
            ...matching,
          ]),
        ];
        if (nextIDs.length === 0) nextIDs = [id];
        filterSelectedIDsRef.current = new Set(matching);
        const nextFocus = nextIDs.includes(id) ? id : nextIDs[0] ?? null;
        setStatusFilters(nextStatusFilters);
        setCwdFilters(nextCwdFilters);
        setSelectedIDs(nextIDs);
        setFocusedID(nextFocus);
        writeWorkspaceToURL(
          nextIDs,
          nextFocus,
          nextStatusFilters,
          nextCwdFilters,
        );
        return;
      }
      nextIDs = selectedIDs.length === 1
        ? selectedIDs
        : selectedIDs.filter((item) => item !== id);
    } else {
      nextIDs = [...selectedIDs, id];
    }
    const nextFocus = nextIDs.includes(id) ? id : nextIDs[0] ?? null;
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(
      nextIDs,
      nextFocus,
      multiple ? statusFilters : [],
      multiple ? cwdFilters : [],
    );
  }

  function updateWorkspaceFilters(
    nextStatusFilters: string[],
    nextCwdFilters: string[],
  ) {
    const matching = sessions
      ?.filter((session) =>
        matchesWorkspaceFilter(session, nextStatusFilters, nextCwdFilters)
      )
      .map((session) => session.id) ?? [];
    const base = selectedIDs.filter((id) => !filterSelectedIDsRef.current.has(id));
    const nextIDs = [...new Set([...base, ...matching])];
    filterSelectedIDsRef.current = new Set(matching);
    const nextFocus = focusedID && nextIDs.includes(focusedID)
      ? focusedID
      : nextIDs[0] ?? null;
    setStatusFilters(nextStatusFilters);
    setCwdFilters(nextCwdFilters);
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(
      nextIDs,
      nextFocus,
      nextStatusFilters,
      nextCwdFilters,
    );
  }

  function updateStatusFilter(status: string, checked: boolean) {
    decomposedStatusFiltersRef.current.delete(status);
    const nextStatusFilters = checked
      ? [...new Set([...statusFilters, status])]
      : statusFilters.filter((item) => item !== status);
    const nextCwdFilters = cwdFilters.filter(
      (filter) => !cwdFilterBelongsToStatus(filter, status),
    );
    updateWorkspaceFilters(nextStatusFilters, nextCwdFilters);
  }

  function updateCwdFilter(
    status: string,
    cwd: string,
    checked: boolean,
  ) {
    const key = cwdFilterKey(status, cwd);
    if (!checked && statusFilters.includes(status)) {
      decomposedStatusFiltersRef.current.add(status);
      const siblingCwdFilters = [
        ...new Set(
          (sessions ?? [])
            .filter(
              (session) =>
                sessionActivity(session) === status && session.cwd !== cwd,
            )
            .map((session) => cwdFilterKey(status, session.cwd)),
        ),
      ];
      updateWorkspaceFilters(
        statusFilters.filter((item) => item !== status),
        [
          ...cwdFilters.filter(
            (filter) => !cwdFilterBelongsToStatus(filter, status),
          ),
          ...siblingCwdFilters,
        ],
      );
      return;
    }
    const nextFilters = checked
      ? [...new Set([...cwdFilters, key])]
      : cwdFilters.filter((item) => item !== key);
    const existingStatusCwdFilters = cwdFilters.filter((filter) =>
      cwdFilterBelongsToStatus(filter, status)
    );
    const currentStatusCwdFilters = [
      ...new Set(
        (sessions ?? [])
          .filter((session) => sessionActivity(session) === status)
          .map((session) => cwdFilterKey(status, session.cwd)),
      ),
    ];
    if (
      checked &&
      (
        existingStatusCwdFilters.length > 0 ||
        decomposedStatusFiltersRef.current.has(status)
      ) &&
      currentStatusCwdFilters.every((filter) => nextFilters.includes(filter))
    ) {
      decomposedStatusFiltersRef.current.delete(status);
      updateWorkspaceFilters(
        [...new Set([...statusFilters, status])],
        nextFilters.filter(
          (filter) => !cwdFilterBelongsToStatus(filter, status),
        ),
      );
      return;
    }
    updateWorkspaceFilters(statusFilters, nextFilters);
  }

  function selectStatus(status: string) {
    const nextIDs = sessions
      ?.filter((session) => sessionActivity(session) === status)
      .map((session) => session.id) ?? [];
    if (nextIDs.length === 0) return;
    decomposedStatusFiltersRef.current.clear();
    const nextFocus = nextIDs[0];
    setStatusFilters([status]);
    setCwdFilters([]);
    filterSelectedIDsRef.current = new Set(nextIDs);
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(nextIDs, nextFocus, [status], []);
  }

  function selectCwd(status: string, cwd: string) {
    const nextIDs = sessions
      ?.filter(
        (session) =>
          sessionActivity(session) === status && session.cwd === cwd,
      )
      .map((session) => session.id) ?? [];
    if (nextIDs.length === 0) return;
    decomposedStatusFiltersRef.current.clear();
    const nextFocus = nextIDs[0];
    const nextCwdFilters = [cwdFilterKey(status, cwd)];
    setStatusFilters([]);
    setCwdFilters(nextCwdFilters);
    filterSelectedIDsRef.current = new Set(nextIDs);
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(nextIDs, nextFocus, [], nextCwdFilters);
  }

  function focusPane(id: string) {
    setFocusedID(id);
    writeWorkspaceToURL(selectedIDs, id, statusFilters, cwdFilters);
  }

  function authenticate(event: FormEvent) {
    event.preventDefault();
    const value = draftToken.trim();
    if (!value) return;
    setAuthError(false);
    sessionStorage.setItem(tokenKey, value);
    setToken(value);
  }

  async function createSession(split = false, cwd?: string) {
    if (!api) return;
    try {
      const created = await api.createSession("Terminal", cwd);
      setSessions((current) => [...(current ?? []), created]);
      const nextIDs = split ? [...selectedIDs, created.id] : [created.id];
      setSelectedIDs(nextIDs);
      setFocusedID(created.id);
      setStatusFilters([]);
      setCwdFilters([]);
      filterSelectedIDsRef.current.clear();
      decomposedStatusFiltersRef.current.clear();
      writeWorkspaceToURL(nextIDs, created.id, [], []);
      setRequestError("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The terminal could not start.");
    }
  }

  function openCreateDialog() {
    const focused = sessions?.find((session) => session.id === focusedID);
    setCWDDraft(focused?.cwd ?? "");
    setCommandOpen(false);
    setCreateOpen(true);
  }

  async function enableAttentionAlerts() {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    playAttentionTone();
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    await createSession(false, cwdDraft.trim());
    setCreateOpen(false);
  }

  async function deleteSession(item: Session) {
    if (!api) return;
    try {
      await api.deleteSession(item.id);
      const remaining = sessions?.filter((candidate) => candidate.id !== item.id) ?? [];
      setSessions(remaining);
      let nextIDs = selectedIDs.filter((id) => id !== item.id);
      if (nextIDs.length === 0 && remaining[0]) nextIDs = [remaining[0].id];
      const nextFocus = focusedID === item.id ? nextIDs[0] ?? null : focusedID;
      setSelectedIDs(nextIDs);
      setFocusedID(nextFocus);
      writeWorkspaceToURL(nextIDs, nextFocus, statusFilters, cwdFilters);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The terminal could not be deleted.");
    }
  }

  async function persistSettings(next: Settings) {
    if (!api) return;
    const previous = settings;
    setSettings(next);
    try {
      const saved = await api.updateSettings(next);
      setSettings(saved);
      setRequestError("");
    } catch (error) {
      setSettings(previous);
      setRequestError(error instanceof Error ? error.message : "Settings could not be saved.");
    }
  }

  function openSettings() {
    setPrefixDraft(settings.prefix);
    setPaneTabShortcutDraft(settings.paneTabShortcut);
    setSettingsError(null);
    setSettingsOpen(true);
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    const prefix = normalizePrefix(prefixDraft);
    const paneTabShortcut = normalizePrefix(paneTabShortcutDraft);
    if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(prefix)) {
      setSettingsError({
        field: "prefix",
        message: "Use modifiers and one key, for example Ctrl+B.",
      });
      return;
    }
    if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(paneTabShortcut)) {
      setSettingsError({
        field: "paneTabShortcut",
        message: "Use modifiers and one key, for example Meta+L.",
      });
      return;
    }
    if (shortcutsEqual(prefix, paneTabShortcut)) {
      setSettingsError({
        field: "paneTabShortcut",
        message: "Choose a different shortcut from Prefix.",
      });
      return;
    }
    await persistSettings({ ...settings, prefix, paneTabShortcut });
    setSettingsOpen(false);
  }

  if (!token) {
    return (
      <main className="auth-shell">
        <form className="auth-panel" onSubmit={authenticate}>
          <p className="eyebrow">Private terminal relay</p>
          <h1>Euphony</h1>
          <p>Connect to the coding sessions running on this machine.</p>
          <label htmlFor="token">Access token</label>
          <input
            id="token"
            type="password"
            autoComplete="current-password"
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
            autoFocus
          />
          {authError && <p className="field-error">That token was not accepted.</p>}
          <button type="submit">Open Euphony</button>
        </form>
      </main>
    );
  }

  if (sessions === null) {
    return <main className="loading-screen">Connecting to Euphony…</main>;
  }

  const panes = selectedIDs
    .map((id) => sessions.find((item) => item.id === id))
    .filter((item): item is Session => Boolean(item));
  const selected = sessions.find((item) => item.id === focusedID) ?? panes[0];
  const disconnectedIDs = panes
    .filter((pane) => connectionStates[pane.id] === "disconnected")
    .map((pane) => pane.id);
  const connectingCount = panes.filter(
    (pane) => connectionStates[pane.id] === "connecting",
  ).length;
  const exitedCount = panes.filter(
    (pane) => connectionStates[pane.id] === "exited",
  ).length;
  const quickActions = [
    {
      value: "new-terminal",
      label: "New terminal in directory…",
      detail: "Choose a working directory",
      search: "new terminal create directory cwd",
      run: openCreateDialog,
      group: "Actions",
    },
    {
      value: "attention-alerts",
      label: "Enable attention alerts",
      detail: "Desktop notification and sound",
      search: "enable attention alerts notification sound",
      run: () => {
        setCommandOpen(false);
        void enableAttentionAlerts();
      },
      group: "Actions",
    },
    ...["attention", "running", "waiting", "terminal"]
      .filter((status) => sessions.some((session) => sessionActivity(session) === status))
      .map((status) => ({
        value: `status:${status}`,
        label: `Show only ${activityLabel(status)} terminals`,
        detail: "Replace the current pane selection",
        search: `show only ${activityLabel(status)} terminals status`,
        run: () => {
          selectStatus(status);
          setCommandOpen(false);
        },
        group: "Actions",
      })),
    ...sessions.map((session) => ({
      value: `session:${session.id}`,
      label: session.agentTitle || session.name,
      detail: session.cwd,
      search: `${session.agentTitle ?? ""} ${session.name} ${session.cwd}`,
      run: () => {
        selectSession(session.id, false);
        setCommandOpen(false);
      },
      group: "Terminals",
    })),
  ];
  const normalizedCommandQuery = commandQuery.trim().toLowerCase();
  const filteredQuickActions = quickActions.filter((action) =>
    `${action.label} ${action.search}`.toLowerCase().includes(normalizedCommandQuery),
  );

  const updateCommandQuery = (query: string) => {
    setCommandQuery(query);
    const normalized = query.trim().toLowerCase();
    const first = quickActions.find((action) =>
      `${action.label} ${action.search}`.toLowerCase().includes(normalized),
    );
    setCommandValue(first?.value ?? "");
  };

  const moveCommandSelection = (offset: number) => {
    if (filteredQuickActions.length === 0) return;
    const currentIndex = filteredQuickActions.findIndex(
      (action) => action.value === commandValue,
    );
    const start = currentIndex < 0 ? (offset > 0 ? -1 : 0) : currentIndex;
    const nextIndex =
      (start + offset + filteredQuickActions.length) % filteredQuickActions.length;
    setCommandValue(filteredQuickActions[nextIndex].value);
  };

  const handleCommandKeyDown = (event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const offset =
      event.key === "ArrowDown" || (event.ctrlKey && key === "n")
        ? 1
        : event.key === "ArrowUp" || (event.ctrlKey && key === "p")
          ? -1
          : 0;
    if (offset !== 0) {
      event.preventDefault();
      event.stopPropagation();
      moveCommandSelection(offset);
      return;
    }
    if (event.key === "Enter") {
      const selectedAction = filteredQuickActions.find(
        (action) => action.value === commandValue,
      );
      if (!selectedAction) return;
      event.preventDefault();
      selectedAction.run();
    }
  };

  const reconnectDisconnected = () => {
    setReconnectSignals((current) => {
      const next = { ...current };
      disconnectedIDs.forEach((id) => {
        next[id] = (next[id] ?? 0) + 1;
      });
      return next;
    });
  };

  return (
    <main className="workspace">
      <SessionNavigation
        sessions={sessions}
        selectedIDs={selectedIDs}
        statusFilters={statusFilters}
        cwdFilters={cwdFilters}
        onSelect={selectSession}
        onStatusFilter={updateStatusFilter}
        onStatusSelect={selectStatus}
        onCwdFilter={updateCwdFilter}
        onCwdSelect={selectCwd}
        onCreate={() => void createSession()}
        onDelete={(item) => void deleteSession(item)}
        settings={settings}
        onSettingsChange={(next) => void persistSettings(next)}
        onOpenSettings={openSettings}
      />
      <section
        className="terminal-stage"
        data-multiple={panes.length > 1}
      >
        {requestError && <p role="alert">{requestError}</p>}
        {disconnectedIDs.length > 0 ? (
          <div
            className="connection-status"
            role="status"
            aria-label="Terminal connection"
          >
            <span>
              Connection interrupted
              {disconnectedIDs.length > 1 ? ` · ${disconnectedIDs.length} panes` : ""}
            </span>
            <Button variant="outline" size="sm" onClick={reconnectDisconnected}>
              Reconnect
            </Button>
          </div>
        ) : connectingCount > 0 ? (
          <div
            className="connection-status"
            role="status"
            aria-label="Terminal connection"
          >
            Connecting…
          </div>
        ) : exitedCount > 0 ? (
          <div
            className="connection-status"
            role="status"
            aria-label="Terminal connection"
          >
            Terminal exited{exitedCount > 1 ? ` · ${exitedCount} panes` : ""}
          </div>
        ) : null}
        {panes.length > 0 && api ? (
          <PaneCarousel
            focusedID={focusedID}
            onFocus={focusPane}
            panes={panes.map((pane) => ({
              id: pane.id,
              label: `${pane.name} pane`,
              content: (
                <TerminalPane
                  session={pane}
                  api={api}
                  active={focusedID === pane.id}
                  layoutVersion={panes.length}
                  tabShortcut={settings.paneTabShortcut}
                  renderTerminal={(paneLayoutVersion, terminalActive) =>
                    renderTerminal(
                      pane,
                      api,
                      terminalActive,
                      paneLayoutVersion,
                      handleConnectionChange,
                      reconnectSignals[pane.id] ?? 0,
                    )
                  }
                />
              ),
            }))}
          />
        ) : (
          <div className="empty-state">
            <p>No signal yet.</p>
            <button onClick={() => void createSession()}>Start a terminal</button>
          </div>
        )}
      </section>
      {prefixActive && (
        <div className="prefix-command-guide" role="status" aria-label="Prefix commands">
          <span><kbd>c</kbd>: Create a terminal</span>
          <i aria-hidden="true">|</i>
          <span><kbd>v</kbd>: Split vertically</span>
          <i aria-hidden="true">|</i>
          <span><kbd>h/l</kbd>: Focus pane</span>
          <i aria-hidden="true">|</i>
          <span><kbd>n/p</kbd>: Switch terminal</span>
          <i aria-hidden="true">|</i>
          <span><kbd>Esc</kbd>: Cancel</span>
        </div>
      )}
      <CommandDialog
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Quick Actions"
        description="Search for a terminal or action."
        className="sm:max-w-xl"
        initialFocus={commandInputRef}
      >
        <Command
          value={commandValue}
          onValueChange={setCommandValue}
          shouldFilter={false}
          onKeyDownCapture={handleCommandKeyDown}
        >
          <CommandInput
            ref={commandInputRef}
            value={commandQuery}
            onValueChange={updateCommandQuery}
            placeholder="Terminal or status"
          />
          <CommandList>
            <CommandEmpty>No matching actions.</CommandEmpty>
            {["Actions", "Terminals"].map((group) => {
              const actions = filteredQuickActions.filter(
                (action) => action.group === group,
              );
              if (actions.length === 0) return null;
              return (
                <CommandGroup heading={group} key={group}>
                  {actions.map((action) => (
                    <CommandItem
                      key={action.value}
                      value={action.value}
                      onSelect={action.run}
                    >
                      <span className="quick-action-copy">
                        <span>{action.label}</span>
                        <small>{action.detail}</small>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </CommandDialog>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New terminal</DialogTitle>
            <DialogDescription>
              Start a terminal in the selected working directory.
            </DialogDescription>
          </DialogHeader>
          <form
            className="create-terminal-form"
            onSubmit={(event) => void submitCreate(event)}
          >
            <label htmlFor="terminal-cwd">Working directory</label>
            <input
              id="terminal-cwd"
              value={cwdDraft}
              onChange={(event) => setCWDDraft(event.target.value)}
              autoFocus
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Create terminal</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              Configure terminal workspace shortcuts.
            </DialogDescription>
          </DialogHeader>
          <form
            className="settings-form"
            onSubmit={(event) => void saveSettings(event)}
          >
            <FieldGroup>
              <Field data-invalid={settingsError?.field === "prefix"}>
                <FieldLabel htmlFor="prefix">Prefix</FieldLabel>
                <Input
                  id="prefix"
                  value={prefixDraft}
                  onChange={(event) => setPrefixDraft(event.target.value)}
                  aria-invalid={settingsError?.field === "prefix"}
                  autoFocus
                />
                <FieldDescription>
                  Commands: c new, v split, h/l pane, n/p terminal.
                </FieldDescription>
                {settingsError?.field === "prefix" && (
                  <FieldError>{settingsError.message}</FieldError>
                )}
              </Field>
              <Field data-invalid={settingsError?.field === "paneTabShortcut"}>
                <FieldLabel htmlFor="pane-tab-shortcut">Pane tab toggle</FieldLabel>
                <Input
                  id="pane-tab-shortcut"
                  value={paneTabShortcutDraft}
                  onChange={(event) => setPaneTabShortcutDraft(event.target.value)}
                  aria-invalid={settingsError?.field === "paneTabShortcut"}
                />
                <FieldDescription>
                  Switch the focused pane between Terminal and Agent log.
                </FieldDescription>
                {settingsError?.field === "paneTabShortcut" && (
                  <FieldError>{settingsError.message}</FieldError>
                )}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSettingsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save settings</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
