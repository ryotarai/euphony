import { FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { ApiClient, ApiError } from "./api";
import { SessionNavigation } from "./components/SessionNavigation";
import { TerminalView } from "./components/TerminalView";
import type { Session } from "./types";

const tokenKey = "euphony.token";

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

export function App({
  initialToken,
  renderTerminal = (session, api) => <TerminalView key={session.id} session={session} api={api} />,
}: AppProps) {
  const [token, setToken] = useState(() => resolveInitialToken(initialToken));
  const [draftToken, setDraftToken] = useState("");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [authError, setAuthError] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("Terminal");
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
        setSelectedID((current) => current ?? items[0]?.id ?? null);
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

  function authenticate(event: FormEvent) {
    event.preventDefault();
    const value = draftToken.trim();
    if (!value) return;
    setAuthError(false);
    sessionStorage.setItem(tokenKey, value);
    setToken(value);
  }

  async function createSession(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    try {
      const created = await api.createSession(name.trim());
      setSessions((current) => [...(current ?? []), created]);
      setSelectedID(created.id);
      setShowCreate(false);
      setRequestError("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The terminal could not start.");
    }
  }

  async function deleteSession(item: Session) {
    if (!api) return;
    try {
      await api.deleteSession(item.id);
      setSessions((current) => current?.filter((candidate) => candidate.id !== item.id) ?? []);
      setSelectedID((current) => (current === item.id ? null : current));
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

  const selected = sessions.find((item) => item.id === selectedID) ?? sessions[0] ?? null;

  return (
    <main className="workspace">
      <SessionNavigation
        sessions={sessions}
        selectedID={selected?.id ?? null}
        onSelect={setSelectedID}
        onCreate={() => setShowCreate(true)}
        onDelete={(item) => void deleteSession(item)}
      />
      <section className="terminal-stage">
        {requestError && <p role="alert">{requestError}</p>}
        {selected && api ? (
          renderTerminal(selected, api)
        ) : (
          <div className="empty-state">
            <p>No signal yet.</p>
            <button onClick={() => setShowCreate(true)}>Start a terminal</button>
          </div>
        )}
      </section>
      {showCreate && (
        <div className="dialog-backdrop">
          <form className="create-dialog" onSubmit={createSession}>
            <h2>Start a terminal</h2>
            <label htmlFor="session-name">Terminal name</label>
            <input
              id="session-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <div>
              <button type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button type="submit">Start terminal</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
