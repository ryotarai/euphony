import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError } from "./api";
import { SessionNavigation } from "./components/SessionNavigation";
import { isEditableTarget, matchesPrefix, normalizePrefix } from "./keybindings";
import { TerminalView } from "./components/TerminalView";
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
  ) => ReactNode;
}

const defaultSettings: Settings = {
  prefix: "Ctrl+B",
  sidebarWidth: 256,
  sidebarCollapsed: false,
};

function sessionActivity(session: Session) {
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

export function attentionTransitions(previous: Session[], next: Session[]): Session[] {
  const previousActivity = new Map(previous.map((session) => [session.id, sessionActivity(session)]));
  return next.filter(
    (session) =>
      sessionActivity(session) === "attention" &&
      previousActivity.get(session.id) !== "attention",
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
  };
}

function writeWorkspaceToURL(
  selectedIDs: string[],
  focusedID: string | null,
  statusFilters: string[],
  mode: "push" | "replace" = "push",
) {
  const parameters = new URLSearchParams(window.location.search);
  parameters.delete("session");
  parameters.delete("split");
  parameters.delete("terminal");
  parameters.delete("status");
  selectedIDs.forEach((id) => parameters.append("terminal", id));
  statusFilters.forEach((status) => parameters.append("status", status));
  if (focusedID) parameters.set("focus", focusedID);
  else parameters.delete("focus");
  const query = parameters.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url);
}

export function App({
  initialToken,
  initialSettings,
  renderTerminal = (session, api, active, layoutVersion) => (
    <TerminalView
      key={session.id}
      session={session}
      api={api}
      active={active}
      layoutVersion={layoutVersion}
    />
  ),
}: AppProps) {
  const [token, setToken] = useState(() => resolveInitialToken(initialToken));
  const [draftToken, setDraftToken] = useState("");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [selectedIDs, setSelectedIDs] = useState<string[]>([]);
  const [focusedID, setFocusedID] = useState<string | null>(null);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [authError, setAuthError] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [settings, setSettings] = useState(initialSettings ?? defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefixDraft, setPrefixDraft] = useState(settings.prefix);
  const [settingsError, setSettingsError] = useState("");
  const [prefixActive, setPrefixActive] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [cwdDraft, setCWDDraft] = useState("");
  const prefixActiveRef = useRef(false);
  const filterSelectedIDsRef = useRef<Set<string>>(new Set());
  const previousSessionsRef = useRef<Session[]>([]);
  const api = useMemo(() => (token ? new ApiClient(token) : null), [token]);

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
        writeWorkspaceToURL(
          workspace.selectedIDs,
          workspace.focusedID,
          workspace.statusFilters,
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
    if (!sessions || statusFilters.length === 0) return;
    const matches = sessions
      .filter((session) => statusFilters.includes(sessionActivity(session)))
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
      writeWorkspaceToURL(next, nextFocus, statusFilters, "replace");
    }
  }, [sessions, statusFilters, selectedIDs, focusedID]);

  useEffect(() => {
    const openCommands = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      setCommandQuery("");
      setCommandOpen(true);
    };
    window.addEventListener("keydown", openCommands, { capture: true });
    return () => window.removeEventListener("keydown", openCommands, { capture: true });
  }, []);

  useEffect(() => {
    if (!sessions) return;
    const restore = () => {
      const workspace = workspaceFromURL(sessions);
      setSelectedIDs(workspace.selectedIDs);
      setFocusedID(workspace.focusedID);
      setStatusFilters(workspace.statusFilters);
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
      filterSelectedIDsRef.current.clear();
    } else if (selectedIDs.includes(id)) {
      nextIDs = selectedIDs.length === 1 ? selectedIDs : selectedIDs.filter((item) => item !== id);
    } else {
      nextIDs = [...selectedIDs, id];
    }
    const nextFocus = nextIDs.includes(id) ? id : nextIDs[0] ?? null;
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(nextIDs, nextFocus, multiple ? statusFilters : []);
  }

  function updateStatusFilter(status: string, checked: boolean) {
    const nextFilters = checked
      ? [...statusFilters, status]
      : statusFilters.filter((item) => item !== status);
    const matching = sessions
      ?.filter((session) => nextFilters.includes(sessionActivity(session)))
      .map((session) => session.id) ?? [];
    const base = selectedIDs.filter((id) => !filterSelectedIDsRef.current.has(id));
    const nextIDs = [...new Set([...base, ...matching])];
    filterSelectedIDsRef.current = new Set(matching);
    const nextFocus = focusedID && nextIDs.includes(focusedID)
      ? focusedID
      : nextIDs[0] ?? null;
    setStatusFilters(nextFilters);
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(nextIDs, nextFocus, nextFilters);
  }

  function selectStatus(status: string) {
    const nextIDs = sessions
      ?.filter((session) => sessionActivity(session) === status)
      .map((session) => session.id) ?? [];
    if (nextIDs.length === 0) return;
    const nextFocus = nextIDs[0];
    setStatusFilters([status]);
    filterSelectedIDsRef.current = new Set(nextIDs);
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(nextIDs, nextFocus, [status]);
  }

  function focusPane(id: string) {
    setFocusedID(id);
    writeWorkspaceToURL(selectedIDs, id, statusFilters);
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
      writeWorkspaceToURL(nextIDs, created.id, []);
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
      writeWorkspaceToURL(nextIDs, nextFocus, statusFilters);
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
    setSettingsError("");
    setSettingsOpen(true);
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    const prefix = normalizePrefix(prefixDraft);
    if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(prefix)) {
      setSettingsError("Use modifiers and one key, for example Ctrl+B.");
      return;
    }
    await persistSettings({ ...settings, prefix });
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

  return (
    <main className="workspace">
      <SessionNavigation
        sessions={sessions}
        selectedIDs={selectedIDs}
        statusFilters={statusFilters}
        onSelect={selectSession}
        onStatusFilter={updateStatusFilter}
        onStatusSelect={selectStatus}
        onCreate={() => void createSession()}
        onDelete={(item) => void deleteSession(item)}
        settings={settings}
        onSettingsChange={(next) => void persistSettings(next)}
        onOpenSettings={openSettings}
      />
      <section
        className="terminal-stage"
        data-multiple={panes.length > 1}
        style={{ gridTemplateColumns: `repeat(${Math.max(panes.length, 1)}, minmax(0, 1fr))` }}
      >
        {requestError && <p role="alert">{requestError}</p>}
        {panes.length > 0 && api ? (
          panes.map((pane) => (
              <div
                key={pane.id}
                className="terminal-pane"
                data-active={focusedID === pane.id}
                aria-label={`${pane.name} pane`}
                onMouseDown={() => focusPane(pane.id)}
              >
                {renderTerminal(pane, api, focusedID === pane.id, panes.length)}
              </div>
          ))
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
      {commandOpen && (
        <div className="command-layer" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCommandOpen(false);
        }}>
          <div className="command-dialog" role="dialog" aria-modal="true" aria-label="Commands">
            <label htmlFor="command-search">Jump to</label>
            <input
              id="command-search"
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Terminal or status"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Escape") setCommandOpen(false);
              }}
            />
            <div className="command-results">
              <button onClick={openCreateDialog}>New terminal in directory…</button>
              <button onClick={() => void enableAttentionAlerts()}>Enable attention alerts</button>
              {["attention", "running", "waiting", "terminal"]
                .filter((status) => sessions.some((session) => sessionActivity(session) === status))
                .filter((status) => status.includes(commandQuery.toLowerCase()))
                .map((status) => (
                  <button key={status} onClick={() => {
                    selectStatus(status);
                    setCommandOpen(false);
                  }}>
                    Show only {status === "attention" ? "Need attention" : status}
                  </button>
                ))}
              {sessions
                .filter((session) =>
                  `${session.agentTitle ?? ""} ${session.cwd}`.toLowerCase()
                    .includes(commandQuery.toLowerCase()),
                )
                .map((session) => (
                  <button key={session.id} onClick={() => {
                    selectSession(session.id, false);
                    setCommandOpen(false);
                  }}>
                    <span>{session.agentTitle || session.name}</span>
                    <small>{session.cwd}</small>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
      {createOpen && (
        <div className="command-layer" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCreateOpen(false);
        }}>
          <form className="command-dialog" role="dialog" aria-modal="true" aria-label="New terminal" onSubmit={(event) => void submitCreate(event)}>
            <label htmlFor="terminal-cwd">Working directory</label>
            <input id="terminal-cwd" value={cwdDraft} onChange={(event) => setCWDDraft(event.target.value)} autoFocus />
            <div className="settings-controls">
              <button type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button type="submit">Create terminal</button>
            </div>
          </form>
        </div>
      )}
      {settingsOpen && (
        <div
          className="settings-layer"
          onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}
        >
          <form
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onSubmit={(event) => void saveSettings(event)}
          >
            <p className="eyebrow">Key bindings</p>
            <h2>Settings</h2>
            <label htmlFor="prefix">Prefix</label>
            <input
              id="prefix"
              value={prefixDraft}
              onChange={(event) => setPrefixDraft(event.target.value)}
              autoFocus
            />
            <p className="settings-hint">
              Commands: c new, v split, h/l pane, n/p terminal.
            </p>
            {settingsError && <p className="field-error">{settingsError}</p>}
            <div className="settings-controls">
              <button type="button" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button type="submit">Save settings</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
