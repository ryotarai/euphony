import {
  FormEvent,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiClient, ApiError } from "./api";
import { SessionNavigation } from "./components/SessionNavigation";
import { AgentsView } from "./components/AgentsView";
import { TasksView } from "./components/TasksView";
import {
  agentLaunchTransitions,
  attentionTransitions,
  cwdFilterKey,
  replacementSession,
  sessionsEqual,
} from "./sessionUtils";
import {
  isEditableTarget,
  matchesPrefix,
  normalizePrefix,
  shortcutsEqual,
} from "./keybindings";
import { TerminalView, type ConnectionState } from "./components/TerminalView";
import { TerminalPane } from "./components/TerminalPane";
import { PaneCarousel, type PaneCarouselItem } from "./components/PaneCarousel";
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
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import type {
  CwdSelectionFilter,
  AgentSummary,
  ReplaceSelectionRequest,
  SelectionSnapshot,
  Session,
  Settings,
  Task,
  TaskCreateInput,
  TaskRefinement,
  TaskStartInput,
  TaskUpdateInput,
  TerminalCursorStyle,
} from "./types";
import {
  defaultTerminalCursorBlink,
  defaultTerminalCursorStyle,
  defaultTerminalFontFamily,
  defaultTerminalLineHeight,
  defaultTerminalOptionAsAlt,
  defaultTerminalScrollSensitivity,
} from "./settings";

const tokenKey = "euphony.token";
const recentQuickActionsKey = "euphony.recentQuickActions:v1";
const legacyRecentQuickActionsKey = "euphony.recentQuickActions";
const recentQuickActionsLimit = 5;
const quickActionStatuses = [
  "blocked",
  "running",
  "waiting",
  "terminal",
] as const;
const bytesPerMiB = 1024 * 1024;
const maxHistoryMiB = 4095;
const filterDeselectDelayMs = 10_000;
const maxCachedTerminalViews = 4;
const tasksPaneID = "tasks" as const;
const agentsPaneID = "agents" as const;

type DashboardPaneID = typeof tasksPaneID | typeof agentsPaneID;

function agentSummaryMatchesSnapshot(summary: AgentSummary, snapshot: AgentSummary) {
  return summary.terminalId === snapshot.terminalId
    && summary.provider === snapshot.provider
    && summary.status === snapshot.status
    && summary.summary === snapshot.summary
    && summary.action === snapshot.action
    && summary.generatedAt === snapshot.generatedAt
    && summary.unread === snapshot.unread
    && summary.error === snapshot.error;
}

function isDashboardPaneID(id: string | null): id is DashboardPaneID {
  return id === tasksPaneID || id === agentsPaneID;
}

interface AppProps {
  initialToken?: string;
  initialSettings?: Settings;
  syncSelection?: boolean;
  syncEvents?: boolean;
  renderTerminal?: (
    session: Session,
    api: ApiClient,
    active: boolean,
    layoutVersion: number,
    onConnectionChange: (sessionID: string, state: ConnectionState) => void,
    reconnectSignal: number,
    fontFamily: string,
    fontSize: number,
    terminalHistoryLimit: number,
    sourceVisible: boolean,
    lineHeight: number,
    cursorStyle: TerminalCursorStyle,
    cursorBlink: boolean,
    scrollSensitivity: number,
    optionAsAlt: boolean,
  ) => ReactNode;
}

const defaultSettings: Settings = {
  prefix: "Ctrl+B",
  paneTabShortcut: "Meta+L",
  sidebarWidth: 256,
  sidebarCollapsed: false,
  interfaceFontSize: 16,
  terminalFontSize: 14,
  terminalFontFamily: defaultTerminalFontFamily,
  agentLogFontSize: 14,
  terminalHistoryLimit: bytesPerMiB,
  terminalLineHeight: defaultTerminalLineHeight,
  terminalCursorStyle: defaultTerminalCursorStyle,
  terminalCursorBlink: defaultTerminalCursorBlink,
  terminalScrollSensitivity: defaultTerminalScrollSensitivity,
  terminalOptionAsAlt: defaultTerminalOptionAsAlt,
  agentSummaryProvider: "codex",
};

function historyLimitDraft(limit: number): string {
  return String(limit === 0 ? 1 : limit / bytesPerMiB);
}

function resolveRecentQuickActionValues(): string[] {
  try {
    const stored = JSON.parse(
      localStorage.getItem(recentQuickActionsKey) ??
        localStorage.getItem(legacyRecentQuickActionsKey) ??
        "[]",
    );
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter((value): value is string => typeof value === "string"))]
      .slice(0, recentQuickActionsLimit);
  } catch {
    return [];
  }
}

type FontSizeSetting = "interfaceFontSize" | "terminalFontSize" | "agentLogFontSize";

function parseFontSize(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 10 && parsed <= 24 ? parsed : null;
}

function parseTerminalFontFamily(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && Array.from(trimmed).length <= 256 ? trimmed : null;
}

function parseTerminalLineHeight(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 2) return null;
  const nearestStep = Math.round(parsed * 20) / 20;
  return Math.abs(parsed - nearestStep) < 1e-9 ? parsed : null;
}

function parseTerminalCursorStyle(value: string): TerminalCursorStyle | null {
  return value === "bar" || value === "block" || value === "underline"
    ? value
    : null;
}

function parseTerminalScrollSensitivity(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : null;
}

function sessionActivity(session: Session) {
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

function availableQuickActionValues(
  sessions: Session[],
  selectedIDs: string[] = [],
): Set<string> {
  const availableSessionIDs = new Set(sessions.map((session) => session.id));
  return new Set([
    "new-terminal",
    "attention-alerts",
    ...(selectedIDs.some((id) => availableSessionIDs.has(id))
      ? ["delete-selected-terminals"]
      : []),
    ...sessions.map((session) => `session:${session.id}`),
    ...quickActionStatuses
      .filter((status) =>
        sessions.some((session) => sessionActivity(session) === status),
      )
      .map((status) => `status:${status}`),
  ]);
}

function activityLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function matchesWorkspaceFilter(
  session: Session,
  statusFilters: string[],
  cwdFilters: string[],
) {
  const statuses = [sessionActivity(session)];
  if (session.needsAttention) {
    statuses.push("attention");
  }
  return statuses.some(
    (status) =>
      statusFilters.includes(status) ||
      cwdFilters.includes(cwdFilterKey(status, session.cwd)),
  );
}

function cwdFilterBelongsToStatus(filter: string, status: string) {
  return filter.startsWith(`${status}\u0000`);
}

function parseCwdFilter(filter: string): CwdSelectionFilter | null {
  const separator = filter.indexOf("\u0000");
  if (separator < 1 || separator === filter.length - 1) return null;
  return {
    status: filter.slice(0, separator),
    cwd: filter.slice(separator + 1),
  };
}

function selectionSourceSignature(
  manualTerminalIds: string[],
  pinnedTerminalIds: string[],
  focusedTerminalId: string | null | undefined,
  statuses: string[],
  cwds: CwdSelectionFilter[],
  pinnedStatuses: string[] = [],
  pinnedCwds: CwdSelectionFilter[] = [],
) {
  return JSON.stringify({
    manualTerminalIds,
    pinnedTerminalIds,
    focusedTerminalId: focusedTerminalId ?? "",
    statuses,
    cwds,
    pinnedStatuses,
    pinnedCwds,
  });
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

async function enableAttentionAlerts() {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  playAttentionTone();
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
  pinnedIDs: string[];
  focusedID: string | null;
  statusFilters: string[];
  cwdFilters: string[];
  pinnedStatusFilters: string[];
  pinnedCwdFilters: string[];
} {
  const parameters = new URLSearchParams(window.location.search);
  const available = new Set(sessions.map((session) => session.id));
  let selectedIDs = parameters.getAll("terminal").filter((id) => available.has(id));
  const pinnedIDs = [
    ...new Set(parameters.getAll("pin").filter((id) => available.has(id))),
  ];
  if (selectedIDs.length === 0) {
    selectedIDs = [parameters.get("session"), parameters.get("split")]
      .filter((id): id is string => Boolean(id && available.has(id)));
  }
  selectedIDs = [
    ...new Set([...selectedIDs, ...pinnedIDs]),
  ];
  if (selectedIDs.length === 0 && sessions[0]) selectedIDs = [sessions[0].id];
  const focus = parameters.get("focus");
  const pinnedStatusFilters = [...new Set(parameters.getAll("pin-status"))];
  const pinnedCwdFilters = [...new Set(parameters.getAll("pin-cwd"))];
  return {
    selectedIDs,
    pinnedIDs,
    focusedID: focus && selectedIDs.includes(focus) ? focus : selectedIDs[0] ?? null,
    statusFilters: [
      ...new Set([...parameters.getAll("status"), ...pinnedStatusFilters]),
    ],
    cwdFilters: [
      ...new Set([...parameters.getAll("cwd"), ...pinnedCwdFilters]),
    ],
    pinnedStatusFilters,
    pinnedCwdFilters,
  };
}

function writeWorkspaceURL(
  selectedIDs: string[],
  pinnedIDs: string[],
  focusedID: string | null,
  statusFilters: string[],
  cwdFilters: string[],
  mode: "push" | "replace" = "push",
  pinnedStatusFilters: string[] = [],
  pinnedCwdFilters: string[] = [],
) {
  const parameters = new URLSearchParams(window.location.search);
  parameters.delete("session");
  parameters.delete("split");
  parameters.delete("terminal");
  parameters.delete("pin");
  parameters.delete("status");
  parameters.delete("cwd");
  parameters.delete("pin-status");
  parameters.delete("pin-cwd");
  selectedIDs.forEach((id) => parameters.append("terminal", id));
  pinnedIDs.forEach((id) => parameters.append("pin", id));
  statusFilters.forEach((status) => parameters.append("status", status));
  cwdFilters.forEach((filter) => parameters.append("cwd", filter));
  pinnedStatusFilters.forEach((status) => parameters.append("pin-status", status));
  pinnedCwdFilters.forEach((filter) => parameters.append("pin-cwd", filter));
  if (focusedID) parameters.set("focus", focusedID);
  else parameters.delete("focus");
  const query = parameters.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url);
}

export function App({
  initialToken,
  initialSettings,
  syncSelection = true,
  syncEvents = true,
  renderTerminal = (
    session,
    api,
    active,
    layoutVersion,
    onConnectionChange,
    reconnectSignal,
    fontFamily,
    fontSize,
    terminalHistoryLimit,
    sourceVisible,
    lineHeight,
    cursorStyle,
    cursorBlink,
    scrollSensitivity,
    optionAsAlt,
  ) => (
    <TerminalView
      key={session.id}
      session={session}
      api={api}
      active={active}
      sourceVisible={sourceVisible}
      layoutVersion={layoutVersion}
      onConnectionChange={onConnectionChange}
      reconnectSignal={reconnectSignal}
      fontFamily={fontFamily}
      fontSize={fontSize}
      terminalHistoryLimit={terminalHistoryLimit}
      lineHeight={lineHeight}
      cursorStyle={cursorStyle}
      cursorBlink={cursorBlink}
      scrollSensitivity={scrollSensitivity}
      optionAsAlt={optionAsAlt}
    />
  ),
}: AppProps) {
  const [token, setToken] = useState(() => resolveInitialToken(initialToken));
  const [draftToken, setDraftToken] = useState("");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [annotationRevision, setAnnotationRevision] = useState(0);
  const [selectedIDs, setSelectedIDs] = useState<string[]>([]);
  const [pinnedIDs, setPinnedIDs] = useState<string[]>([]);
  const [focusedID, setFocusedID] = useState<string | null>(null);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [cwdFilters, setCwdFilters] = useState<string[]>([]);
  const [pinnedStatusFilters, setPinnedStatusFilters] = useState<string[]>([]);
  const [pinnedCwdFilters, setPinnedCwdFilters] = useState<string[]>([]);
  const [authError, setAuthError] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [settings, setSettings] = useState(initialSettings ?? defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedDashboardIDs, setSelectedDashboardIDs] = useState<DashboardPaneID[]>([]);
  const [focusedPaneID, setFocusedPaneID] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState("");
  const [selectedTaskID, setSelectedTaskID] = useState<string | null>(null);
  const [taskRefinement, setTaskRefinement] = useState<TaskRefinement | null>(null);
  const [taskRefining, setTaskRefining] = useState(false);
  const [agentSummaries, setAgentSummaries] = useState<AgentSummary[]>([]);
  const [agentSummariesLoading, setAgentSummariesLoading] = useState(false);
  const [agentSummariesError, setAgentSummariesError] = useState("");
  const agentSummariesLoadedForApiRef = useRef<ApiClient | null>(null);
  const [prefixDraft, setPrefixDraft] = useState(settings.prefix);
  const [paneTabShortcutDraft, setPaneTabShortcutDraft] = useState(
    settings.paneTabShortcut,
  );
  const [terminalHistoryLimitDraft, setTerminalHistoryLimitDraft] = useState(
    () => historyLimitDraft(settings.terminalHistoryLimit),
  );
  const [unlimitedTerminalHistory, setUnlimitedTerminalHistory] = useState(
    settings.terminalHistoryLimit === 0,
  );
  const [terminalFontFamilyDraft, setTerminalFontFamilyDraft] = useState(
    settings.terminalFontFamily,
  );
  const [terminalLineHeightDraft, setTerminalLineHeightDraft] = useState(
    String(settings.terminalLineHeight),
  );
  const [terminalCursorStyleDraft, setTerminalCursorStyleDraft] = useState<string>(
    settings.terminalCursorStyle,
  );
  const [terminalCursorBlinkDraft, setTerminalCursorBlinkDraft] = useState(
    settings.terminalCursorBlink,
  );
  const [terminalScrollSensitivityDraft, setTerminalScrollSensitivityDraft] = useState(
    String(settings.terminalScrollSensitivity),
  );
  const [terminalOptionAsAltDraft, setTerminalOptionAsAltDraft] = useState(
    settings.terminalOptionAsAlt,
  );
  const [agentSummaryProviderDraft, setAgentSummaryProviderDraft] = useState(
    settings.agentSummaryProvider,
  );
  const [fontSizeDrafts, setFontSizeDrafts] = useState<Record<FontSizeSetting, string>>({
    interfaceFontSize: String(settings.interfaceFontSize),
    terminalFontSize: String(settings.terminalFontSize),
    agentLogFontSize: String(settings.agentLogFontSize),
  });
  const [settingsError, setSettingsError] = useState<{
    field:
      | "prefix"
      | "paneTabShortcut"
      | "terminalHistoryLimit"
      | "terminalFontFamily"
      | "terminalLineHeight"
      | "terminalCursorStyle"
      | "terminalScrollSensitivity"
      | FontSizeSetting;
    message: string;
  } | null>(null);
  const [prefixActive, setPrefixActive] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandValue, setCommandValue] = useState("new-terminal");
  const [recentQuickActionValues, setRecentQuickActionValues] = useState(
    resolveRecentQuickActionValues,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [cwdDraft, setCWDDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Session[] | null>(null);
  const [connectionStates, setConnectionStates] = useState<Record<string, ConnectionState>>({});
  const [reconnectSignals, setReconnectSignals] = useState<Record<string, number>>({});
  const tasksOpen = selectedDashboardIDs.includes(tasksPaneID);
  const agentsOpen = selectedDashboardIDs.includes(agentsPaneID);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const scrollCommandSelectionRef = useRef(false);
  const prefixActiveRef = useRef(false);
  const filterSelectedIDsRef = useRef<Set<string>>(null!);
  const manualSelectedIDsRef = useRef<Set<string>>(null!);
  const decomposedStatusFiltersRef = useRef<Set<string>>(null!);
  const decomposedPinnedStatusFiltersRef = useRef<Set<string>>(null!);
  const previousSessionsRef = useRef<Session[]>([]);
  const previousSessionOrderRef = useRef<Session[]>([]);
  const openedTerminalIDs = useMemo(() => new Set<string>(), []);
  const pendingAgentLaunchIDsRef = useRef<Set<string>>(null!);
  const filterDeselectTimersRef = useRef<Map<string, number>>(null!);
  const expiredFilterDeselectIDsRef = useRef<Set<string>>(null!);
  const [filterDeselectExpiryVersion, setFilterDeselectExpiryVersion] = useState(0);
  const pendingAttentionAcknowledgementsRef = useRef<Set<string>>(null!);
  const selectionRevisionRef = useRef<number | null>(null);
  const selectionServerSignatureRef = useRef("");
  const selectionSyncReadyRef = useRef(false);
  const selectionPendingRequestRef = useRef<{
    request: ReplaceSelectionRequest;
    localVersion: number;
  } | null>(null);
  const selectionWriteActiveRef = useRef(false);
  const selectionActiveWriteVersionRef = useRef<number | null>(null);
  const selectionLocalVersionRef = useRef(0);
  const selectionSyncedLocalVersionRef = useRef(0);
  useLayoutEffect(() => {
    filterSelectedIDsRef.current ??= new Set();
    manualSelectedIDsRef.current ??= new Set();
    decomposedStatusFiltersRef.current ??= new Set();
    decomposedPinnedStatusFiltersRef.current ??= new Set();
    pendingAgentLaunchIDsRef.current ??= new Set();
    filterDeselectTimersRef.current ??= new Map();
    expiredFilterDeselectIDsRef.current ??= new Set();
    pendingAttentionAcknowledgementsRef.current ??= new Set();
  }, []);

  const currentSelectionStateRef = useRef({
    selectedIDs,
    pinnedIDs,
    statusFilters,
    cwdFilters,
  });
  useLayoutEffect(() => {
    currentSelectionStateRef.current = {
      selectedIDs,
      pinnedIDs,
      statusFilters,
      cwdFilters,
    };
  }, [cwdFilters, pinnedIDs, selectedIDs, statusFilters]);
  const api = useMemo(() => (token ? new ApiClient(token) : null), [token]);
  const loadAgentSummaries = useCallback(async () => {
    if (!api) return;
    setAgentSummariesLoading(true);
    try {
      const nextSummaries = await api.listAgentSummaries();
      setAgentSummaries(nextSummaries);
      setAgentSummariesError("");
    } catch (error) {
      setAgentSummariesError(
        error instanceof Error
          ? error.message
          : "Agent summaries could not be loaded.",
      );
    } finally {
      setAgentSummariesLoading(false);
    }
  }, [api]);
  const loadTasks = useCallback(async () => {
    if (!api) return;
    setTasksLoading(true);
    setTasksError("");
    try {
      const nextTasks = await api.listTasks();
      setTasks(nextTasks);
      setSelectedTaskID((current) =>
        current && nextTasks.some((task) => task.id === current)
          ? current
          : nextTasks[0]?.id ?? null,
      );
    } catch (error) {
      setTasksError(
        error instanceof Error ? error.message : "Tasks could not be loaded.",
      );
    } finally {
      setTasksLoading(false);
    }
  }, [api]);
  const replaceTask = useCallback((next: Task) => {
    setTasks((current) => [
      ...current.filter((task) => task.id !== next.id),
      next,
    ]);
  }, []);
  const cancelFilterDeselect = useCallback((id: string) => {
    const timer = filterDeselectTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      filterDeselectTimersRef.current.delete(id);
    }
  }, []);
  const scheduleFilterDeselect = useCallback((id: string) => {
    if (filterDeselectTimersRef.current.has(id)) return;
    const timer = window.setTimeout(() => {
      filterDeselectTimersRef.current.delete(id);
      expiredFilterDeselectIDsRef.current.add(id);
      setFilterDeselectExpiryVersion((current) => current + 1);
    }, filterDeselectDelayMs);
    filterDeselectTimersRef.current.set(id, timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of filterDeselectTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      filterDeselectTimersRef.current.clear();
    };
  }, []);

  const writeWorkspaceToURL = useCallback(
    (
      nextSelectedIDs: string[],
      nextPinnedIDs: string[],
      nextFocusedID: string | null,
      nextStatusFilters: string[],
      nextCwdFilters: string[],
      mode: "push" | "replace" = "push",
      nextPinnedStatusFilters: string[] = pinnedStatusFilters,
      nextPinnedCwdFilters: string[] = pinnedCwdFilters,
    ) => {
      writeWorkspaceURL(
        nextSelectedIDs,
        nextPinnedIDs,
        nextFocusedID,
        nextStatusFilters,
        nextCwdFilters,
        mode,
        nextPinnedStatusFilters,
        nextPinnedCwdFilters,
      );
    },
    [pinnedCwdFilters, pinnedStatusFilters],
  );
  const previewSettings = useMemo(() => {
    if (!settingsOpen) return settings;
    return {
      ...settings,
      interfaceFontSize:
        parseFontSize(fontSizeDrafts.interfaceFontSize) ?? settings.interfaceFontSize,
      terminalFontSize:
        parseFontSize(fontSizeDrafts.terminalFontSize) ?? settings.terminalFontSize,
      terminalFontFamily:
        parseTerminalFontFamily(terminalFontFamilyDraft) ??
        settings.terminalFontFamily,
      agentLogFontSize:
        parseFontSize(fontSizeDrafts.agentLogFontSize) ?? settings.agentLogFontSize,
      terminalLineHeight:
        parseTerminalLineHeight(terminalLineHeightDraft) ?? settings.terminalLineHeight,
      terminalCursorStyle:
        parseTerminalCursorStyle(terminalCursorStyleDraft) ?? settings.terminalCursorStyle,
      terminalCursorBlink: terminalCursorBlinkDraft,
      terminalScrollSensitivity:
        parseTerminalScrollSensitivity(terminalScrollSensitivityDraft) ??
        settings.terminalScrollSensitivity,
      terminalOptionAsAlt: terminalOptionAsAltDraft,
    };
  }, [
    fontSizeDrafts,
    settings,
    settingsOpen,
    terminalCursorBlinkDraft,
    terminalCursorStyleDraft,
    terminalFontFamilyDraft,
    terminalLineHeightDraft,
    terminalOptionAsAltDraft,
    terminalScrollSensitivityDraft,
  ]);
  const handleConnectionChange = useCallback((sessionID: string, state: ConnectionState) => {
    setConnectionStates((current) =>
      current[sessionID] === state ? current : { ...current, [sessionID]: state },
    );
  }, []);
  const applySessionSnapshot = useCallback((items: Session[]) => {
    const previous = previousSessionsRef.current;
    const previousByID = new Map(previous.map((session) => [session.id, session]));
    const currentSelection = currentSelectionStateRef.current;
    const selectedIDSet = new Set(currentSelection.selectedIDs);
    const pinnedIDSet = new Set(currentSelection.pinnedIDs);
    for (const session of items) {
      const previousSession = previousByID.get(session.id);
      if (!previousSession) continue;
      const wasMatch = matchesWorkspaceFilter(
        previousSession,
        currentSelection.statusFilters,
        currentSelection.cwdFilters,
      );
      const isMatch = matchesWorkspaceFilter(
        session,
        currentSelection.statusFilters,
        currentSelection.cwdFilters,
      );
      if (isMatch) {
        cancelFilterDeselect(session.id);
        expiredFilterDeselectIDsRef.current.delete(session.id);
        continue;
      }
      if (
        wasMatch &&
        filterSelectedIDsRef.current.has(session.id) &&
        selectedIDSet.has(session.id) &&
        !pinnedIDSet.has(session.id)
      ) {
        scheduleFilterDeselect(session.id);
      }
    }
    const transitions = attentionTransitions(previous, items);
    pendingAgentLaunchIDsRef.current = new Set(
      agentLaunchTransitions(previous, items).map((session) => session.id),
    );
    previousSessionOrderRef.current = previous;
    previousSessionsRef.current = items;
    setSessions((current) =>
      current && sessionsEqual(current, items) ? current : items,
    );
    for (const session of transitions) {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        new Notification("Euphony needs attention", {
          body: session.agentTitle || session.cwd,
          tag: `euphony-${session.id}`,
        });
      }
      playAttentionTone();
    }
  }, [cancelFilterDeselect, scheduleFilterDeselect]);

  function applyServerSelection(
    snapshot: SelectionSnapshot,
    mode: "push" | "replace" = "replace",
  ) {
    const currentSelection = currentSelectionStateRef.current;
    const snapshotCwdFilters = snapshot.filters.cwds.map((filter) =>
      cwdFilterKey(filter.status, filter.cwd)
    );
    const selectedIDSet = new Set(currentSelection.selectedIDs);
    const pinnedIDSet = new Set(currentSelection.pinnedIDs);
    const snapshotTerminalIDSet = new Set(snapshot.terminalIds);
    const sameFilterSource =
      currentSelection.statusFilters.join("\0") ===
        snapshot.filters.statuses.join("\0") &&
      currentSelection.cwdFilters.join("\0") === snapshotCwdFilters.join("\0");
    if (
      sameFilterSource &&
      (currentSelection.statusFilters.length > 0 || currentSelection.cwdFilters.length > 0)
    ) {
      for (const id of filterSelectedIDsRef.current) {
        if (
          selectedIDSet.has(id) &&
          !pinnedIDSet.has(id) &&
          !snapshotTerminalIDSet.has(id) &&
          !expiredFilterDeselectIDsRef.current.has(id)
        ) {
          scheduleFilterDeselect(id);
        }
      }
    }
    const pendingFilterDeselectIDs = new Set(filterDeselectTimersRef.current.keys());
    const preservedFilterDeselectIDs = [...pendingFilterDeselectIDs].filter(
      (id) =>
        selectedIDSet.has(id) &&
        !pinnedIDSet.has(id) &&
        !snapshotTerminalIDSet.has(id),
    );
    const preservedIDs = [
      ...new Set(preservedFilterDeselectIDs),
    ];
    const effectiveSnapshot = preservedIDs.length === 0
      ? snapshot
      : {
        ...snapshot,
        terminalIds: [...new Set([...snapshot.terminalIds, ...preservedIDs])],
        ...(focusedID && preservedIDs.includes(focusedID)
          ? { focusedTerminalId: focusedID }
          : {}),
      };
    const nextStatusFilters = snapshot.filters.statuses;
    const nextCwdFilters = snapshotCwdFilters;
    const nextPinnedStatusFilters = snapshot.pinnedFilters?.statuses ?? [];
    const nextPinnedCwdFilters = (snapshot.pinnedFilters?.cwds ?? []).map(
      (filter) => cwdFilterKey(filter.status, filter.cwd),
    );
    const effectiveManualIDSet = new Set(effectiveSnapshot.manualTerminalIds);
    const effectivePinnedIDSet = new Set(effectiveSnapshot.pinnedTerminalIds);
    filterSelectedIDsRef.current = new Set(
      effectiveSnapshot.terminalIds.filter(
        (id) =>
          !effectiveManualIDSet.has(id) && !effectivePinnedIDSet.has(id),
      ),
    );
    manualSelectedIDsRef.current = new Set(effectiveSnapshot.manualTerminalIds);
    decomposedStatusFiltersRef.current = new Set(
      snapshot.filters.cwds
        .map((filter) => filter.status)
        .filter((status) => !nextStatusFilters.includes(status)),
    );
    decomposedPinnedStatusFiltersRef.current = new Set(
      (snapshot.pinnedFilters?.cwds ?? [])
        .map((filter) => filter.status)
        .filter((status) => !nextPinnedStatusFilters.includes(status)),
    );
    selectionRevisionRef.current = snapshot.revision;
    selectionServerSignatureRef.current = selectionSourceSignature(
      snapshot.manualTerminalIds,
      snapshot.pinnedTerminalIds,
      snapshot.focusedTerminalId,
      snapshot.filters.statuses,
      snapshot.filters.cwds,
      nextPinnedStatusFilters,
      snapshot.pinnedFilters?.cwds ?? [],
    );
    setSelectedIDs(effectiveSnapshot.terminalIds);
    setPinnedIDs(effectiveSnapshot.pinnedTerminalIds);
    setFocusedID(effectiveSnapshot.focusedTerminalId ?? null);
    setStatusFilters(nextStatusFilters);
    setCwdFilters(nextCwdFilters);
    setPinnedStatusFilters(nextPinnedStatusFilters);
    setPinnedCwdFilters(nextPinnedCwdFilters);
    writeWorkspaceToURL(
      effectiveSnapshot.terminalIds,
      effectiveSnapshot.pinnedTerminalIds,
      effectiveSnapshot.focusedTerminalId ?? null,
      nextStatusFilters,
      nextCwdFilters,
      mode,
      nextPinnedStatusFilters,
      nextPinnedCwdFilters,
    );
  }

  function recordServerSelection(snapshot: SelectionSnapshot) {
    selectionRevisionRef.current = snapshot.revision;
    selectionServerSignatureRef.current = selectionSourceSignature(
      snapshot.manualTerminalIds,
      snapshot.pinnedTerminalIds,
      snapshot.focusedTerminalId,
      snapshot.filters.statuses,
      snapshot.filters.cwds,
      snapshot.pinnedFilters?.statuses ?? [],
      snapshot.pinnedFilters?.cwds ?? [],
    );
  }

  function acceptServerSelection(snapshot: SelectionSnapshot) {
    if (
      selectionRevisionRef.current !== null &&
      snapshot.revision <= selectionRevisionRef.current
    ) {
      return;
    }
    const hasUnsyncedLocalSelection =
      selectionLocalVersionRef.current >
        selectionSyncedLocalVersionRef.current ||
      selectionPendingRequestRef.current !== null ||
      selectionActiveWriteVersionRef.current !== null;
    if (hasUnsyncedLocalSelection) {
      recordServerSelection(snapshot);
      return;
    }
    applyServerSelection(snapshot);
  }

  const markLocalSelectionMutation = useCallback(() => {
    if (syncSelection) {
      selectionLocalVersionRef.current += 1;
    }
  }, [syncSelection]);

  async function flushSelectionWrites() {
    if (!api || selectionWriteActiveRef.current) return;
    selectionWriteActiveRef.current = true;
    try {
      while (selectionPendingRequestRef.current) {
        const pending = selectionPendingRequestRef.current;
        selectionPendingRequestRef.current = null;
        selectionActiveWriteVersionRef.current = pending.localVersion;
        try {
          const snapshot = await api.replaceSelection({
            ...pending.request,
            ...(selectionRevisionRef.current === null
              ? {}
              : { expectedRevision: selectionRevisionRef.current }),
          });
          if (
            selectionPendingRequestRef.current ||
            selectionLocalVersionRef.current > pending.localVersion
          ) {
            recordServerSelection(snapshot);
          } else {
            selectionSyncedLocalVersionRef.current = pending.localVersion;
            applyServerSelection(snapshot);
          }
        } catch (error) {
          if (error instanceof ApiError && error.code === "selection_conflict") {
            try {
              const snapshot = await api.getSelection();
              recordServerSelection(snapshot);
              if (!selectionPendingRequestRef.current) {
                selectionPendingRequestRef.current = pending;
              }
              continue;
            } catch {
              setRequestError("The shared selection could not be refreshed.");
              break;
            }
          }
          setRequestError(
            error instanceof Error
              ? error.message
              : "The shared selection could not be updated.",
          );
          break;
        } finally {
          selectionActiveWriteVersionRef.current = null;
        }
      }
    } finally {
      selectionWriteActiveRef.current = false;
      if (selectionPendingRequestRef.current) {
        void flushSelectionWrites();
      }
    }
  }

  useEffect(() => {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = `${previewSettings.interfaceFontSize}px`;
    return () => {
      document.documentElement.style.fontSize = previous;
    };
  }, [previewSettings.interfaceFontSize]);

  useEffect(() => {
    if (!api || initialSettings) return;
    let active = true;
    api.getSettings().then((loaded) => {
      if (!active) return;
      setSettings(loaded);
      setPrefixDraft(loaded.prefix);
      setPaneTabShortcutDraft(loaded.paneTabShortcut);
      setTerminalHistoryLimitDraft(historyLimitDraft(loaded.terminalHistoryLimit));
      setUnlimitedTerminalHistory(loaded.terminalHistoryLimit === 0);
      setTerminalFontFamilyDraft(loaded.terminalFontFamily);
      setTerminalLineHeightDraft(String(loaded.terminalLineHeight));
      setTerminalCursorStyleDraft(loaded.terminalCursorStyle);
      setTerminalCursorBlinkDraft(loaded.terminalCursorBlink);
      setTerminalScrollSensitivityDraft(String(loaded.terminalScrollSensitivity));
      setTerminalOptionAsAltDraft(loaded.terminalOptionAsAlt);
      setAgentSummaryProviderDraft(loaded.agentSummaryProvider);
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
    if (!api || !sessions || agentSummariesLoadedForApiRef.current === api) return;
    agentSummariesLoadedForApiRef.current = api;
    void loadAgentSummaries();
  }, [api, loadAgentSummaries, sessions]);

  useEffect(() => {
    if (!tasksOpen || !api) return;
    void loadTasks();
  }, [tasksOpen, api, loadTasks]);

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
          if (syncSelection) {
            const created = await api.createTerminal("Terminal", undefined, "replace");
            if (!active) return;
            items = [created.terminal];
            applyServerSelection(created.selection);
            selectionSyncReadyRef.current = true;
          } else {
            const created = await api.createSession("Terminal");
            if (!active) return;
            items = [created];
          }
        }
        if (syncSelection && !selectionSyncReadyRef.current) {
          let selection = await api.getSelection();
          if (!active) return;
          if (selection.terminalIds.length === 0 && items[0]) {
            selection = await api.replaceSelection({
              manualTerminalIds: [items[0].id],
              pinnedTerminalIds: [],
              focusedTerminalId: items[0].id,
              filters: { statuses: [], cwds: [] },
              pinnedFilters: { statuses: [], cwds: [] },
              expectedRevision: selection.revision,
            });
          }
          if (!active) return;
          applyServerSelection(selection);
          selectionSyncReadyRef.current = true;
        }
        setSessions(items);
        previousSessionOrderRef.current = items;
        previousSessionsRef.current = items;
        if (syncSelection) return;
        const workspace = workspaceFromURL(items);
        setSelectedIDs(workspace.selectedIDs);
        setPinnedIDs(workspace.pinnedIDs);
        setFocusedID(workspace.focusedID);
        setStatusFilters(workspace.statusFilters);
        setCwdFilters(workspace.cwdFilters);
        setPinnedStatusFilters(workspace.pinnedStatusFilters);
        setPinnedCwdFilters(workspace.pinnedCwdFilters);
        decomposedPinnedStatusFiltersRef.current = new Set(
          workspace.pinnedCwdFilters
            .map(parseCwdFilter)
            .filter((filter): filter is CwdSelectionFilter => filter !== null)
            .map((filter) => filter.status)
            .filter((status) =>
              !workspace.pinnedStatusFilters.includes(status)
            ),
        );
        writeWorkspaceToURL(
          workspace.selectedIDs,
          workspace.pinnedIDs,
          workspace.focusedID,
          workspace.statusFilters,
          workspace.cwdFilters,
          "replace",
          workspace.pinnedStatusFilters,
          workspace.pinnedCwdFilters,
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
  }, [api, syncSelection]);

  useLayoutEffect(() => {
    if (!sessions) return;
    const availableIDs = new Set(sessions.map((session) => session.id));
    const selectedIDSet = new Set(selectedIDs);
    for (const id of [...openedTerminalIDs]) {
      if (!availableIDs.has(id)) openedTerminalIDs.delete(id);
    }
    for (const id of selectedIDs) {
      if (!availableIDs.has(id)) continue;
      openedTerminalIDs.delete(id);
      openedTerminalIDs.add(id);
    }
    const cachedIDs = [...openedTerminalIDs].filter(
      (id) => !selectedIDSet.has(id),
    );
    for (const id of cachedIDs.slice(0, -maxCachedTerminalViews)) {
      openedTerminalIDs.delete(id);
    }
  }, [openedTerminalIDs, sessions, selectedIDs]);

  useEffect(() => {
    if (!api || !sessions) return;
    const timer = window.setInterval(() => {
      api.listSessions().then(async (items) => {
        applySessionSnapshot(items);
        if (syncSelection) {
          const selection = await api.getSelection();
          acceptServerSelection(selection);
        }
      }).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [api, applySessionSnapshot, sessions !== null, syncSelection]);

  useEffect(() => {
    if (!syncSelection || !syncEvents || !api || !sessions) return;
    const controller = new AbortController();
    let retryDelay = 250;
    let refreshRunning = false;

    const refreshSnapshots = async () => {
      if (refreshRunning || controller.signal.aborted) return;
      refreshRunning = true;
      try {
        const [items, selection] = await Promise.all([
          api.listSessions(),
          api.getSelection(),
        ]);
        if (controller.signal.aborted) return;
        applySessionSnapshot(items);
        acceptServerSelection(selection);
        setAnnotationRevision((current) => current + 1);
      } finally {
        refreshRunning = false;
      }
    };

    const waitToReconnect = (milliseconds: number) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          controller.signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          window.clearTimeout(timer);
          finish();
        };
        const timer = window.setTimeout(finish, milliseconds);
        controller.signal.addEventListener("abort", abort, { once: true });
      });

    const consume = async () => {
      while (!controller.signal.aborted) {
        try {
          await refreshSnapshots();
          retryDelay = 250;
          await api.subscribeEvents(controller.signal, (event) => {
            if (event.type === "agent.summary.updated") {
              const summary = event.data as AgentSummary;
              if (!summary?.terminalId) return;
              setAgentSummaries((current) => [
                ...current.filter((item) => item.terminalId !== summary.terminalId),
                summary,
              ]);
              return;
            }
            if (event.type === "agent.summary.deleted") {
              const data = event.data as { terminalId?: string };
              if (data?.terminalId) {
                setAgentSummaries((current) =>
                  current.filter((item) => item.terminalId !== data.terminalId),
                );
              }
              return;
            }
            if (
              event.type === "task.created" ||
              event.type === "task.updated" ||
              event.type === "task.deleted" ||
              event.type === "task.update.created"
            ) {
              if (tasksOpen) void loadTasks();
              return;
            }
            if (event.type === "selection.changed") {
              const snapshot = event.data as SelectionSnapshot;
              if (typeof snapshot?.revision === "number") {
                acceptServerSelection(snapshot);
              }
              return;
            }
            if (
              event.type === "annotation.created" ||
              event.type === "annotation.completed" ||
              event.type === "annotation.canceled"
            ) {
              setAnnotationRevision((current) => current + 1);
              return;
            }
            if (
              event.type === "terminal.created" ||
              event.type === "terminal.updated" ||
              event.type === "terminal.deleted" ||
              event.type === "agent.updated" ||
              event.type === "subscriber_lagged"
            ) {
              if (event.type === "terminal.deleted") {
                const data = event.data as { id?: string; terminalId?: string };
                const deletedID = data?.id ?? data?.terminalId;
                if (deletedID) {
                  setAgentSummaries((current) =>
                    current.filter((item) => item.terminalId !== deletedID),
                  );
                }
              }
              void refreshSnapshots();
            }
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 401) {
            sessionStorage.removeItem(tokenKey);
            setAuthError(true);
            setToken("");
            return;
          }
        }
        if (controller.signal.aborted) return;
        await waitToReconnect(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5_000);
      }
    };
    void consume();
    return () => controller.abort();
  }, [
    api,
    applySessionSnapshot,
    loadTasks,
    sessions !== null,
    syncSelection,
    syncEvents,
    tasksOpen,
  ]);

  useEffect(() => {
    if (!syncSelection || !api || !selectionSyncReadyRef.current) return;
    const cwdFilterValues = cwdFilters
      .map(parseCwdFilter)
      .filter((filter): filter is CwdSelectionFilter => filter !== null);
    const pinnedCwdFilterValues = pinnedCwdFilters
      .map(parseCwdFilter)
      .filter((filter): filter is CwdSelectionFilter => filter !== null);
    const manualTerminalIds = selectedIDs.filter(
      (id) =>
        !filterSelectedIDsRef.current.has(id) &&
        (
          !pinnedIDs.includes(id) ||
          manualSelectedIDsRef.current.has(id)
        ),
    );
    const signature = selectionSourceSignature(
      manualTerminalIds,
      pinnedIDs,
      focusedID,
      statusFilters,
      cwdFilterValues,
      pinnedStatusFilters,
      pinnedCwdFilterValues,
    );
    if (
      signature === selectionServerSignatureRef.current &&
      !selectionWriteActiveRef.current
    ) {
      selectionSyncedLocalVersionRef.current =
        selectionLocalVersionRef.current;
      return;
    }

    selectionPendingRequestRef.current = {
      request: {
        manualTerminalIds,
        pinnedTerminalIds: pinnedIDs,
        ...(focusedID ? { focusedTerminalId: focusedID } : {}),
        filters: { statuses: statusFilters, cwds: cwdFilterValues },
        pinnedFilters: {
          statuses: pinnedStatusFilters,
          cwds: pinnedCwdFilterValues,
        },
      },
      localVersion: selectionLocalVersionRef.current,
    };
    void flushSelectionWrites();
  }, [
    api,
    syncSelection,
    selectedIDs,
    pinnedIDs,
    focusedID,
    statusFilters,
    cwdFilters,
    pinnedStatusFilters,
    pinnedCwdFilters,
  ]);

  useEffect(() => {
    if (!sessions || syncSelection) return;
    const available = new Set(sessions.map((session) => session.id));
    const removed =
      selectedIDs.some((id) => !available.has(id)) ||
      pinnedIDs.some((id) => !available.has(id));
    if (!removed) return;

    let nextIDs = selectedIDs.filter((id) => available.has(id));
    const removedID = focusedID && !available.has(focusedID)
      ? focusedID
      : selectedIDs.find((id) => !available.has(id));
    const replacement = removedID
      ? replacementSession(previousSessionOrderRef.current, removedID, sessions)
      : undefined;
    if (
      nextIDs.length === 0 &&
      statusFilters.length === 0 &&
      cwdFilters.length === 0 &&
      replacement
    ) {
      nextIDs = [replacement.id];
    }
    const nextPinnedIDs = pinnedIDs.filter((id) => available.has(id));
    const nextFocus =
      focusedID && nextIDs.includes(focusedID)
        ? focusedID
        : nextIDs[0] ?? null;
    setSelectedIDs(nextIDs);
    setPinnedIDs(nextPinnedIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(
      nextIDs,
      nextPinnedIDs,
      nextFocus,
      statusFilters,
      cwdFilters,
      "replace",
    );
  }, [
    sessions,
    syncSelection,
    selectedIDs,
    pinnedIDs,
    focusedID,
    statusFilters,
    cwdFilters,
    writeWorkspaceToURL,
  ]);

  useEffect(() => {
    if (syncSelection) {
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
        const pinnedFilterMatches = (sessions ?? [])
          .filter((session) =>
            matchesWorkspaceFilter(
              session,
              pinnedStatusFilters,
              pinnedCwdFilters,
            )
          )
          .map((session) => session.id);
        const next = [
          ...new Set([
            ...selectedIDs.filter((id) => pinnedIDs.includes(id)),
            ...pinnedFilterMatches,
            promotedID,
          ]),
        ];
        markLocalSelectionMutation();
        setSelectedIDs(next);
        setFocusedID(promotedID);
        setStatusFilters(pinnedStatusFilters);
        setCwdFilters(pinnedCwdFilters);
        filterSelectedIDsRef.current = new Set(
          pinnedFilterMatches.filter((id) => !pinnedIDs.includes(id)),
        );
        writeWorkspaceToURL(
          next,
          pinnedIDs,
          promotedID,
          pinnedStatusFilters,
          pinnedCwdFilters,
          "replace",
        );
        return;
      }
      return;
    }

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
      const pinnedFilterMatches = (sessions ?? [])
        .filter((session) =>
          matchesWorkspaceFilter(
            session,
            pinnedStatusFilters,
            pinnedCwdFilters,
          )
        )
        .map((session) => session.id);
      const next = [
        ...new Set([
          ...selectedIDs.filter((id) => pinnedIDs.includes(id)),
          ...pinnedFilterMatches,
          promotedID,
        ]),
      ];
      setSelectedIDs(next);
      setFocusedID(promotedID);
      setStatusFilters(pinnedStatusFilters);
      setCwdFilters(pinnedCwdFilters);
      filterSelectedIDsRef.current = new Set(
        pinnedFilterMatches.filter((id) => !pinnedIDs.includes(id)),
      );
      writeWorkspaceToURL(
        next,
        pinnedIDs,
        promotedID,
        pinnedStatusFilters,
        pinnedCwdFilters,
        "replace",
      );
      return;
    }

    if (!sessions || (statusFilters.length === 0 && cwdFilters.length === 0)) {
      return;
    }
    const matches = sessions
      .filter((session) => matchesWorkspaceFilter(session, statusFilters, cwdFilters))
      .map((session) => session.id);
    const previousMatches = filterSelectedIDsRef.current;
    for (const id of filterDeselectTimersRef.current.keys()) {
      if (
        !selectedIDs.includes(id) ||
        pinnedIDs.includes(id) ||
        matches.includes(id)
      ) {
        cancelFilterDeselect(id);
        expiredFilterDeselectIDsRef.current.delete(id);
      }
    }
    const pendingFilterDeselectIDs = new Set(filterDeselectTimersRef.current.keys());
    const next = [
      ...selectedIDs.filter(
        (id) =>
          !previousMatches.has(id) ||
          pendingFilterDeselectIDs.has(id),
      ),
      ...matches,
    ].filter((id, index, values) => values.indexOf(id) === index);
    filterSelectedIDsRef.current = new Set(
      [
        ...matches,
        ...[...pendingFilterDeselectIDs].filter(
          (id) => selectedIDs.includes(id) && !pinnedIDs.includes(id),
        ),
      ].filter((id) => !pinnedIDs.includes(id)),
    );
    if (next.join("\0") !== selectedIDs.join("\0")) {
      setSelectedIDs(next);
      const nextFocus = focusedID && next.includes(focusedID) ? focusedID : next[0] ?? null;
      setFocusedID(nextFocus);
      writeWorkspaceToURL(
        next,
        pinnedIDs,
        nextFocus,
        statusFilters,
        cwdFilters,
        "replace",
      );
    }
  }, [
    filterDeselectExpiryVersion,
    sessions,
    syncSelection,
    statusFilters,
    cwdFilters,
    pinnedStatusFilters,
    pinnedCwdFilters,
    selectedIDs,
    pinnedIDs,
    focusedID,
    markLocalSelectionMutation,
    writeWorkspaceToURL,
  ]);

  useEffect(() => {
    const expiredIDs = [...expiredFilterDeselectIDsRef.current];
    expiredFilterDeselectIDsRef.current.clear();
    if (
      expiredIDs.length === 0 ||
      !sessions ||
      (statusFilters.length === 0 && cwdFilters.length === 0)
    ) {
      return;
    }
    const expiredNonMatches = new Set(
      expiredIDs.filter((id) => {
        const session = sessions.find((item) => item.id === id);
        return session && !matchesWorkspaceFilter(session, statusFilters, cwdFilters);
      }),
    );
    if (expiredNonMatches.size === 0) return;
    const next = selectedIDs.filter(
      (id) => pinnedIDs.includes(id) || !expiredNonMatches.has(id),
    );
    if (next.join("\0") === selectedIDs.join("\0")) return;
    for (const id of expiredNonMatches) {
      filterSelectedIDsRef.current.delete(id);
    }
    const nextFocus =
      focusedID && next.includes(focusedID) ? focusedID : next[0] ?? null;
    if (syncSelection) markLocalSelectionMutation();
    setSelectedIDs(next);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(
      next,
      pinnedIDs,
      nextFocus,
      statusFilters,
      cwdFilters,
      "replace",
    );
  }, [
    filterDeselectExpiryVersion,
    sessions,
    syncSelection,
    statusFilters,
    cwdFilters,
    selectedIDs,
    pinnedIDs,
    focusedID,
    markLocalSelectionMutation,
    writeWorkspaceToURL,
  ]);

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
    try {
      localStorage.setItem(
        recentQuickActionsKey,
        JSON.stringify(recentQuickActionValues),
      );
    } catch {
      // Keep the in-memory history when browser storage is unavailable.
    }
  }, [recentQuickActionValues]);

  useEffect(() => {
    if (!sessions) return;
    const availableValues = availableQuickActionValues(sessions, selectedIDs);
    const availableRecentValues = recentQuickActionValues.filter((value) =>
      availableValues.has(value),
    );
    if (
      availableRecentValues.length === recentQuickActionValues.length &&
      availableRecentValues.every((value, index) => value === recentQuickActionValues[index])
    ) {
      return;
    }
    setRecentQuickActionValues(availableRecentValues);
  }, [recentQuickActionValues, selectedIDs, sessions]);

  useEffect(() => {
    const openCommands = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !event.metaKey) return;
      event.preventDefault();
      const availableValues = availableQuickActionValues(sessions ?? [], selectedIDs);
      setCommandQuery("");
      setCommandValue(
        recentQuickActionValues.find((value) => availableValues.has(value)) ??
          "new-terminal",
      );
      setCommandOpen(true);
    };
    window.addEventListener("keydown", openCommands, { capture: true });
    return () => window.removeEventListener("keydown", openCommands, { capture: true });
  }, [recentQuickActionValues, selectedIDs, sessions]);

  useEffect(() => {
    if (!commandOpen) return;
    const frame = window.requestAnimationFrame(() => commandInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [commandOpen]);

  useLayoutEffect(() => {
    if (!scrollCommandSelectionRef.current) return;
    scrollCommandSelectionRef.current = false;
    const selectedItem = Array.from(
      commandListRef.current?.querySelectorAll<HTMLElement>("[cmdk-item]") ?? [],
    ).find((item) => item.getAttribute("data-value") === commandValue);
    selectedItem?.scrollIntoView({ block: "nearest" });
  }, [commandValue]);

  useEffect(() => {
    if (!sessions) return;
    const restore = () => {
      if (syncSelection) {
        writeWorkspaceURL(
          selectedIDs,
          pinnedIDs,
          focusedID,
          statusFilters,
          cwdFilters,
          "replace",
          pinnedStatusFilters,
          pinnedCwdFilters,
        );
        return;
      }
      const workspace = workspaceFromURL(sessions);
      filterSelectedIDsRef.current.clear();
      decomposedStatusFiltersRef.current.clear();
      setSelectedIDs(workspace.selectedIDs);
      setPinnedIDs(workspace.pinnedIDs);
      setFocusedID(workspace.focusedID);
      setStatusFilters(workspace.statusFilters);
      setCwdFilters(workspace.cwdFilters);
      setPinnedStatusFilters(workspace.pinnedStatusFilters);
      setPinnedCwdFilters(workspace.pinnedCwdFilters);
      decomposedPinnedStatusFiltersRef.current = new Set(
        workspace.pinnedCwdFilters
          .map(parseCwdFilter)
          .filter((filter): filter is CwdSelectionFilter => filter !== null)
          .map((filter) => filter.status)
          .filter((status) => !workspace.pinnedStatusFilters.includes(status)),
      );
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [
    sessions,
    syncSelection,
    selectedIDs,
    pinnedIDs,
    focusedID,
    statusFilters,
    cwdFilters,
    pinnedStatusFilters,
    pinnedCwdFilters,
  ]);

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
  }, [focusedID, selectedIDs, pinnedIDs, sessions, settings.prefix]);

  function selectSession(
    id: string,
    multiple: boolean,
    allowEmpty = false,
    checkboxPin?: boolean,
  ) {
    markLocalSelectionMutation();
    if (!multiple) setSelectedDashboardIDs([]);
    let nextPinnedIDs = pinnedIDs;
    const pinned = pinnedIDs.includes(id);
    if (checkboxPin !== undefined && pinned) {
      nextPinnedIDs = pinnedIDs.filter((item) => item !== id);
      setPinnedIDs(nextPinnedIDs);
      allowEmpty = true;
    } else if (checkboxPin === true) {
      nextPinnedIDs = [...new Set([...pinnedIDs, id])];
      const nextIDs = selectedIDs.includes(id)
        ? selectedIDs
        : [...selectedIDs, id];
      filterSelectedIDsRef.current.delete(id);
      setPinnedIDs(nextPinnedIDs);
      setSelectedIDs(nextIDs);
      setFocusedID(id);
      setFocusedPaneID(null);
      writeWorkspaceToURL(
        nextIDs,
        nextPinnedIDs,
        id,
        statusFilters,
        cwdFilters,
      );
      return;
    }
    if (checkboxPin === undefined && multiple && pinned) {
      setFocusedID(id);
      setFocusedPaneID(null);
      writeWorkspaceToURL(
        selectedIDs,
        pinnedIDs,
        id,
        statusFilters,
        cwdFilters,
      );
      return;
    }

    let nextIDs: string[];
    if (!multiple) {
      const pinnedFilterMatches = (sessions ?? [])
        .filter((session) =>
          matchesWorkspaceFilter(
            session,
            pinnedStatusFilters,
            pinnedCwdFilters,
          )
        )
        .map((session) => session.id);
      nextIDs = [
        ...new Set([
          ...selectedIDs.filter((item) => nextPinnedIDs.includes(item)),
          ...pinnedFilterMatches,
          id,
        ]),
      ];
      setStatusFilters(pinnedStatusFilters);
      setCwdFilters(pinnedCwdFilters);
      filterSelectedIDsRef.current = new Set(
        pinnedFilterMatches.filter((item) => !nextPinnedIDs.includes(item)),
      );
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
        const statusWasPinned = pinnedStatusFilters.includes(status);
        const nextPinnedStatusFilters = pinnedStatusFilters.filter(
          (item) => item !== status,
        );
        let nextPinnedCwdFilters = pinnedCwdFilters.filter(
          (item) => item !== key,
        );
        if (statusOwnsSession) {
          decomposedStatusFiltersRef.current.add(status);
          if (statusWasPinned) {
            decomposedPinnedStatusFiltersRef.current.add(status);
          }
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
          if (statusWasPinned) {
            nextPinnedCwdFilters = [
              ...pinnedCwdFilters.filter(
                (filter) => !cwdFilterBelongsToStatus(filter, status),
              ),
              ...siblingCwdFilters,
            ];
          }
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
        if (nextIDs.length === 0 && !allowEmpty) nextIDs = [id];
        filterSelectedIDsRef.current = new Set(
          matching.filter((item) => !nextPinnedIDs.includes(item)),
        );
        const nextFocus =
          focusedID && nextIDs.includes(focusedID)
            ? focusedID
            : nextIDs[0] ?? null;
        setStatusFilters(nextStatusFilters);
        setCwdFilters(nextCwdFilters);
        setPinnedStatusFilters(nextPinnedStatusFilters);
        setPinnedCwdFilters(nextPinnedCwdFilters);
        setSelectedIDs(nextIDs);
        setFocusedID(nextFocus);
        setFocusedPaneID(null);
        writeWorkspaceToURL(
          nextIDs,
          nextPinnedIDs,
          nextFocus,
          nextStatusFilters,
          nextCwdFilters,
          "push",
          nextPinnedStatusFilters,
          nextPinnedCwdFilters,
        );
        return;
      }
      nextIDs = selectedIDs.length === 1 && !allowEmpty
        ? selectedIDs
        : selectedIDs.filter((item) => item !== id);
    } else {
      nextIDs = [...selectedIDs, id];
    }
    const nextFocus =
      multiple && selectedIDs.includes(id)
        ? focusedID && nextIDs.includes(focusedID)
          ? focusedID
          : nextIDs[0] ?? null
        : id;
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    setFocusedPaneID(null);
    writeWorkspaceToURL(
      nextIDs,
      nextPinnedIDs,
      nextFocus,
      multiple ? statusFilters : pinnedStatusFilters,
      multiple ? cwdFilters : pinnedCwdFilters,
      "push",
      pinnedStatusFilters,
      pinnedCwdFilters,
    );
  }

  function updateWorkspaceFilters(
    nextStatusFilters: string[],
    nextCwdFilters: string[],
    nextPinnedStatusFilters = pinnedStatusFilters,
    nextPinnedCwdFilters = pinnedCwdFilters,
  ) {
    markLocalSelectionMutation();
    const normalizedPinnedStatusFilters = [...new Set(nextPinnedStatusFilters)];
    const normalizedPinnedCwdFilters = [
      ...new Set(nextPinnedCwdFilters),
    ].filter((filter) => {
      const parsed = parseCwdFilter(filter);
      return parsed &&
        !normalizedPinnedStatusFilters.includes(parsed.status);
    });
    const normalizedStatusFilters = [
      ...new Set([...nextStatusFilters, ...normalizedPinnedStatusFilters]),
    ];
    const normalizedCwdFilters = [
      ...new Set([...nextCwdFilters, ...normalizedPinnedCwdFilters]),
    ];
    const matching = sessions
      ?.filter((session) =>
        matchesWorkspaceFilter(
          session,
          normalizedStatusFilters,
          normalizedCwdFilters,
        )
      )
      .map((session) => session.id) ?? [];
    const base = selectedIDs.filter(
      (id) =>
        pinnedIDs.includes(id) ||
        !filterSelectedIDsRef.current.has(id),
    );
    const nextIDs = [...new Set([...base, ...matching])];
    filterSelectedIDsRef.current = new Set(
      matching.filter((id) => !pinnedIDs.includes(id)),
    );
    const nextFocus = focusedID && nextIDs.includes(focusedID)
      ? focusedID
      : nextIDs[0] ?? null;
    setStatusFilters(normalizedStatusFilters);
    setCwdFilters(normalizedCwdFilters);
    setPinnedStatusFilters(normalizedPinnedStatusFilters);
    setPinnedCwdFilters(normalizedPinnedCwdFilters);
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(
      nextIDs,
      pinnedIDs,
      nextFocus,
      normalizedStatusFilters,
      normalizedCwdFilters,
      "push",
      normalizedPinnedStatusFilters,
      normalizedPinnedCwdFilters,
    );
  }

  function updateStatusFilter(
    status: string,
    checked: boolean,
    pin?: boolean,
  ) {
    decomposedStatusFiltersRef.current.delete(status);
    decomposedPinnedStatusFiltersRef.current.delete(status);
    const nextPinnedStatusFilters =
      checked && pin
        ? [...new Set([...pinnedStatusFilters, status])]
        : checked
          ? pinnedStatusFilters
          : pinnedStatusFilters.filter((item) => item !== status);
    const nextStatusFilters = checked
      ? [...new Set([...statusFilters, status])]
      : statusFilters.filter((item) => item !== status);
    const nextCwdFilters = cwdFilters.filter(
      (filter) => !cwdFilterBelongsToStatus(filter, status),
    );
    const nextPinnedCwdFilters = (checked && !pin)
      ? pinnedCwdFilters
      : pinnedCwdFilters.filter(
        (filter) => !cwdFilterBelongsToStatus(filter, status),
      );
    updateWorkspaceFilters(
      nextStatusFilters,
      nextCwdFilters,
      nextPinnedStatusFilters,
      nextPinnedCwdFilters,
    );
  }

  function updateCwdFilter(
    status: string,
    cwd: string,
    checked: boolean,
    pin?: boolean,
  ) {
    const key = cwdFilterKey(status, cwd);
    if (!checked && statusFilters.includes(status)) {
      decomposedStatusFiltersRef.current.add(status);
      const parentPinned = pinnedStatusFilters.includes(status);
      if (parentPinned) {
        decomposedPinnedStatusFiltersRef.current.add(status);
      }
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
        pinnedStatusFilters.filter((item) => item !== status),
        [
          ...pinnedCwdFilters.filter(
            (filter) => !cwdFilterBelongsToStatus(filter, status),
          ),
          ...(parentPinned ? siblingCwdFilters : []),
        ],
      );
      return;
    }
    const nextFilters = checked
      ? [...new Set([...cwdFilters, key])]
      : cwdFilters.filter((item) => item !== key);
    const nextPinnedFilters = checked &&
        (pin || decomposedPinnedStatusFiltersRef.current.has(status))
      ? [...new Set([...pinnedCwdFilters, key])]
      : checked
        ? pinnedCwdFilters
        : pinnedCwdFilters.filter((item) => item !== key);
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
      const consolidatePinned =
        decomposedPinnedStatusFiltersRef.current.has(status) &&
        currentStatusCwdFilters.every((filter) =>
          nextPinnedFilters.includes(filter)
        );
      decomposedStatusFiltersRef.current.delete(status);
      if (consolidatePinned) {
        decomposedPinnedStatusFiltersRef.current.delete(status);
      }
      updateWorkspaceFilters(
        [...new Set([...statusFilters, status])],
        nextFilters.filter(
          (filter) => !cwdFilterBelongsToStatus(filter, status),
        ),
        consolidatePinned
          ? [...new Set([...pinnedStatusFilters, status])]
          : pinnedStatusFilters,
        nextPinnedFilters.filter(
          (filter) =>
            !consolidatePinned ||
            !cwdFilterBelongsToStatus(filter, status),
        ),
      );
      return;
    }
    updateWorkspaceFilters(
      statusFilters,
      nextFilters,
      pinnedStatusFilters,
      nextPinnedFilters,
    );
  }

  function selectStatus(status: string) {
    const directMatches = sessions
      ?.filter((session) => sessionActivity(session) === status)
      .map((session) => session.id) ?? [];
    if (directMatches.length === 0) return;
    const nextStatusFilters = [
      ...new Set([...pinnedStatusFilters, status]),
    ];
    const nextCwdFilters = [...pinnedCwdFilters];
    const matching = sessions
      ?.filter((session) =>
        matchesWorkspaceFilter(session, nextStatusFilters, nextCwdFilters)
      )
      .map((session) => session.id) ?? [];
    markLocalSelectionMutation();
    const nextIDs = [
      ...new Set([
        ...selectedIDs.filter((id) => pinnedIDs.includes(id)),
        ...matching,
      ]),
    ];
    decomposedStatusFiltersRef.current.clear();
    const nextFocus = directMatches[0];
    setStatusFilters(nextStatusFilters);
    setCwdFilters(nextCwdFilters);
    filterSelectedIDsRef.current = new Set(
      matching.filter((id) => !pinnedIDs.includes(id)),
    );
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(
      nextIDs,
      pinnedIDs,
      nextFocus,
      nextStatusFilters,
      nextCwdFilters,
    );
  }

  function selectCwd(status: string, cwd: string) {
    const directMatches = sessions
      ?.filter(
        (session) =>
          sessionActivity(session) === status && session.cwd === cwd,
      )
      .map((session) => session.id) ?? [];
    if (directMatches.length === 0) return;
    const nextStatusFilters = [...pinnedStatusFilters];
    const nextCwdFilters = [
      ...new Set([...pinnedCwdFilters, cwdFilterKey(status, cwd)]),
    ];
    const matching = sessions
      ?.filter((session) =>
        matchesWorkspaceFilter(session, nextStatusFilters, nextCwdFilters)
      )
      .map((session) => session.id) ?? [];
    markLocalSelectionMutation();
    const nextIDs = [
      ...new Set([
        ...selectedIDs.filter((id) => pinnedIDs.includes(id)),
        ...matching,
      ]),
    ];
    decomposedStatusFiltersRef.current.clear();
    const nextFocus = directMatches[0];
    setStatusFilters(nextStatusFilters);
    setCwdFilters(nextCwdFilters);
    filterSelectedIDsRef.current = new Set(
      matching.filter((id) => !pinnedIDs.includes(id)),
    );
    setSelectedIDs(nextIDs);
    setFocusedID(nextFocus);
    writeWorkspaceToURL(
      nextIDs,
      pinnedIDs,
      nextFocus,
      nextStatusFilters,
      nextCwdFilters,
    );
  }

  function focusPane(id: string) {
    markLocalSelectionMutation();
    setFocusedID(id);
    setFocusedPaneID(null);
    writeWorkspaceToURL(selectedIDs, pinnedIDs, id, statusFilters, cwdFilters);
  }

  function focusWorkspacePane(id: string) {
    if (isDashboardPaneID(id)) {
      setFocusedPaneID(id);
      return;
    }
    focusPane(id);
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
      const inheritedCWD =
        cwd === undefined
          ? sessions?.find((session) => session.id === focusedID)?.cwd
          : undefined;
      let created: Session;
      let serverSelection: SelectionSnapshot | null = null;
      try {
        if (syncSelection) {
          const result = await api.createTerminal(
            "Terminal",
            cwd ?? inheritedCWD,
            split ? "add" : "replace",
          );
          created = result.terminal;
          serverSelection = result.selection;
        } else {
          created = await api.createSession("Terminal", cwd ?? inheritedCWD);
        }
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== "invalid_cwd" ||
          inheritedCWD === undefined
        ) {
          throw error;
        }
        if (syncSelection) {
          const result = await api.createTerminal(
            "Terminal",
            undefined,
            split ? "add" : "replace",
          );
          created = result.terminal;
          serverSelection = result.selection;
        } else {
          created = await api.createSession("Terminal");
        }
      }
      setSessions((current) => [...(current ?? []), created]);
      if (!split) setSelectedDashboardIDs([]);
      if (serverSelection) {
        applyServerSelection(serverSelection, "push");
        setFocusedPaneID(null);
        setRequestError("");
        return;
      }
      const nextIDs = split
        ? [...selectedIDs, created.id]
        : [
            ...new Set([
              ...selectedIDs.filter((id) => pinnedIDs.includes(id)),
              ...(sessions ?? [])
                .filter((session) =>
                  matchesWorkspaceFilter(
                    session,
                    pinnedStatusFilters,
                    pinnedCwdFilters,
                  )
                )
                .map((session) => session.id),
              created.id,
            ]),
          ];
      setSelectedIDs(nextIDs);
      setFocusedID(created.id);
      setFocusedPaneID(null);
      setStatusFilters(split ? statusFilters : pinnedStatusFilters);
      setCwdFilters(split ? cwdFilters : pinnedCwdFilters);
      filterSelectedIDsRef.current.clear();
      decomposedStatusFiltersRef.current.clear();
      writeWorkspaceToURL(
        nextIDs,
        pinnedIDs,
        created.id,
        split ? statusFilters : pinnedStatusFilters,
        split ? cwdFilters : pinnedCwdFilters,
      );
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

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    await createSession(false, cwdDraft.trim());
    setCreateOpen(false);
  }

  async function deleteSessions(items: Session[]) {
    if (!api || items.length === 0) return;
    const previousSessions = sessions ?? [];
    const deletedIDs = new Set<string>();
    let latestSelection: SelectionSnapshot | null = null;

    const reconcileLocalDeletion = () => {
      const remaining = previousSessions.filter(
        (candidate) => !deletedIDs.has(candidate.id),
      );
      const lastDeletedID = [...items]
        .reverse()
        .find((item) => deletedIDs.has(item.id))?.id;
      const replacement = lastDeletedID
        ? replacementSession(previousSessions, lastDeletedID, remaining)
        : undefined;
      let nextIDs = selectedIDs.filter((id) => !deletedIDs.has(id));
      if (
        nextIDs.length === 0 &&
        statusFilters.length === 0 &&
        cwdFilters.length === 0 &&
        replacement
      ) {
        nextIDs = [replacement.id];
      }
      const nextPinnedIDs = pinnedIDs.filter((id) => !deletedIDs.has(id));
      const nextFocus = focusedID && nextIDs.includes(focusedID)
        ? focusedID
        : nextIDs[0] ?? null;
      filterSelectedIDsRef.current = new Set(
        [...filterSelectedIDsRef.current].filter((id) => !deletedIDs.has(id)),
      );
      setSelectedIDs(nextIDs);
      setPinnedIDs(nextPinnedIDs);
      setFocusedID(nextFocus);
      writeWorkspaceToURL(
        nextIDs,
        nextPinnedIDs,
        nextFocus,
        statusFilters,
        cwdFilters,
      );
    };

    try {
      for (const item of items) {
        const deleted = syncSelection
          ? await api.deleteTerminal(item.id)
          : null;
        if (!syncSelection) {
          await api.deleteSession(item.id);
        }
        deletedIDs.add(item.id);
        if (deleted) latestSelection = deleted.selection;
        cancelFilterDeselect(item.id);
        setSessions((current) =>
          current?.filter((candidate) => candidate.id !== item.id) ?? current,
        );
      }
    } catch (error) {
      if (deletedIDs.size > 0) {
        if (latestSelection) applyServerSelection(latestSelection, "push");
        else reconcileLocalDeletion();
      }
      setRequestError(
        error instanceof Error ? error.message : "The terminal could not be deleted.",
      );
      return;
    }

    if (latestSelection) applyServerSelection(latestSelection, "push");
    else reconcileLocalDeletion();
    setRequestError("");
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const items = pendingDelete;
    setPendingDelete(null);
    void deleteSessions(items);
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
    setTerminalHistoryLimitDraft(historyLimitDraft(settings.terminalHistoryLimit));
    setUnlimitedTerminalHistory(settings.terminalHistoryLimit === 0);
    setTerminalFontFamilyDraft(settings.terminalFontFamily);
    setTerminalLineHeightDraft(String(settings.terminalLineHeight));
    setTerminalCursorStyleDraft(settings.terminalCursorStyle);
    setTerminalCursorBlinkDraft(settings.terminalCursorBlink);
    setTerminalScrollSensitivityDraft(String(settings.terminalScrollSensitivity));
    setTerminalOptionAsAltDraft(settings.terminalOptionAsAlt);
    setAgentSummaryProviderDraft(settings.agentSummaryProvider);
    setFontSizeDrafts({
      interfaceFontSize: String(settings.interfaceFontSize),
      terminalFontSize: String(settings.terminalFontSize),
      agentLogFontSize: String(settings.agentLogFontSize),
    });
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
    const terminalHistoryMiB = Number(terminalHistoryLimitDraft);
    if (
      !unlimitedTerminalHistory &&
      (!Number.isInteger(terminalHistoryMiB) ||
        terminalHistoryMiB < 1 ||
        terminalHistoryMiB > maxHistoryMiB)
    ) {
      setSettingsError({
        field: "terminalHistoryLimit",
        message: "Enter a whole number from 1 to 4095 MiB.",
      });
      return;
    }
    const terminalHistoryLimit = unlimitedTerminalHistory
      ? 0
      : terminalHistoryMiB * bytesPerMiB;
    const fontSizes = {
      interfaceFontSize: parseFontSize(fontSizeDrafts.interfaceFontSize),
      terminalFontSize: parseFontSize(fontSizeDrafts.terminalFontSize),
      agentLogFontSize: parseFontSize(fontSizeDrafts.agentLogFontSize),
    };
    const invalidFontSize = (
      Object.entries(fontSizes) as Array<[FontSizeSetting, number | null]>
    ).find(([, value]) => value === null);
    if (invalidFontSize) {
      setSettingsError({
        field: invalidFontSize[0],
        message: "Choose a whole number from 10 to 24.",
      });
      return;
    }
    const terminalFontFamily = parseTerminalFontFamily(terminalFontFamilyDraft);
    if (!terminalFontFamily) {
      setSettingsError({
        field: "terminalFontFamily",
        message: "Choose a font family of 1 to 256 characters.",
      });
      return;
    }
    const terminalLineHeight = parseTerminalLineHeight(terminalLineHeightDraft);
    if (terminalLineHeight === null) {
      setSettingsError({
        field: "terminalLineHeight",
        message: "Choose a value from 1.00 to 2.00 in 0.05 increments.",
      });
      return;
    }
    const terminalCursorStyle = parseTerminalCursorStyle(terminalCursorStyleDraft);
    if (terminalCursorStyle === null) {
      setSettingsError({
        field: "terminalCursorStyle",
        message: "Choose Bar, Block, or Underline.",
      });
      return;
    }
    const terminalScrollSensitivity = parseTerminalScrollSensitivity(
      terminalScrollSensitivityDraft,
    );
    if (terminalScrollSensitivity === null) {
      setSettingsError({
        field: "terminalScrollSensitivity",
        message: "Choose a whole number from 1 to 5.",
      });
      return;
    }
    await persistSettings({
      ...settings,
      prefix,
      paneTabShortcut,
      interfaceFontSize: fontSizes.interfaceFontSize!,
      terminalFontSize: fontSizes.terminalFontSize!,
      terminalFontFamily,
      agentLogFontSize: fontSizes.agentLogFontSize!,
      terminalHistoryLimit,
      terminalLineHeight,
      terminalCursorStyle,
      terminalCursorBlink: terminalCursorBlinkDraft,
      terminalScrollSensitivity,
      terminalOptionAsAlt: terminalOptionAsAltDraft,
      agentSummaryProvider: agentSummaryProviderDraft,
    });
    setSettingsOpen(false);
  }

  function selectDashboardPane(id: DashboardPaneID, multiple: boolean) {
    if (!multiple) {
      const pinnedIDSet = new Set(pinnedIDs);
      const pinnedFilterMatches: string[] = [];
      for (const session of sessions ?? []) {
        if (
          matchesWorkspaceFilter(
            session,
            pinnedStatusFilters,
            pinnedCwdFilters,
          )
        ) {
          pinnedFilterMatches.push(session.id);
        }
      }
      const nextIDs = [
        ...new Set([
          ...selectedIDs.filter((item) => pinnedIDSet.has(item)),
          ...pinnedFilterMatches,
        ]),
      ];
      markLocalSelectionMutation();
      setSelectedDashboardIDs([id]);
      setStatusFilters(pinnedStatusFilters);
      setCwdFilters(pinnedCwdFilters);
      filterSelectedIDsRef.current = new Set(
        pinnedFilterMatches.filter((item) => !pinnedIDSet.has(item)),
      );
      decomposedStatusFiltersRef.current.clear();
      setSelectedIDs(nextIDs);
      setFocusedID(null);
      setFocusedPaneID(id);
      writeWorkspaceToURL(
        nextIDs,
        pinnedIDs,
        null,
        pinnedStatusFilters,
        pinnedCwdFilters,
        "push",
        pinnedStatusFilters,
        pinnedCwdFilters,
      );
      return;
    }

    const alreadySelected = selectedDashboardIDs.includes(id);
    const nextDashboardIDs = alreadySelected
      ? selectedDashboardIDs.filter((item) => item !== id)
      : [...selectedDashboardIDs, id];
    if (nextDashboardIDs.length === 0 && selectedIDs.length === 0) return;

    const currentFocus = focusedPaneID ?? focusedID;
    let nextFocus = currentFocus;
    if (!alreadySelected) {
      nextFocus = id;
    } else if (nextFocus === id) {
      nextFocus = focusedID && selectedIDs.includes(focusedID)
        ? focusedID
        : nextDashboardIDs[0] ?? null;
    }
    const nextTerminalFocus = isDashboardPaneID(nextFocus)
      ? focusedID
      : nextFocus;
    if (nextTerminalFocus !== focusedID) {
      markLocalSelectionMutation();
      setFocusedID(nextTerminalFocus);
      writeWorkspaceToURL(
        selectedIDs,
        pinnedIDs,
        nextTerminalFocus,
        statusFilters,
        cwdFilters,
      );
    }
    setSelectedDashboardIDs(nextDashboardIDs);
    setFocusedPaneID(isDashboardPaneID(nextFocus) ? nextFocus : null);
  }

  function openTasksWorkspace(multiple = false) {
    selectDashboardPane(tasksPaneID, multiple);
  }

  function openAgentsWorkspace(multiple = false) {
    selectDashboardPane(agentsPaneID, multiple);
  }

  function selectTask(id: string) {
    setSelectedTaskID(id);
    setTaskRefinement(null);
  }

  async function createTask(input: TaskCreateInput) {
    if (!api) return;
    try {
      const created = await api.createTask(input);
      replaceTask(created);
      setSelectedTaskID(created.id);
      setTasksError("");
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "Task could not be created.");
    }
  }

  async function updateTask(id: string, input: TaskUpdateInput) {
    if (!api) return;
    try {
      replaceTask(await api.updateTask(id, input));
      setTasksError("");
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "Task could not be updated.");
    }
  }

  async function deleteTask(id: string) {
    if (!api) return;
    try {
      await api.deleteTask(id);
      setTasks((current) => current.filter((task) => task.id !== id));
      setSelectedTaskID((current) => (current === id ? null : current));
      setTaskRefinement(null);
      setTasksError("");
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "Task could not be deleted.");
    }
  }

  async function startTaskAgent(id: string, input: TaskStartInput) {
    if (!api) return;
    try {
      const updated = await api.startTaskAgent(id, input);
      replaceTask(updated);
      setTasksError("");
      if (updated.terminalId) {
        const latestSessions = await api.listSessions();
        applySessionSnapshot(latestSessions);
      }
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "The agent could not be started.");
    }
  }

  async function promptTaskAgent(id: string, prompt: string) {
    if (!api) return;
    try {
      replaceTask(await api.promptTaskAgent(id, prompt));
      setTasksError("");
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "The agent could not be reached.");
    }
  }

  async function refineTask(id: string) {
    if (!api) return;
    setTaskRefining(true);
    setTasksError("");
    try {
      setTaskRefinement(await api.refineTask(id));
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "The task could not be refined.");
    } finally {
      setTaskRefining(false);
    }
  }

  async function applyTaskRefinement(id: string, refinement: TaskRefinement) {
    await updateTask(id, {
      title: refinement.title,
      description: refinement.description,
      priority: refinement.priority,
      status: refinement.status,
    });
    setTaskRefinement(null);
  }

  function openTaskTerminal(id: string) {
    setTaskRefinement(null);
    selectSession(id, false);
  }

  async function openAgentTerminal(id: string) {
    const snapshot = agentSummaries.find((item) => item.terminalId === id);
    if (api) {
      try {
        const summary = await api.markAgentSummaryRead(id);
        setAgentSummaries((current) =>
          current.map((item) => {
            if (item.terminalId !== id) return item;
            if (snapshot && !agentSummaryMatchesSnapshot(item, snapshot)) return item;
            return summary;
          }),
        );
        setAgentSummariesError("");
      } catch (error) {
        setAgentSummariesError(
          error instanceof Error
            ? error.message
            : "The agent summary could not be marked as read.",
        );
      }
    }
    selectSession(id, false);
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

  const sessionsByID = new Map(sessions.map((session) => [session.id, session]));
  const panes = selectedIDs.reduce<Session[]>((result, id) => {
    const session = sessionsByID.get(id);
    if (session) result.push(session);
    return result;
  }, []);
  const selectedSessions = panes;
  const selectedIDSet = new Set(selectedIDs);
  const cachedPanes = [...openedTerminalIDs]
    .filter((id) => !selectedIDSet.has(id))
    .slice(-maxCachedTerminalViews)
    .reduce<Session[]>((result, id) => {
      const session = sessionsByID.get(id);
      if (session) result.push(session);
      return result;
    }, []);
  const mountedPanes = [...panes, ...cachedPanes];
  const activePaneID = focusedPaneID ?? focusedID;
  const dashboardPanes: PaneCarouselItem[] = [];
  if (tasksOpen) {
    dashboardPanes.push({
      id: tasksPaneID,
      label: "Tasks pane",
      content: (
        <TasksView
          tasks={tasks}
          sessions={sessions}
          selectedTaskID={selectedTaskID}
          loading={tasksLoading}
          error={tasksError}
          refinement={taskRefinement}
          refining={taskRefining}
          onSelectTask={selectTask}
          onCreateTask={createTask}
          onUpdateTask={updateTask}
          onDeleteTask={deleteTask}
          onStartAgent={startTaskAgent}
          onOpenTerminal={openTaskTerminal}
          onRefineTask={refineTask}
          onApplyRefinement={applyTaskRefinement}
          onPromptTask={promptTaskAgent}
        />
      ),
    });
  }
  if (agentsOpen) {
    dashboardPanes.push({
      id: agentsPaneID,
      label: "Agents pane",
      content: (
        <AgentsView
          summaries={agentSummaries}
          sessions={sessions}
          loading={agentSummariesLoading}
          error={agentSummariesError}
          onSelectSession={openAgentTerminal}
        />
      ),
    });
  }
  const terminalPanes: PaneCarouselItem[] = api
    ? mountedPanes.map((pane) => ({
      id: pane.id,
      label: `${pane.name} pane`,
      cached: !selectedIDSet.has(pane.id),
      content: (
        <TerminalPane
          session={pane}
          api={api!}
          active={activePaneID === pane.id}
          layoutVersion={panes.length}
          tabShortcut={settings.paneTabShortcut}
          agentLogFontSize={previewSettings.agentLogFontSize}
          annotationRevision={
            syncSelection && syncEvents ? annotationRevision : null
          }
          onDeselect={() => selectSession(pane.id, true, true, false)}
          renderTerminal={(paneLayoutVersion, terminalActive, sourceVisible) =>
            renderTerminal(
              pane,
              api!,
              terminalActive,
              paneLayoutVersion,
              handleConnectionChange,
              reconnectSignals[pane.id] ?? 0,
              previewSettings.terminalFontFamily,
              previewSettings.terminalFontSize,
              settings.terminalHistoryLimit,
              sourceVisible,
              previewSettings.terminalLineHeight,
              previewSettings.terminalCursorStyle,
              previewSettings.terminalCursorBlink,
              previewSettings.terminalScrollSensitivity,
              previewSettings.terminalOptionAsAlt,
            )
          }
        />
      ),
    }))
    : [];
  const workspacePanes = [...dashboardPanes, ...terminalPanes];
  const selected = sessionsByID.get(activePaneID ?? "") ?? panes[0];
  const agentSummaryCount = agentSummaries.filter(
    (summary) => summary.unread && sessionsByID.has(summary.terminalId),
  ).length;
  const taskCount = tasks.filter((task) => task.status !== "done").length;
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
    ...(selectedSessions.length > 0
      ? [{
        value: "delete-selected-terminals",
        label: "Delete selected terminals",
        detail: `${selectedSessions.length} selected terminal${selectedSessions.length === 1 ? "" : "s"}`,
        search: "delete remove selected terminals",
        run: () => {
          setCommandOpen(false);
          setPendingDelete(selectedSessions);
        },
        group: "Actions",
      }]
      : []),
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
    ...quickActionStatuses
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
  const quickActionGroupsForQuery = (query: string) => {
    const matchingActions = quickActions.filter((action) =>
      `${action.label} ${action.search}`.toLowerCase().includes(query),
    );
    if (query) {
      return ["Actions", "Terminals"].map((heading) => ({
        heading,
        actions: matchingActions.filter((action) => action.group === heading),
      }));
    }

    const recentActions = recentQuickActionValues
      .map((value) => matchingActions.find((action) => action.value === value))
      .filter((action): action is (typeof matchingActions)[number] => Boolean(action));
    const recentValues = new Set(recentActions.map((action) => action.value));
    return [
      { heading: "Recent", actions: recentActions },
      ...["Actions", "Terminals"].map((heading) => ({
        heading,
        actions: matchingActions.filter(
          (action) => action.group === heading && !recentValues.has(action.value),
        ),
      })),
    ];
  };
  const quickActionGroups = quickActionGroupsForQuery(normalizedCommandQuery);
  const filteredQuickActions = quickActionGroups.flatMap((group) => group.actions);
  const pendingDeleteCount = pendingDelete?.length ?? 0;
  const deletingMultiple = pendingDeleteCount > 1;

  const runQuickAction = (action: (typeof quickActions)[number]) => {
    setRecentQuickActionValues((current) =>
      [action.value, ...current.filter((value) => value !== action.value)]
        .slice(0, recentQuickActionsLimit),
    );
    action.run();
  };

  const updateCommandQuery = (query: string) => {
    setCommandQuery(query);
    const normalized = query.trim().toLowerCase();
    const first = quickActionGroupsForQuery(normalized)
      .flatMap((group) => group.actions)[0];
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
    const nextValue = filteredQuickActions[nextIndex].value;
    if (nextValue === commandValue) return;
    scrollCommandSelectionRef.current = true;
    setCommandValue(nextValue);
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
      runQuickAction(selectedAction);
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

  const emptyState = (
    <div className="empty-state">
      <div className="empty-state-card">
        <span className="empty-state-kicker">Terminal workspace</span>
        <h2 className="empty-state-title">No signal yet.</h2>
        <p className="empty-state-description">
          Start a terminal to begin a session.
        </p>
        <Button
          type="button"
          className="empty-state-action"
          onClick={() => void createSession()}
        >
          Start a terminal
        </Button>
      </div>
    </div>
  );

  return (
    <main
      className="workspace"
      style={{
        "--interface-font-size": `${previewSettings.interfaceFontSize}px`,
      } as CSSProperties}
    >
      <SessionNavigation
        sessions={sessions}
        selectedIDs={selectedIDs}
        pinnedIDs={pinnedIDs}
        onSelect={(id, multiple, pin) =>
          selectSession(id, multiple, false, pin)
        }
        onCreate={(cwd) => void createSession(false, cwd)}
        onDelete={(session) => setPendingDelete([session])}
        settings={settings}
        onSettingsChange={(next) => void persistSettings(next)}
        onOpenSettings={openSettings}
        tasksOpen={tasksOpen}
        focusedPaneID={focusedPaneID}
        taskCount={taskCount}
        onOpenTasks={openTasksWorkspace}
        agentsOpen={agentsOpen}
        agentSummaryCount={agentSummaryCount}
        onOpenAgents={openAgentsWorkspace}
      />
      <section
        className="terminal-stage"
        data-multiple={workspacePanes.length > 1}
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
        {workspacePanes.length > 0 ? (
          <>
            <PaneCarousel
              focusedID={activePaneID}
              onFocus={focusWorkspacePane}
              panes={workspacePanes}
            />
            {panes.length === 0 && selectedDashboardIDs.length === 0 && (
              emptyState
            )}
          </>
        ) : (
          emptyState
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
        className="top-[10vh] h-[min(40rem,80vh)] max-h-[calc(100vh-2rem)] sm:max-w-xl"
        initialFocus={commandInputRef}
      >
        <Command
          className="min-h-0"
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
          <CommandList ref={commandListRef} className="min-h-0 max-h-none flex-1">
            <CommandEmpty>No matching actions.</CommandEmpty>
            {quickActionGroups.map(({ heading, actions }) => {
              if (actions.length === 0) return null;
              return (
                <CommandGroup heading={heading} key={heading}>
                  {actions.map((action) => (
                    <CommandItem
                      key={action.value}
                      value={action.value}
                      onSelect={() => runQuickAction(action)}
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
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deletingMultiple ? "Delete selected terminals?" : "Delete terminal?"}
            </DialogTitle>
            <DialogDescription>
              {deletingMultiple
                ? `${pendingDeleteCount} selected terminals will be stopped and removed from this workspace. This cannot be undone.`
                : <>“{pendingDelete?.[0]?.name}” will be stopped and removed from this workspace. This cannot be undone.</>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete}>
              {deletingMultiple ? "Delete terminals" : "Delete terminal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              Configure workspace shortcuts, selection, text sizing, terminal appearance, and history.
            </DialogDescription>
          </DialogHeader>
          <form
            className="settings-form"
            noValidate
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
                  Cycle the focused pane through Terminal, Agent log, and Changes.
                </FieldDescription>
                {settingsError?.field === "paneTabShortcut" && (
                  <FieldError>{settingsError.message}</FieldError>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="agentSummaryProvider">Summary provider</FieldLabel>
                <select
                  id="agentSummaryProvider"
                  name="agentSummaryProvider"
                  aria-label="Summary provider"
                  className="settings-select"
                  value={agentSummaryProviderDraft}
                  onChange={(event) =>
                    setAgentSummaryProviderDraft(event.target.value as Settings["agentSummaryProvider"])
                  }
                >
                  <option value="claude">Claude · Haiku</option>
                  <option value="codex">Codex · GPT-5.6-luna</option>
                </select>
                <FieldDescription>
                  Generate agent summaries with the selected command-line model.
                </FieldDescription>
              </Field>
              <Field data-invalid={settingsError?.field === "terminalHistoryLimit"}>
                <FieldLabel htmlFor="terminal-history-limit">
                  History buffer
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="terminal-history-limit"
                    type="number"
                    min={1}
                    max={maxHistoryMiB}
                    step={1}
                    value={terminalHistoryLimitDraft}
                    onChange={(event) => setTerminalHistoryLimitDraft(event.target.value)}
                    disabled={unlimitedTerminalHistory}
                    aria-invalid={settingsError?.field === "terminalHistoryLimit"}
                  />
                  <InputGroupAddon align="inline-end">MiB</InputGroupAddon>
                </InputGroup>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="unlimited-terminal-history">
                    Unlimited history
                  </FieldLabel>
                  <Checkbox
                    id="unlimited-terminal-history"
                    checked={unlimitedTerminalHistory}
                    onCheckedChange={(checked) =>
                      setUnlimitedTerminalHistory(Boolean(checked))}
                  />
                </Field>
                <FieldDescription>
                  Controls retained reconnect output and scrollback capacity.
                  Large or unlimited histories can increase memory use.
                </FieldDescription>
                {settingsError?.field === "terminalHistoryLimit" && (
                  <FieldError>{settingsError.message}</FieldError>
                )}
              </Field>
              <section className="font-size-section" aria-labelledby="font-size-heading">
                <div className="settings-section-heading">
                  <h3 id="font-size-heading">Font sizes</h3>
                  <span>10–24 px</span>
                </div>
                <div className="font-size-fields">
                  {([
                    ["interfaceFontSize", "Interface"],
                    ["terminalFontSize", "Terminal"],
                    ["agentLogFontSize", "Agent log"],
                  ] as const).map(([field, label]) => (
                    <Field key={field} data-invalid={settingsError?.field === field}>
                      <FieldLabel htmlFor={field}>{label}</FieldLabel>
                      <div className="font-size-input">
                        <Input
                          id={field}
                          name={field}
                          type="number"
                          min={10}
                          max={24}
                          step={1}
                          inputMode="numeric"
                          value={fontSizeDrafts[field]}
                          onChange={(event) => {
                            setFontSizeDrafts((current) => ({
                              ...current,
                              [field]: event.target.value,
                            }));
                            if (settingsError?.field === field) setSettingsError(null);
                          }}
                          aria-invalid={settingsError?.field === field}
                        />
                        <span aria-hidden="true">px</span>
                      </div>
                      {settingsError?.field === field && (
                        <FieldError>{settingsError.message}</FieldError>
                      )}
                    </Field>
                  ))}
                </div>
              </section>
              <Field
                data-invalid={settingsError?.field === "terminalFontFamily"}
              >
                <FieldLabel htmlFor="terminalFontFamily">
                  Terminal font
                </FieldLabel>
                <Input
                  id="terminalFontFamily"
                  name="terminalFontFamily"
                  value={terminalFontFamilyDraft}
                  onChange={(event) => {
                    setTerminalFontFamilyDraft(event.target.value);
                    if (settingsError?.field === "terminalFontFamily") {
                      setSettingsError(null);
                    }
                  }}
                  aria-invalid={
                    settingsError?.field === "terminalFontFamily"
                  }
                />
                <FieldDescription>
                  Use a CSS font family or fallback list. Unavailable fonts use
                  the next family.
                </FieldDescription>
                {settingsError?.field === "terminalFontFamily" && (
                  <FieldError>{settingsError.message}</FieldError>
                )}
              </Field>
              <section
                className="terminal-appearance-section"
                aria-labelledby="terminal-appearance-heading"
              >
                <div className="settings-section-heading">
                  <h3 id="terminal-appearance-heading">Terminal appearance</h3>
                  <span>Comfort &amp; control</span>
                </div>
                <Field orientation="horizontal">
                  <Checkbox
                    id="terminalOptionAsAlt"
                    checked={terminalOptionAsAltDraft}
                    onCheckedChange={(checked) =>
                      setTerminalOptionAsAltDraft(Boolean(checked))}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="terminalOptionAsAlt">Option as Alt</FieldLabel>
                    <FieldDescription>
                      Send macOS Option-modified keys as Alt sequences to terminal applications.
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <div className="terminal-appearance-fields">
                  <Field data-invalid={settingsError?.field === "terminalLineHeight"}>
                    <FieldLabel htmlFor="terminalLineHeight">
                      Terminal line height
                    </FieldLabel>
                    <div className="settings-number-input">
                      <Input
                        id="terminalLineHeight"
                        name="terminalLineHeight"
                        type="number"
                        min={1}
                        max={2}
                        step={0.05}
                        inputMode="decimal"
                        value={terminalLineHeightDraft}
                        onChange={(event) => {
                          setTerminalLineHeightDraft(event.target.value);
                          if (settingsError?.field === "terminalLineHeight") {
                            setSettingsError(null);
                          }
                        }}
                        aria-invalid={settingsError?.field === "terminalLineHeight"}
                      />
                      <span aria-hidden="true">×</span>
                    </div>
                    <FieldDescription>
                      Vertical space between terminal rows, from 1.00× to 2.00×.
                    </FieldDescription>
                    {settingsError?.field === "terminalLineHeight" && (
                      <FieldError>{settingsError.message}</FieldError>
                    )}
                  </Field>
                  <Field
                    data-invalid={settingsError?.field === "terminalScrollSensitivity"}
                  >
                    <FieldLabel htmlFor="terminalScrollSensitivity">
                      Scroll sensitivity
                    </FieldLabel>
                    <Input
                      id="terminalScrollSensitivity"
                      name="terminalScrollSensitivity"
                      type="number"
                      min={1}
                      max={5}
                      step={1}
                      inputMode="numeric"
                      value={terminalScrollSensitivityDraft}
                      onChange={(event) => {
                        setTerminalScrollSensitivityDraft(event.target.value);
                        if (settingsError?.field === "terminalScrollSensitivity") {
                          setSettingsError(null);
                        }
                      }}
                      aria-invalid={settingsError?.field === "terminalScrollSensitivity"}
                    />
                    <FieldDescription>
                      Wheel movement multiplier from 1 to 5.
                    </FieldDescription>
                    {settingsError?.field === "terminalScrollSensitivity" && (
                      <FieldError>{settingsError.message}</FieldError>
                    )}
                  </Field>
                </div>
                <Field data-invalid={settingsError?.field === "terminalCursorStyle"}>
                  <FieldLabel htmlFor="terminalCursorStyle">Cursor style</FieldLabel>
                  <select
                    id="terminalCursorStyle"
                    name="terminalCursorStyle"
                    aria-label="Cursor style"
                    className="settings-select"
                    value={terminalCursorStyleDraft}
                    onChange={(event) => {
                      setTerminalCursorStyleDraft(event.target.value);
                      if (settingsError?.field === "terminalCursorStyle") {
                        setSettingsError(null);
                      }
                    }}
                    aria-invalid={settingsError?.field === "terminalCursorStyle"}
                  >
                    <option value="bar">Bar</option>
                    <option value="block">Block</option>
                    <option value="underline">Underline</option>
                  </select>
                  <FieldDescription>
                    Choose the shape used by the active terminal cursor.
                  </FieldDescription>
                  {settingsError?.field === "terminalCursorStyle" && (
                    <FieldError>{settingsError.message}</FieldError>
                  )}
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="terminalCursorBlink"
                    checked={terminalCursorBlinkDraft}
                    onCheckedChange={(checked) =>
                      setTerminalCursorBlinkDraft(Boolean(checked))}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="terminalCursorBlink">Cursor blink</FieldLabel>
                    <FieldDescription>
                      Animate the cursor while the terminal is focused.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </section>
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
