import { FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { ApiClient, ApiError } from "./api";
import { SessionNavigation } from "./components/SessionNavigation";
import { TerminalView } from "./components/TerminalView";
import type { Session } from "./types";

const tokenKey = "euphony.token";
type PaneIndex = 0 | 1;
type PaneIDs = [string | null, string | null];

interface AppProps {
  initialToken?: string;
  renderTerminal?: (session: Session, api: ApiClient) => ReactNode;
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

function workspaceFromURL(sessions: Session[]): { paneIDs: PaneIDs; activePane: PaneIndex } {
  const parameters = new URLSearchParams(window.location.search);
  const available = new Set(sessions.map((session) => session.id));
  const primary = parameters.get("session");
  const primaryID = primary && available.has(primary) ? primary : sessions[0]?.id ?? null;
  const split = parameters.get("split");
  const splitID = split && split !== primaryID && available.has(split) ? split : null;
  const focus = parameters.get("focus");
  return {
    paneIDs: [primaryID, splitID],
    activePane: focus && focus === splitID ? 1 : 0,
  };
}

function writeWorkspaceToURL(
  [primaryID, splitID]: PaneIDs,
  activePane: PaneIndex,
  mode: "push" | "replace" = "push",
) {
  const parameters = new URLSearchParams(window.location.search);
  if (primaryID) parameters.set("session", primaryID);
  else parameters.delete("session");
  if (splitID) parameters.set("split", splitID);
  else parameters.delete("split");
  const focusID = activePane === 1 ? splitID : primaryID;
  if (focusID) parameters.set("focus", focusID);
  else parameters.delete("focus");
  const query = parameters.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url);
}

export function App({
  initialToken,
  renderTerminal = (session, api) => <TerminalView key={session.id} session={session} api={api} />,
}: AppProps) {
  const [token, setToken] = useState(() => resolveInitialToken(initialToken));
  const [draftToken, setDraftToken] = useState("");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [paneIDs, setPaneIDs] = useState<PaneIDs>([null, null]);
  const [activePane, setActivePane] = useState<PaneIndex>(0);
  const [authError, setAuthError] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const api = useMemo(() => (token ? new ApiClient(token) : null), [token]);

  useEffect(() => {
    if (!api) {
      setSessions(null);
      return;
    }
    let active = true;
    api
      .listSessions()
      .then((items) => {
        if (!active) return;
        setSessions(items);
        const workspace = workspaceFromURL(items);
        setPaneIDs(workspace.paneIDs);
        setActivePane(workspace.activePane);
        writeWorkspaceToURL(workspace.paneIDs, workspace.activePane, "replace");
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
    if (!sessions) return;
    const restore = () => {
      const workspace = workspaceFromURL(sessions);
      setPaneIDs(workspace.paneIDs);
      setActivePane(workspace.activePane);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [sessions]);

  function selectSession(id: string) {
    const existingPane = paneIDs[0] === id ? 0 : paneIDs[1] === id ? 1 : null;
    if (existingPane !== null) {
      setActivePane(existingPane);
      writeWorkspaceToURL(paneIDs, existingPane);
      return;
    }
    const nextPanes: PaneIDs = [...paneIDs];
    nextPanes[activePane] = id;
    setPaneIDs(nextPanes);
    writeWorkspaceToURL(nextPanes, activePane);
  }

  function focusPane(index: PaneIndex) {
    setActivePane(index);
    writeWorkspaceToURL(paneIDs, index);
  }

  async function splitVertically() {
    if (!api || paneIDs[1] || splitting) return;
    setSplitting(true);
    try {
      const created = await api.createSession("Terminal");
      setSessions((current) => [...(current ?? []), created]);
      const nextPanes: PaneIDs = [paneIDs[0], created.id];
      setPaneIDs(nextPanes);
      setActivePane(1);
      writeWorkspaceToURL(nextPanes, 1);
      setRequestError("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The split terminal could not start.");
    } finally {
      setSplitting(false);
    }
  }

  function closeSplit() {
    const nextPanes: PaneIDs = [paneIDs[0], null];
    setPaneIDs(nextPanes);
    setActivePane(0);
    writeWorkspaceToURL(nextPanes, 0);
  }

  function authenticate(event: FormEvent) {
    event.preventDefault();
    const value = draftToken.trim();
    if (!value) return;
    setAuthError(false);
    sessionStorage.setItem(tokenKey, value);
    setToken(value);
  }

  async function createSession() {
    if (!api) return;
    try {
      const created = await api.createSession("Terminal");
      setSessions((current) => [...(current ?? []), created]);
      const nextPanes: PaneIDs = [...paneIDs];
      nextPanes[activePane] = created.id;
      setPaneIDs(nextPanes);
      writeWorkspaceToURL(nextPanes, activePane);
      setRequestError("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The terminal could not start.");
    }
  }

  async function deleteSession(item: Session) {
    if (!api) return;
    try {
      await api.deleteSession(item.id);
      const remaining = sessions?.filter((candidate) => candidate.id !== item.id) ?? [];
      setSessions(remaining);
      let nextPanes: PaneIDs = [
        paneIDs[0] === item.id ? null : paneIDs[0],
        paneIDs[1] === item.id ? null : paneIDs[1],
      ];
      if (!nextPanes[0] && nextPanes[1]) nextPanes = [nextPanes[1], null];
      if (!nextPanes[0]) nextPanes = [remaining[0]?.id ?? null, null];
      setPaneIDs(nextPanes);
      const nextActivePane = nextPanes[1] && activePane === 1 ? 1 : 0;
      setActivePane(nextActivePane);
      writeWorkspaceToURL(nextPanes, nextActivePane);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The terminal could not be deleted.");
    }
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

  const panes = paneIDs.map((id) => sessions.find((item) => item.id === id) ?? null) as [
    Session | null,
    Session | null,
  ];
  const selected = panes[activePane] ?? panes[0];

  return (
    <main className="workspace">
      <SessionNavigation
        sessions={sessions}
        selectedID={selected?.id ?? null}
        onSelect={selectSession}
        onCreate={() => void createSession()}
        onDelete={(item) => void deleteSession(item)}
      />
      <section className="terminal-stage" data-split={Boolean(panes[1])}>
        {requestError && <p role="alert">{requestError}</p>}
        {panes[0] && api ? (
          <>
            <div
              className="terminal-pane"
              data-active={activePane === 0}
              aria-label={`${panes[0].name} pane`}
              onMouseDown={() => focusPane(0)}
            >
              {renderTerminal(panes[0], api)}
            </div>
            {panes[1] && (
              <div
                className="terminal-pane"
                data-active={activePane === 1}
                aria-label={`${panes[1].name} pane`}
                onMouseDown={() => focusPane(1)}
              >
                {renderTerminal(panes[1], api)}
              </div>
            )}
            <div className="pane-controls">
              {panes[1] ? (
                <button aria-label="Close split" title="Close split" onClick={closeSplit}>
                  ×
                </button>
              ) : (
                <button
                  aria-label="Split vertically"
                  title="Split vertically"
                  disabled={splitting}
                  onClick={() => void splitVertically()}
                >
                  ◫
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <p>No signal yet.</p>
            <button onClick={() => void createSession()}>Start a terminal</button>
          </div>
        )}
      </section>
    </main>
  );
}
