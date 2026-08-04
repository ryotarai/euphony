import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BotIcon, CheckIcon, ChevronRightIcon, PlusIcon, SparklesIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  Session,
  Task,
  TaskCreateInput,
  TaskPriority,
  TaskRefinement,
  TaskStartInput,
  TaskStatus,
  TaskUpdateInput,
} from "../types";

export interface TasksViewProps {
  tasks: Task[];
  sessions: Session[];
  selectedTaskID: string | null;
  loading?: boolean;
  error?: string;
  refinement?: TaskRefinement | null;
  refining?: boolean;
  onSelectTask(id: string): void;
  onCreateTask(input: TaskCreateInput): Promise<void> | void;
  onUpdateTask(id: string, input: TaskUpdateInput): Promise<void> | void;
  onDeleteTask(id: string): Promise<void> | void;
  onStartAgent(id: string, input: TaskStartInput): Promise<void> | void;
  onOpenTerminal(id: string): void;
  onRefineTask(id: string): Promise<void> | void;
  onApplyRefinement(id: string, refinement: TaskRefinement): Promise<void> | void;
  onPromptTask(id: string, prompt: string): Promise<void> | void;
}

const priorities: TaskPriority[] = ["low", "medium", "high"];
const statuses: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];

function label(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function TaskRow({ task, selected, onSelect }: {
  task: Task;
  selected: boolean;
  onSelect(id: string): void;
}) {
  return (
    <button
      type="button"
      className="task-row"
      data-selected={selected || undefined}
      data-status={task.status}
      data-priority={task.priority}
      aria-current={selected ? "true" : undefined}
      aria-label={`Open task ${task.title}`}
      onClick={() => onSelect(task.id)}
    >
      <span className="task-row-signal" aria-hidden="true" />
      <span className="task-row-copy">
        <span className="task-row-title">{task.title}</span>
        <span className="task-row-meta">
          <span>{label(task.priority)}</span>
          <span>{label(task.status)}</span>
        </span>
      </span>
      <ChevronRightIcon aria-hidden="true" className="task-row-chevron" />
    </button>
  );
}

function SelectField({
  id,
  labelText,
  value,
  values,
  onChange,
}: {
  id: string;
  labelText: string;
  value: string;
  values: string[];
  onChange(value: string): void;
}) {
  return (
    <label className="task-field">
      <span>{labelText}</span>
      <select
        id={id}
        aria-label={labelText}
        className="tasks-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {values.map((item) => <option key={item} value={item}>{label(item)}</option>)}
      </select>
    </label>
  );
}

export function TasksView({
  tasks,
  sessions,
  selectedTaskID,
  loading = false,
  error = "",
  refinement = null,
  refining = false,
  onSelectTask,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onStartAgent,
  onOpenTerminal,
  onRefineTask,
  onApplyRefinement,
  onPromptTask,
}: TasksViewProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<TaskCreateInput>({
    title: "",
    description: "",
    priority: "medium",
    status: "todo",
  });
  const [agentDraft, setAgentDraft] = useState<"claude" | "codex">("claude");
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState<TaskUpdateInput>({});
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskID) ?? tasks[0] ?? null,
    [selectedTaskID, tasks],
  );
  const openTasks = tasks.filter((task) => task.status !== "done");
  const doneTasks = tasks.filter((task) => task.status === "done");
  const linkedSession = selectedTask?.terminalId
    ? sessions.find((session) => session.id === selectedTask.terminalId)
    : undefined;
  const defaultCWD = linkedSession?.cwd ?? sessions[0]?.cwd ?? "";

  useEffect(() => {
    if (!selectedTask) {
      setDraft({});
      return;
    }
    setDraft({
      title: selectedTask.title,
      description: selectedTask.description,
      priority: selectedTask.priority,
      status: selectedTask.status,
    });
    setInstruction("");
  }, [selectedTask]);

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!createDraft.title.trim()) return;
    await onCreateTask({
      ...createDraft,
      title: createDraft.title.trim(),
      description: createDraft.description.trim(),
    });
    setCreateDraft({ title: "", description: "", priority: "medium", status: "todo" });
    setCreateOpen(false);
  }

  async function saveTask() {
    if (!selectedTask || !draft.title?.trim()) return;
    await onUpdateTask(selectedTask.id, {
      ...draft,
      title: draft.title.trim(),
      description: draft.description?.trim() ?? "",
    });
  }

  async function sendInstruction(event: FormEvent) {
    event.preventDefault();
    if (!selectedTask || !instruction.trim()) return;
    await onPromptTask(selectedTask.id, instruction.trim());
    setInstruction("");
  }

  return (
    <main className="tasks-view" aria-labelledby="tasks-view-title">
      <header className="tasks-view-header">
        <div>
          <p className="tasks-view-eyebrow">Workspace / Tasks</p>
          <h1 id="tasks-view-title">Tasks</h1>
          <p>Turn a clear piece of work into an agent-ready terminal session.</p>
        </div>
        <div className="tasks-view-actions">
          <div className="tasks-view-count" aria-label={`${openTasks.length} open tasks`}>
            <strong>{openTasks.length}</strong>
            <span>open</span>
          </div>
          <Button type="button" className="tasks-new-button" onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden="true" />
            <span>New task</span>
          </Button>
        </div>
      </header>
      {loading && <p className="tasks-loading" role="status" aria-label="Loading tasks">Reading task list…</p>}
      {error && <p className="tasks-error" role="alert">{error}</p>}
      {!loading && tasks.length === 0 && <p className="tasks-empty">No tasks yet.</p>}
      {tasks.length > 0 && (
        <div className="tasks-layout">
          <aside className="tasks-queue" aria-label="Task queue">
            <section className="tasks-queue-section" aria-labelledby="open-tasks-title" role="region">
              <div className="tasks-queue-heading"><h2 id="open-tasks-title">Open tasks</h2><span>{openTasks.length}</span></div>
              {openTasks.length > 0 ? openTasks.map((task) => (
                <TaskRow key={task.id} task={task} selected={task.id === selectedTask?.id} onSelect={onSelectTask} />
              )) : <p className="tasks-queue-empty">Nothing in progress.</p>}
            </section>
            <section className="tasks-queue-section" aria-labelledby="done-tasks-title" role="region">
              <div className="tasks-queue-heading"><h2 id="done-tasks-title">Done tasks</h2><span>{doneTasks.length}</span></div>
              {doneTasks.length > 0 ? doneTasks.map((task) => (
                <TaskRow key={task.id} task={task} selected={task.id === selectedTask?.id} onSelect={onSelectTask} />
              )) : <p className="tasks-queue-empty">No completed tasks.</p>}
            </section>
          </aside>
          {selectedTask ? (
            <section className="task-detail" aria-label="Task detail">
              <header className="task-detail-header">
                <div>
                  <p className="task-detail-eyebrow">Task / {selectedTask.id.slice(0, 8)}</p>
                  <div className="task-detail-status-line">
                    <span className={`task-priority task-priority-${selectedTask.priority}`}>{label(selectedTask.priority)}</span>
                    <span>{label(selectedTask.status)}</span>
                    {selectedTask.agent && <span>{selectedTask.agent}</span>}
                  </div>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => void onDeleteTask(selectedTask.id)}>Delete</Button>
              </header>
              <div className="task-detail-fields">
                <label className="task-field task-field-wide">
                  <span>Title</span>
                  <Input value={draft.title ?? ""} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
                </label>
                <label className="task-field task-field-wide">
                  <span>Description</span>
                  <Textarea value={draft.description ?? ""} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
                </label>
                <div className="task-field-row">
                  <SelectField id="task-priority" labelText="Priority" value={draft.priority ?? selectedTask.priority} values={priorities} onChange={(value) => setDraft((current) => ({ ...current, priority: value as TaskPriority }))} />
                  <SelectField id="task-status" labelText="Status" value={draft.status ?? selectedTask.status} values={statuses} onChange={(value) => setDraft((current) => ({ ...current, status: value as TaskStatus }))} />
                </div>
                <div className="task-detail-actions">
                  <Button type="button" onClick={() => void saveTask()}>Save changes</Button>
                  {selectedTask.terminalId && <Button type="button" variant="outline" onClick={() => onOpenTerminal(selectedTask.terminalId!)}><TerminalIcon aria-hidden="true" />Open terminal</Button>}
                  {!selectedTask.terminalId && <span className="task-no-terminal">No agent terminal linked.</span>}
                </div>
              </div>
              <section className="task-agent-tools" aria-labelledby="task-agent-tools-title">
                <div className="task-section-heading"><div><p className="task-detail-eyebrow">Execution</p><h2 id="task-agent-tools-title">Agent terminal</h2></div><BotIcon aria-hidden="true" /></div>
                <div className="task-agent-start-row">
                  <label className="task-field">
                    <span>Agent to start</span>
                    <select aria-label="Agent to start" className="tasks-select" value={agentDraft} onChange={(event) => setAgentDraft(event.target.value as "claude" | "codex")}>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                    </select>
                  </label>
                  <Button type="button" disabled={selectedTask.status === "done"} onClick={() => void onStartAgent(selectedTask.id, { agent: agentDraft, cwd: defaultCWD })}>Start agent</Button>
                </div>
              </section>
              <section className="task-refinement" aria-labelledby="task-refinement-title">
                <div className="task-section-heading"><div><p className="task-detail-eyebrow">Planning pass</p><h2 id="task-refinement-title">AI refinement</h2></div><SparklesIcon aria-hidden="true" /></div>
                <Button type="button" variant="outline" disabled={refining} onClick={() => void onRefineTask(selectedTask.id)}>{refining ? "Refining…" : "Refine with AI"}</Button>
                {refinement && (
                  <div className="task-refinement-proposal" role="region" aria-label="AI refinement proposal">
                    <p className="task-detail-eyebrow">Proposal</p>
                    <h3>{refinement.title}</h3>
                    <p>{refinement.description}</p>
                    <div className="task-row-meta"><span>{label(refinement.priority)}</span><span>{label(refinement.status)}</span></div>
                    {refinement.rationale && <p className="task-refinement-rationale">{refinement.rationale}</p>}
                    <Button type="button" onClick={() => void onApplyRefinement(selectedTask.id, refinement)}>Apply refinement</Button>
                  </div>
                )}
              </section>
              <section className="task-activity" aria-labelledby="task-activity-title">
                <div className="task-section-heading"><div><p className="task-detail-eyebrow">Trace</p><h2 id="task-activity-title">Activity</h2></div><CheckIcon aria-hidden="true" /></div>
                <div className="task-update-list">
                  {(selectedTask.updates ?? []).map((update) => <article key={update.id} className={`task-update task-update-${update.kind}`}><span>{label(update.kind)}</span><p>{update.body}</p></article>)}
                  {(selectedTask.updates ?? []).length === 0 && <p className="task-queue-empty">No activity yet.</p>}
                </div>
                <form className="task-instruction-form" onSubmit={(event) => void sendInstruction(event)}>
                  <label className="task-field task-field-wide" htmlFor="task-instruction"><span>Instruction for agent</span><Textarea id="task-instruction" aria-label="Instruction for agent" placeholder="Tell the linked agent what to do next…" value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={!selectedTask.terminalId} /></label>
                  <Button type="submit" disabled={!selectedTask.terminalId || !instruction.trim()}>Send instruction</Button>
                </form>
              </section>
            </section>
          ) : <p className="tasks-empty">Select a task to see its details.</p>}
        </div>
      )}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="task-create-dialog">
          <DialogHeader><DialogTitle>New task</DialogTitle><DialogDescription>Describe the work before you hand it to an agent.</DialogDescription></DialogHeader>
          <form className="task-create-form" onSubmit={(event) => void submitCreate(event)}>
            <label className="task-field"><span>Title</span><Input autoFocus value={createDraft.title} onChange={(event) => setCreateDraft((current) => ({ ...current, title: event.target.value }))} /></label>
            <label className="task-field"><span>Description</span><Textarea value={createDraft.description} onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))} /></label>
            <SelectField id="new-task-priority" labelText="Priority" value={createDraft.priority} values={priorities} onChange={(value) => setCreateDraft((current) => ({ ...current, priority: value as TaskPriority }))} />
            <DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit">Create task</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
