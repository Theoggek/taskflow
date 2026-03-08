import { useState, useEffect, useRef, useCallback } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ─── Types ────────────────────────────────────────────────────────────────────
type Priority = "low" | "medium" | "high";
type Filter = "all" | "active" | "done";
type SortBy = "created" | "dueDate" | "priority";
type RecurInterval = "none" | "daily" | "weekly";
type TimerMode = "pomodoro" | "stopwatch" | "countdown";

interface Subtask {
  id: string; text: string; completed: boolean;
  priority: Priority; dueDate: string; createdAt: number; totalTimeMs: number;
}

interface Todo {
  id: string; text: string; notes: string; completed: boolean;
  priority: Priority; dueDate: string; tags: string[];
  subtasks: Subtask[]; recur: RecurInterval; lastReset: string;
  createdAt: number; totalTimeMs: number; timeGoalMs: number;
}

interface Toast { id: string; message: string; undoFn?: () => void; }

interface ActiveTimer {
  todoId: string; mode: TimerMode;
  running: boolean; elapsed: number; // ms
  target: number; // ms (0 = unlimited for stopwatch)
  startedAt: number | null; // Date.now() when last started
  phase: "work" | "break"; pomodoroCount: number;
  countdownMinutes: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const PRIORITY_CONFIG: Record<Priority, { label: string; dot: string; weight: number }> = {
  high:   { label: "High",   dot: "#f87171", weight: 3 },
  medium: { label: "Medium", dot: "#f59e0b", weight: 2 },
  low:    { label: "Low",    dot: "#34d399", weight: 1 },
};
const TAG_COLORS = ["#4f8ef7","#a78bfa","#34d399","#f59e0b","#f87171","#60a5fa","#f472b6"];
const POMODORO_WORK = 25 * 60 * 1000;
const POMODORO_BREAK = 5 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function tagColor(tag: string) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = tag.charCodeAt(i) + ((h << 5) - h);
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
}

function fmtTotalTime(ms: number) {
  if (!ms) return null;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m logged`;
  return `${Math.floor(m/60)}h ${m%60}m logged`;
}

function fmtDuration(ms: number) {
  if (!ms) return "0m";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m/60)}h ${m % 60 > 0 ? (m%60)+"m" : ""}`.trim();
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default")
    Notification.requestPermission();
}

function sendNotification(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted")
    new Notification(title, { body, icon: "/favicon.ico" });
}

function scheduleNotification(todo: Todo) {
  if (!todo.dueDate || !("Notification" in window) || Notification.permission !== "granted") return;
  const due = new Date(todo.dueDate + "T09:00:00");
  const dayBefore = new Date(due); dayBefore.setDate(dayBefore.getDate() - 1);
  [due, dayBefore].forEach(target => {
    const ms = target.getTime() - Date.now();
    if (ms > 0 && ms < 7 * 86400000)
      setTimeout(() => sendNotification("TaskFlow Reminder",
        `${target === dayBefore ? "Due tomorrow: " : "Due today: "}${todo.text}`), ms);
  });
}

function shouldRecurReset(todo: Todo) {
  if (todo.recur === "none" || !todo.completed) return false;
  const last = new Date(todo.lastReset || today());
  const now = new Date();
  if (todo.recur === "daily") return now.toDateString() !== last.toDateString();
  if (todo.recur === "weekly") return (now.getTime() - last.getTime()) / 86400000 >= 7;
  return false;
}

// ─── ProgressRing ─────────────────────────────────────────────────────────────
function ProgressRing({ pct, size = 56, stroke = 4, color = "#4f8ef7" }: {
  pct: number; size?: number; stroke?: number; color?: string;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * Math.min(pct, 1);
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#2a3347" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color}
        strokeWidth={stroke} strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round" style={{ transition: "stroke-dasharray 0.5s ease" }} />
    </svg>
  );
}

// ─── Confetti ─────────────────────────────────────────────────────────────────
function Confetti({ onDone }: { onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2800); return () => clearTimeout(t); }, [onDone]);
  const pieces = Array.from({ length: 32 }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    color: ["#4f8ef7","#f87171","#34d399","#f59e0b","#a78bfa","#f472b6"][i % 6],
    delay: Math.random() * 0.6,
    size: 6 + Math.random() * 8,
  }));
  return (
    <div className="confetti-overlay" aria-hidden="true">
      {pieces.map(p => (
        <div key={p.id} className="confetti-piece"
          style={{ left: `${p.x}%`, background: p.color, width: p.size, height: p.size,
            animationDelay: `${p.delay}s` }} />
      ))}
      <div className="confetti-msg">🎉 Task Complete! Great work!</div>
    </div>
  );
}

// ─── TaskTimer ────────────────────────────────────────────────────────────────
function TaskTimer({
  timer, onStart, onStop, onReset, onChangeMode, onChangeCountdown,
}: {
  timer: ActiveTimer;
  onStart: () => void; onStop: () => void; onReset: () => void;
  onChangeMode: (m: TimerMode) => void;
  onChangeCountdown: (mins: number) => void;
}) {
  const isPomodoro = timer.mode === "pomodoro";
  const isStopwatch = timer.mode === "stopwatch";
  const isCountdown = timer.mode === "countdown";

  const target = isPomodoro
    ? (timer.phase === "work" ? POMODORO_WORK : POMODORO_BREAK)
    : isCountdown ? timer.target : 0;

  const display = isPomodoro
    ? fmtTime(Math.max(0, target - timer.elapsed))
    : isCountdown
    ? fmtTime(Math.max(0, target - timer.elapsed))
    : fmtTime(timer.elapsed);

  const pct = target > 0 ? timer.elapsed / target : 0;
  const ringColor = timer.phase === "break" ? "#34d399"
    : timer.running ? "#4f8ef7" : "#6b7a99";

  return (
    <div className={`task-timer ${timer.running ? "running" : ""} ${timer.phase === "break" ? "break-phase" : ""}`}>
      <div className="timer-mode-tabs">
        {(["pomodoro","stopwatch","countdown"] as TimerMode[]).map(m => (
          <button key={m} className={`timer-tab ${timer.mode === m ? "active" : ""}`}
            onClick={() => onChangeMode(m)} disabled={timer.running}>
            {m === "pomodoro" ? "🍅 Pomodoro" : m === "stopwatch" ? "⏱ Stopwatch" : "⏳ Countdown"}
          </button>
        ))}
      </div>

      <div className="timer-body">
        <div className="timer-ring-wrap">
          <ProgressRing pct={pct} size={96} stroke={6} color={ringColor} />
          <div className="timer-display">
            <span className="timer-time">{display}</span>
            {isPomodoro && (
              <span className="timer-phase-label">
                {timer.phase === "work" ? `Focus #${timer.pomodoroCount + 1}` : "☕ Break"}
              </span>
            )}
          </div>
        </div>

        <div className="timer-controls">
          {isCountdown && !timer.running && timer.elapsed === 0 && (
            <div className="countdown-setup">
              <label className="timer-label">Minutes</label>
              <input type="number" className="countdown-input" min={1} max={120}
                value={timer.countdownMinutes}
                onChange={e => onChangeCountdown(Math.max(1, parseInt(e.target.value) || 25))} />
            </div>
          )}
          <div className="timer-btns">
            {timer.running
              ? <button className="timer-btn stop" onClick={onStop}>⏸ Pause</button>
              : <button className="timer-btn start" onClick={onStart}>▶ Start</button>}
            <button className="timer-btn reset" onClick={onReset} disabled={timer.running && timer.elapsed === 0}>
              ↺ Reset
            </button>
          </div>
          {isPomodoro && (
            <p className="pomodoro-hint">
              {timer.phase === "work"
                ? `${POMODORO_WORK / 60000}min focus → ${POMODORO_BREAK / 60000}min break`
                : "Break time! Stretch, breathe, hydrate 💧"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SubtaskItem ──────────────────────────────────────────────────────────────
function SubtaskItem({ subtask, onToggle, onDelete, onSave, timer, onTimerStart, onTimerStop, onTimerReset, onTimerChangeMode, onTimerChangeCountdown }: {
  subtask: Subtask;
  onToggle: (id: string) => void; onDelete: (id: string) => void;
  onSave: (id: string, text: string, priority: Priority, dueDate: string) => void;
  timer: ActiveTimer | null;
  onTimerStart: (id: string, mode: TimerMode, mins: number) => void;
  onTimerStop: (id: string) => void; onTimerReset: (id: string) => void;
  onTimerChangeMode: (id: string, mode: TimerMode) => void;
  onTimerChangeCountdown: (id: string, mins: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showTimer, setShowTimer] = useState(false);
  const [eText, setEText] = useState(subtask.text);
  const [ePri, setEPri] = useState<Priority>(subtask.priority);
  const [eDue, setEDue] = useState(subtask.dueDate);
  const ref = useRef<HTMLInputElement>(null);
  const timerActive = timer?.running;
  const save = () => { if (eText.trim()) onSave(subtask.id, eText.trim(), ePri, eDue); setEditing(false); };
  const overdue = subtask.dueDate && !subtask.completed && subtask.dueDate < today();

  useEffect(() => { if (timerActive) setShowTimer(true); }, [timerActive]);

  return (
    <div className={`subtask-item ${subtask.completed ? "completed" : ""} ${timerActive ? "timer-active" : ""}`}>
      <div className="subtask-main-row">
        <button className={`check-btn small ${subtask.completed ? "checked" : ""}`} onClick={() => onToggle(subtask.id)} />
        {editing ? (
          <div className="edit-section compact">
            <input ref={ref} className="edit-input" value={eText} onChange={e => setEText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
            <div className="edit-row">
              <div className="priority-select">
                {(["low","medium","high"] as Priority[]).map(p => (
                  <button key={p} className={`pri-btn small ${ePri === p ? "active" : ""}`}
                    onClick={() => setEPri(p)} style={{"--dot": PRIORITY_CONFIG[p].dot} as React.CSSProperties}>
                    {PRIORITY_CONFIG[p].label}
                  </button>
                ))}
              </div>
              <input type="date" className="date-input" value={eDue} onChange={e => setEDue(e.target.value)} />
              <button className="save-btn" onClick={save}>Save</button>
              <button className="cancel-btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="subtask-content">
            <div className="subtask-top-row">
              <span className="todo-text">{subtask.text}</span>
              {timerActive && <span className="timer-running-badge" style={{fontSize:"0.65rem"}}>⏱ {fmtTime(timer!.elapsed)}</span>}
            </div>
            <div className="todo-meta">
              <span className="priority-badge" style={{"--dot": PRIORITY_CONFIG[subtask.priority].dot} as React.CSSProperties}>
                {PRIORITY_CONFIG[subtask.priority].label}
              </span>
              {subtask.dueDate && <span className={`due-date ${overdue ? "overdue" : ""}`}>{overdue ? "Overdue · " : ""}{subtask.dueDate}</span>}
              {subtask.totalTimeMs > 0 && <span className="time-logged">{fmtDuration(subtask.totalTimeMs)}</span>}
            </div>
          </div>
        )}
        {!editing && (
          <div className="item-actions">
            <button className={`timer-toggle-btn small ${timerActive ? "pulsing" : ""}`}
              onClick={() => setShowTimer(t => !t)} title="Subtask timer">
              ⏱ {showTimer ? "Hide" : "Timer"}
            </button>
            <button className="edit-btn" onClick={() => { setEditing(true); setTimeout(() => ref.current?.focus(), 50); }}>✎</button>
            <button className="delete-btn" onClick={() => onDelete(subtask.id)}>✕</button>
          </div>
        )}
      </div>

      {showTimer && !editing && (
        <div className="subtask-timer-wrap">
          <TaskTimer
            timer={timer ?? { todoId: subtask.id, mode: "pomodoro", running: false, elapsed: 0, target: POMODORO_WORK, startedAt: null, phase: "work", pomodoroCount: 0, countdownMinutes: 25 }}
            onStart={() => onTimerStart(subtask.id, timer?.mode ?? "pomodoro", timer?.countdownMinutes ?? 25)}
            onStop={() => onTimerStop(subtask.id)}
            onReset={() => onTimerReset(subtask.id)}
            onChangeMode={m => onTimerChangeMode(subtask.id, m)}
            onChangeCountdown={mins => onTimerChangeCountdown(subtask.id, mins)}
          />
        </div>
      )}
    </div>
  );
}

// ─── SortableItem ─────────────────────────────────────────────────────────────
function SortableItem({
  todo, onToggle, onDelete, onSave, onAddSubtask, onToggleSubtask,
  onDeleteSubtask, onSaveSubtask, allTags, timer, onTimerStart,
  onTimerStop, onTimerReset, onTimerChangeMode, onTimerChangeCountdown,
  subtaskTimers, onSubtaskTimerStart, onSubtaskTimerStop,
  onSubtaskTimerReset, onSubtaskTimerChangeMode, onSubtaskTimerChangeCountdown,
  onSaveTimeGoal,
}: {
  todo: Todo; onToggle: (id: string) => void; onDelete: (id: string) => void;
  onSave: (id: string, updates: Partial<Todo>) => void;
  onAddSubtask: (todoId: string, subtask: Subtask) => void;
  onToggleSubtask: (todoId: string, subtaskId: string) => void;
  onDeleteSubtask: (todoId: string, subtaskId: string) => void;
  onSaveSubtask: (todoId: string, subtaskId: string, text: string, priority: Priority, dueDate: string) => void;
  allTags: string[]; timer: ActiveTimer | null;
  onTimerStart: (id: string, mode: TimerMode, mins: number) => void;
  onTimerStop: (id: string) => void; onTimerReset: (id: string) => void;
  onTimerChangeMode: (id: string, mode: TimerMode) => void;
  onTimerChangeCountdown: (id: string, mins: number) => void;
  subtaskTimers: Record<string, ActiveTimer>;
  onSubtaskTimerStart: (subtaskId: string, mode: TimerMode, mins: number) => void;
  onSubtaskTimerStop: (todoId: string, subtaskId: string) => void;
  onSubtaskTimerReset: (subtaskId: string) => void;
  onSubtaskTimerChangeMode: (subtaskId: string, mode: TimerMode) => void;
  onSubtaskTimerChangeCountdown: (subtaskId: string, mins: number) => void;
  onSaveTimeGoal: (todoId: string, goalMs: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);
  const [editNotes, setEditNotes] = useState(todo.notes);
  const [editPriority, setEditPriority] = useState<Priority>(todo.priority);
  const [editDueDate, setEditDueDate] = useState(todo.dueDate);
  const [editTags, setEditTags] = useState<string[]>(todo.tags);
  const [editRecur, setEditRecur] = useState<RecurInterval>(todo.recur);
  const [newTag, setNewTag] = useState("");
  const [newSubText, setNewSubText] = useState("");
  const [newSubPriority, setNewSubPriority] = useState<Priority>("medium");
  const [newSubDue, setNewSubDue] = useState("");
  const [showTimer, setShowTimer] = useState(false);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // Compute combined time: task own time + all subtask time
  const subtaskTotalMs = todo.subtasks.reduce((a, s) => a + (s.totalTimeMs || 0), 0);
  const combinedTimeMs = (todo.totalTimeMs || 0) + subtaskTotalMs;
  const goalMs = todo.timeGoalMs || 0;
  const timePct = goalMs > 0 ? Math.min(combinedTimeMs / goalMs, 1) : 0;
  const overGoal = goalMs > 0 && combinedTimeMs > goalMs;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: todo.id });

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 999 : 1 };

  const handleEdit = () => {
    setEditing(true); setExpanded(true);
    setEditText(todo.text); setEditNotes(todo.notes);
    setEditPriority(todo.priority); setEditDueDate(todo.dueDate);
    setEditTags([...todo.tags]); setEditRecur(todo.recur);
    setTimeout(() => editRef.current?.focus(), 50);
  };

  const handleSave = () => {
    if (!editText.trim()) return;
    onSave(todo.id, { text: editText.trim(), notes: editNotes, priority: editPriority, dueDate: editDueDate, tags: editTags, recur: editRecur });
    setEditing(false);
  };

  const addSubtask = () => {
    if (!newSubText.trim()) return;
    onAddSubtask(todo.id, { id: crypto.randomUUID(), text: newSubText.trim(), completed: false, priority: newSubPriority, dueDate: newSubDue, createdAt: Date.now(), totalTimeMs: 0 });
    setNewSubText(""); setNewSubDue("");
  };

  const isOverdue = todo.dueDate && !todo.completed && todo.dueDate < today();
  const subDone = todo.subtasks.filter(s => s.completed).length;
  const subTotal = todo.subtasks.length;
  const timerActive = timer?.running;

  // Auto-expand timer panel when timer is running
  useEffect(() => { if (timerActive) { setExpanded(true); setShowTimer(true); } }, [timerActive]);

  return (
    <div ref={setNodeRef} style={style}
      className={`todo-item ${todo.completed ? "completed" : ""} priority-${todo.priority} ${expanded ? "expanded" : ""} ${timerActive ? "timer-active" : ""}`}>
      <div className="todo-main-row">
        <div className="drag-handle" {...attributes} {...listeners} title="Drag to reorder">⠿</div>
        <button className={`check-btn ${todo.completed ? "checked" : ""}`}
          onClick={() => onToggle(todo.id)} title={todo.completed ? "Mark incomplete" : "Mark complete"} />

        {editing ? (
          <div className="edit-section">
            <input ref={editRef} className="edit-input" value={editText}
              onChange={e => setEditText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }} />
            <textarea className="notes-input" placeholder="Add notes..." value={editNotes}
              onChange={e => setEditNotes(e.target.value)} rows={2} />
            <div className="edit-row">
              <div className="priority-select">
                {(["low","medium","high"] as Priority[]).map(p => (
                  <button key={p} className={`pri-btn ${editPriority === p ? "active" : ""}`}
                    onClick={() => setEditPriority(p)} style={{"--dot": PRIORITY_CONFIG[p].dot} as React.CSSProperties}>
                    {PRIORITY_CONFIG[p].label}
                  </button>
                ))}
              </div>
              <input type="date" className="date-input" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} />
              <select className="recur-select" value={editRecur} onChange={e => setEditRecur(e.target.value as RecurInterval)}>
                <option value="none">No recur</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="tag-edit-row">
              <div className="tag-list">
                {editTags.map(t => (
                  <span key={t} className="tag" style={{"--tc": tagColor(t)} as React.CSSProperties}>
                    {t} <button className="tag-remove" onClick={() => setEditTags(prev => prev.filter(x => x !== t))}>×</button>
                  </span>
                ))}
              </div>
              <input className="tag-input" placeholder="Add tag…" value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => {
                  if ((e.key === "Enter" || e.key === ",") && newTag.trim()) {
                    e.preventDefault();
                    const t = newTag.trim().toLowerCase();
                    if (!editTags.includes(t)) setEditTags(prev => [...prev, t]);
                    setNewTag("");
                  }
                }} />
              {allTags.filter(t => !editTags.includes(t) && t.includes(newTag)).slice(0,4).map(t => (
                <button key={t} className="tag-suggest" onClick={() => { setEditTags(prev => [...prev, t]); setNewTag(""); }}>{t}</button>
              ))}
            </div>
            <div className="edit-actions">
              <button className="save-btn" onClick={handleSave}>Save</button>
              <button className="cancel-btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="todo-content" onClick={() => setExpanded(e => !e)} style={{ cursor: "pointer" }}>
            <div className="todo-top-row">
              <span className="todo-text">{todo.text}</span>
              {todo.recur !== "none" && <span className="recur-badge">↺ {todo.recur}</span>}
              {timerActive && <span className="timer-running-badge">⏱ {fmtTime(timer!.elapsed)}</span>}
            </div>
            <div className="todo-meta">
              <span className="priority-badge" style={{"--dot": PRIORITY_CONFIG[todo.priority].dot} as React.CSSProperties}>
                {PRIORITY_CONFIG[todo.priority].label}
              </span>
              {todo.dueDate && <span className={`due-date ${isOverdue ? "overdue" : ""}`}>{isOverdue ? "Overdue · " : ""}{todo.dueDate}</span>}
              {subTotal > 0 && <span className="subtask-count">{subDone}/{subTotal} subtasks</span>}
              {fmtTotalTime(todo.totalTimeMs) && <span className="time-logged">{fmtTotalTime(todo.totalTimeMs)}</span>}
              {todo.tags.map(t => <span key={t} className="tag small" style={{"--tc": tagColor(t)} as React.CSSProperties}>{t}</span>)}
            </div>
          </div>
        )}

        {!editing && (
          <div className="item-actions">
            <button className={`timer-toggle-btn ${timerActive ? "pulsing" : ""}`}
              onClick={() => { setExpanded(true); setShowTimer(t => !t); }}
              title={showTimer ? "Hide timer" : "Show timer"}>⏱ {showTimer ? "Hide" : "Timer"}</button>
            <button className="expand-btn" onClick={() => setExpanded(e => !e)}>{expanded ? "▲" : "▼"}</button>
            <button className="edit-btn" onClick={handleEdit}>✎</button>
            <button className="delete-btn" onClick={() => onDelete(todo.id)}>✕</button>
          </div>
        )}
      </div>

      {expanded && !editing && (
        <div className="todo-expanded">
          {todo.notes && <p className="notes-display">{todo.notes}</p>}

          {/* Timer panel */}
          {showTimer && (
            <TaskTimer
              timer={timer ?? { todoId: todo.id, mode: "pomodoro", running: false, elapsed: 0, target: POMODORO_WORK, startedAt: null, phase: "work", pomodoroCount: 0, countdownMinutes: 25 }}
              onStart={() => onTimerStart(todo.id, timer?.mode ?? "pomodoro", timer?.countdownMinutes ?? 25)}
              onStop={() => onTimerStop(todo.id)}
              onReset={() => onTimerReset(todo.id)}
              onChangeMode={m => onTimerChangeMode(todo.id, m)}
              onChangeCountdown={mins => onTimerChangeCountdown(todo.id, mins)}
            />
          )}

          {/* Time Spent Progress */}
          {(combinedTimeMs > 0 || goalMs > 0) && (
            <div className="time-progress-section">
              <div className="time-progress-header">
                <span className="time-progress-title">⏱ Time Spent on Task</span>
                <div className="time-progress-right">
                  <span className={`time-progress-val ${overGoal ? "over-goal" : ""}`}>
                    {fmtDuration(combinedTimeMs)}
                    {goalMs > 0 && <span className="time-goal-label"> / {fmtDuration(goalMs)} goal</span>}
                  </span>
                  {!editingGoal ? (
                    <button className="goal-edit-btn" onClick={() => { setEditingGoal(true); setGoalInput(goalMs > 0 ? String(Math.round(goalMs/60000)) : ""); }}>
                      {goalMs > 0 ? "✎ goal" : "+ set goal"}
                    </button>
                  ) : (
                    <div className="goal-input-row">
                      <input type="number" className="countdown-input" min={1} max={999} placeholder="mins"
                        value={goalInput} onChange={e => setGoalInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") { onSaveTimeGoal(todo.id, (parseInt(goalInput)||0) * 60000); setEditingGoal(false); }
                          if (e.key === "Escape") setEditingGoal(false);
                        }} autoFocus />
                      <span className="goal-input-label">min</span>
                      <button className="save-btn" style={{padding:"0.2rem 0.5rem", fontSize:"0.75rem"}}
                        onClick={() => { onSaveTimeGoal(todo.id, (parseInt(goalInput)||0) * 60000); setEditingGoal(false); }}>Set</button>
                      {goalMs > 0 && <button className="cancel-btn" style={{padding:"0.2rem 0.5rem", fontSize:"0.75rem"}}
                        onClick={() => { onSaveTimeGoal(todo.id, 0); setEditingGoal(false); }}>Clear</button>}
                      <button className="cancel-btn" style={{padding:"0.2rem 0.5rem", fontSize:"0.75rem"}}
                        onClick={() => setEditingGoal(false)}>✕</button>
                    </div>
                  )}
                </div>
              </div>
              {goalMs > 0 && (
                <div className="time-progress-bar-wrap">
                  <div className="time-progress-bar">
                    <div className={`time-progress-fill ${overGoal ? "over-goal" : ""}`} style={{ width: `${timePct * 100}%` }} />
                  </div>
                  <span className="time-progress-pct">{Math.round(timePct * 100)}%</span>
                </div>
              )}
              {todo.subtasks.some(s => s.totalTimeMs > 0) && (
                <div className="time-breakdown">
                  <span className="time-breakdown-item">Task: {fmtDuration(todo.totalTimeMs || 0)}</span>
                  <span className="time-breakdown-sep">·</span>
                  <span className="time-breakdown-item">Subtasks: {fmtDuration(subtaskTotalMs)}</span>
                </div>
              )}
            </div>
          )}

          {/* Subtasks */}
          <div className="subtasks-section">
            <p className="subtasks-label">Subtasks</p>
            {todo.subtasks.map(s => (
              <SubtaskItem key={s.id} subtask={s}
                onToggle={id => onToggleSubtask(todo.id, id)}
                onDelete={id => onDeleteSubtask(todo.id, id)}
                onSave={(id, text, priority, dueDate) => onSaveSubtask(todo.id, id, text, priority, dueDate)}
                timer={subtaskTimers[s.id] ?? null}
                onTimerStart={onSubtaskTimerStart}
                onTimerStop={(sid) => onSubtaskTimerStop(todo.id, sid)}
                onTimerReset={onSubtaskTimerReset}
                onTimerChangeMode={onSubtaskTimerChangeMode}
                onTimerChangeCountdown={onSubtaskTimerChangeCountdown} />
            ))}
            <div className="add-subtask-row">
              <input className="edit-input" placeholder="Add subtask…" value={newSubText}
                onChange={e => setNewSubText(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addSubtask()} />
              <div className="priority-select">
                {(["low","medium","high"] as Priority[]).map(p => (
                  <button key={p} className={`pri-btn small ${newSubPriority === p ? "active" : ""}`}
                    onClick={() => setNewSubPriority(p)} style={{"--dot": PRIORITY_CONFIG[p].dot} as React.CSSProperties}>
                    {PRIORITY_CONFIG[p].label}
                  </button>
                ))}
              </div>
              <input type="date" className="date-input" value={newSubDue} onChange={e => setNewSubDue(e.target.value)} />
              <button className="save-btn" onClick={addSubtask}>+ Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── StatsPanel ───────────────────────────────────────────────────────────────
function StatsPanel({ todos }: { todos: Todo[] }) {
  const weekAgo = Date.now() - 7 * 86400000;
  const completedThisWeek = todos.filter(t => t.completed && t.createdAt > weekAgo).length;
  const overdue = todos.filter(t => t.dueDate && !t.completed && t.dueDate < today()).length;
  const highPriority = todos.filter(t => !t.completed && t.priority === "high").length;
  const total = todos.length; const done = todos.filter(t => t.completed).length;
  const totalTime = todos.reduce((a, t) => a + (t.totalTimeMs || 0), 0);
  const totalMins = Math.floor(totalTime / 60000);
  return (
    <div className="stats-panel">
      <p className="stats-title">Dashboard</p>
      <div className="stats-grid">
        <div className="stat-card"><span className="stat-val">{completedThisWeek}</span><span className="stat-lbl">Done this week</span></div>
        <div className="stat-card"><span className="stat-val" style={{color:"var(--red)"}}>{overdue}</span><span className="stat-lbl">Overdue</span></div>
        <div className="stat-card"><span className="stat-val">{highPriority}</span><span className="stat-lbl">High Priority</span></div>
        <div className="stat-card"><span className="stat-val">{total > 0 ? Math.round((done/total)*100) : 0}%</span><span className="stat-lbl">Complete</span></div>
        <div className="stat-card"><span className="stat-val">{totalMins < 60 ? `${totalMins}m` : `${Math.floor(totalMins/60)}h${totalMins%60}m`}</span><span className="stat-lbl">Time logged</span></div>
      </div>
    </div>
  );
}

// ─── BrainDump ────────────────────────────────────────────────────────────────
function BrainDump({ onClose, onCapture }: { onClose: () => void; onCapture: (items: string[]) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setTimeout(() => ref.current?.focus(), 50); }, []);

  const capture = () => {
    const items = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (items.length) { onCapture(items); onClose(); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal brain-dump-modal" onClick={e => e.stopPropagation()}>
        <h2>🧠 Brain Dump</h2>
        <p className="brain-dump-hint">Dump everything on your mind — one thought per line. We'll turn them into tasks.</p>
        <textarea ref={ref} className="brain-dump-textarea" placeholder={"Call dentist\nFinish report\nBuy groceries\nEmail Sarah..."} value={text}
          onChange={e => setText(e.target.value)} rows={8} />
        <div className="edit-actions">
          <button className="save-btn" onClick={capture}>Capture as Tasks</button>
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [todos, setTodos] = useState<Todo[]>(() => {
    try { return JSON.parse(localStorage.getItem("taskflow-todos") || "[]"); } catch { return []; }
  });
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [recur, setRecur] = useState<RecurInterval>("none");
  const [filter, setFilter] = useState<Filter>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("created");
  const [search, setSearch] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showStats, setShowStats] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showBrainDump, setShowBrainDump] = useState(false);
  const [celebration, setCelebration] = useState(false);
  const [timers, setTimers] = useState<Record<string, ActiveTimer>>({});
  const [subtaskTimers, setSubtaskTimers] = useState<Record<string, ActiveTimer>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { localStorage.setItem("taskflow-todos", JSON.stringify(todos)); }, [todos]);
  useEffect(() => { requestNotificationPermission(); }, []);

  // Recurring reset
  useEffect(() => {
    setTodos(prev => prev.map(t => shouldRecurReset(t) ? { ...t, completed: false, lastReset: today() } : t));
    const iv = setInterval(() => setTodos(prev => prev.map(t => shouldRecurReset(t) ? { ...t, completed: false, lastReset: today() } : t)), 60000);
    return () => clearInterval(iv);
  }, []);

  // Global timer tick
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      // Tick subtask timers (stopwatch only — just increment elapsed)
      setSubtaskTimers(prev => {
        const next = { ...prev };
        let changed = false;
        Object.keys(next).forEach(id => {
          const t = next[id];
          if (!t.running || t.startedAt === null) return;
          next[id] = { ...t, elapsed: t.elapsed + (Date.now() - t.startedAt), startedAt: Date.now() };
          changed = true;
        });
        return changed ? next : prev;
      });

      setTimers(prev => {
        const next = { ...prev };
        let changed = false;
        Object.keys(next).forEach(id => {
          const t = next[id];
          if (!t.running || t.startedAt === null) return;
          const newElapsed = t.elapsed + (Date.now() - t.startedAt);
          const target = t.mode === "pomodoro"
            ? (t.phase === "work" ? POMODORO_WORK : POMODORO_BREAK)
            : t.mode === "countdown" ? t.target : Infinity;

          if (newElapsed >= target && target !== Infinity) {
            // Phase/timer complete
            if (t.mode === "pomodoro") {
              if (t.phase === "work") {
                sendNotification("🍅 Pomodoro Done!", "Time for a 5-minute break!");
                next[id] = { ...t, elapsed: 0, phase: "break", target: POMODORO_BREAK, startedAt: Date.now(), pomodoroCount: t.pomodoroCount + 1 };
              } else {
                sendNotification("☕ Break Over!", "Ready for the next focus session?");
                next[id] = { ...t, elapsed: 0, phase: "work", target: POMODORO_WORK, startedAt: Date.now() };
              }
            } else {
              // Countdown done
              sendNotification("⏰ Timer Done!", `Countdown finished!`);
              next[id] = { ...t, elapsed: target, running: false, startedAt: null };
              setCelebration(true);
            }
          } else {
            next[id] = { ...t, elapsed: newElapsed, startedAt: Date.now() };
          }
          changed = true;
        });
        return changed ? next : prev;
      });
    }, 500);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "n" || e.key === "N") { e.preventDefault(); inputRef.current?.focus(); }
      if (e.key === "b" || e.key === "B") { e.preventDefault(); setShowBrainDump(true); }
      if (e.key === "?") setShowShortcuts(s => !s);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const showToast = useCallback((message: string, undoFn?: () => void) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, message, undoFn }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const allTags = Array.from(new Set(todos.flatMap(t => t.tags)));

  const addTodo = () => {
    if (!text.trim()) return;
    const t: Todo = { id: crypto.randomUUID(), text: text.trim(), notes, completed: false, priority, dueDate, tags: [...tags], subtasks: [], recur, lastReset: today(), createdAt: Date.now(), totalTimeMs: 0, timeGoalMs: 0 };
    setTodos(prev => [t, ...prev]);
    scheduleNotification(t);
    setText(""); setNotes(""); setDueDate(""); setTags([]); setRecur("none");
    inputRef.current?.focus();
    showToast("Task added");
  };

  const toggleTodo = (id: string) => {
    const todo = todos.find(t => t.id === id);
    const wasCompleted = todo?.completed;
    setTodos(prev => prev.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
    if (!wasCompleted) setCelebration(true);
  };

  const deleteTodo = (id: string) => {
    const deleted = todos.find(t => t.id === id)!;
    setTodos(prev => prev.filter(t => t.id !== id));
    setTimers(prev => { const n = { ...prev }; delete n[id]; return n; });
    showToast(`Deleted "${deleted.text}"`, () => setTodos(prev => [deleted, ...prev]));
  };

  const saveTodo = (id: string, updates: Partial<Todo>) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
    const updated = { ...todos.find(t => t.id === id)!, ...updates };
    if (updates.dueDate) scheduleNotification(updated);
  };

  const addSubtask = (todoId: string, subtask: Subtask) =>
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, subtasks: [...t.subtasks, subtask] } : t));
  const toggleSubtask = (todoId: string, subtaskId: string) =>
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, subtasks: t.subtasks.map(s => s.id === subtaskId ? { ...s, completed: !s.completed } : s) } : t));
  const deleteSubtask = (todoId: string, subtaskId: string) =>
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) } : t));
  const saveSubtask = (todoId: string, subtaskId: string, text: string, priority: Priority, dueDate: string) =>
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, subtasks: t.subtasks.map(s => s.id === subtaskId ? { ...s, text, priority, dueDate } : s) } : t));

  // Timer handlers
  const timerStart = (todoId: string, mode: TimerMode, countdownMinutes: number) => {
    setTimers(prev => {
      const existing = prev[todoId];
      const target = mode === "pomodoro" ? POMODORO_WORK : mode === "countdown" ? countdownMinutes * 60000 : 0;
      return {
        ...prev,
        [todoId]: existing
          ? { ...existing, running: true, startedAt: Date.now() }
          : { todoId, mode, running: true, elapsed: 0, target, startedAt: Date.now(), phase: "work", pomodoroCount: 0, countdownMinutes },
      };
    });
  };

  const timerStop = (todoId: string) => {
    setTimers(prev => {
      const t = prev[todoId];
      if (!t) return prev;
      const elapsed = t.elapsed;
      // Save elapsed time to todo
      setTodos(todos => todos.map(td => td.id === todoId ? { ...td, totalTimeMs: (td.totalTimeMs || 0) + elapsed - (prev[todoId]?.elapsed || 0) } : td));
      return { ...prev, [todoId]: { ...t, running: false, startedAt: null } };
    });
  };

  const timerReset = (todoId: string) => {
    setTimers(prev => {
      const t = prev[todoId];
      if (!t) return prev;
      const target = t.mode === "pomodoro" ? POMODORO_WORK : t.mode === "countdown" ? t.countdownMinutes * 60000 : 0;
      return { ...prev, [todoId]: { ...t, running: false, elapsed: 0, target, startedAt: null, phase: "work" } };
    });
  };

  const timerChangeMode = (todoId: string, mode: TimerMode) => {
    setTimers(prev => {
      const t = prev[todoId];
      const countdownMinutes = t?.countdownMinutes ?? 25;
      const target = mode === "pomodoro" ? POMODORO_WORK : mode === "countdown" ? countdownMinutes * 60000 : 0;
      return { ...prev, [todoId]: { todoId, mode, running: false, elapsed: 0, target, startedAt: null, phase: "work", pomodoroCount: 0, countdownMinutes } };
    });
  };

  const timerChangeCountdown = (todoId: string, mins: number) => {
    setTimers(prev => ({ ...prev, [todoId]: { ...(prev[todoId] ?? { todoId, mode: "countdown", running: false, elapsed: 0, startedAt: null, phase: "work", pomodoroCount: 0, countdownMinutes: mins }), countdownMinutes: mins, target: mins * 60000 } }));
  };

  // Subtask timer handlers
  const subtaskTimerStart = (subtaskId: string, mode: TimerMode, countdownMinutes: number) => {
    setSubtaskTimers(prev => {
      const existing = prev[subtaskId];
      const target = mode === "pomodoro" ? POMODORO_WORK : mode === "countdown" ? countdownMinutes * 60000 : 0;
      return {
        ...prev,
        [subtaskId]: existing
          ? { ...existing, running: true, startedAt: Date.now() }
          : { todoId: subtaskId, mode, running: true, elapsed: 0, target, startedAt: Date.now(), phase: "work", pomodoroCount: 0, countdownMinutes },
      };
    });
  };

  const subtaskTimerStop = (todoId: string, subtaskId: string) => {
    setSubtaskTimers(prev => {
      const t = prev[subtaskId];
      if (!t) return prev;
      const addedMs = t.elapsed - (prev[subtaskId]?.elapsed || 0);
      // Accumulate time into subtask AND parent task
      setTodos(todos => todos.map(td => {
        if (td.id !== todoId) return td;
        return {
          ...td,
          totalTimeMs: (td.totalTimeMs || 0) + addedMs,
          subtasks: td.subtasks.map(s =>
            s.id === subtaskId ? { ...s, totalTimeMs: (s.totalTimeMs || 0) + addedMs } : s
          )
        };
      }));
      return { ...prev, [subtaskId]: { ...t, running: false, startedAt: null } };
    });
  };

  const subtaskTimerReset = (subtaskId: string) => {
    setSubtaskTimers(prev => {
      const t = prev[subtaskId];
      if (!t) return prev;
      const target = t.mode === "pomodoro" ? POMODORO_WORK : t.mode === "countdown" ? t.countdownMinutes * 60000 : 0;
      return { ...prev, [subtaskId]: { ...t, running: false, elapsed: 0, target, startedAt: null, phase: "work" } };
    });
  };

  const subtaskTimerChangeMode = (subtaskId: string, mode: TimerMode) => {
    setSubtaskTimers(prev => {
      const t = prev[subtaskId];
      const countdownMinutes = t?.countdownMinutes ?? 25;
      const target = mode === "pomodoro" ? POMODORO_WORK : mode === "countdown" ? countdownMinutes * 60000 : 0;
      return { ...prev, [subtaskId]: { todoId: subtaskId, mode, running: false, elapsed: 0, target, startedAt: null, phase: "work", pomodoroCount: 0, countdownMinutes } };
    });
  };

  const subtaskTimerChangeCountdown = (subtaskId: string, mins: number) => {
    setSubtaskTimers(prev => ({
      ...prev,
      [subtaskId]: { ...(prev[subtaskId] ?? { todoId: subtaskId, mode: "countdown" as TimerMode, running: false, elapsed: 0, startedAt: null, phase: "work" as const, pomodoroCount: 0, countdownMinutes: mins }), countdownMinutes: mins, target: mins * 60000 }
    }));
  };

  const saveTimeGoal = (todoId: string, goalMs: number) => {
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, timeGoalMs: goalMs } : t));
  };

  const brainDumpCapture = (items: string[]) => {
    const newTodos: Todo[] = items.map(text => ({ id: crypto.randomUUID(), text, notes: "", completed: false, priority: "medium", dueDate: "", tags: [], subtasks: [], recur: "none", lastReset: today(), createdAt: Date.now(), totalTimeMs: 0, timeGoalMs: 0 }));
    setTodos(prev => [...newTodos, ...prev]);
    showToast(`Captured ${newTodos.length} task${newTodos.length > 1 ? "s" : ""} from brain dump`);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id)
      setTodos(items => { const oi = items.findIndex(i => i.id === active.id); const ni = items.findIndex(i => i.id === over.id); return arrayMove(items, oi, ni); });
  };

  const exportCSV = () => {
    const rows = [["Text","Priority","Due Date","Tags","Completed","Notes","Time Logged"],
      ...todos.map(t => [t.text, t.priority, t.dueDate, t.tags.join(";"), t.completed ? "Yes" : "No", t.notes, fmtTotalTime(t.totalTimeMs) || ""])];
    const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "tasks.csv"; a.click();
    showToast("Exported to CSV");
  };

  const copyToClipboard = () => {
    const t = todos.filter(t => !t.completed).map(t => `[ ] ${t.text}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n");
    navigator.clipboard.writeText(t);
    showToast("Copied to clipboard");
  };

  let filtered = todos.filter(t => {
    if (filter === "active" && t.completed) return false;
    if (filter === "done" && !t.completed) return false;
    if (tagFilter && !t.tags.includes(tagFilter)) return false;
    if (search && !t.text.toLowerCase().includes(search.toLowerCase()) && !t.notes.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === "priority") return PRIORITY_CONFIG[b.priority].weight - PRIORITY_CONFIG[a.priority].weight;
    if (sortBy === "dueDate") { if (!a.dueDate) return 1; if (!b.dueDate) return -1; return a.dueDate.localeCompare(b.dueDate); }
    return b.createdAt - a.createdAt;
  });

  const doneCount = todos.filter(t => t.completed).length;
  const totalCount = todos.length;
  const progress = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);
  const overdueCount = todos.filter(t => t.dueDate && !t.completed && t.dueDate < today()).length;
  const activeTimerCount = Object.values(timers).filter(t => t.running).length;

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="brand"><span className="brand-icon">▣</span><span className="brand-name">TaskFlow</span></div>
        <nav className="nav">
          {(["all","active","done"] as Filter[]).map(f => (
            <button key={f} className={`nav-btn ${filter === f && !tagFilter ? "active" : ""}`}
              onClick={() => { setFilter(f); setTagFilter(null); }}>
              <span className="nav-icon">{f === "all" ? "≡" : f === "active" ? "◎" : "✓"}</span>
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="nav-count">{f === "all" ? totalCount : f === "active" ? totalCount - doneCount : doneCount}</span>
            </button>
          ))}
        </nav>

        {overdueCount > 0 && <div className="overdue-alert">⚠ {overdueCount} overdue</div>}
        {activeTimerCount > 0 && <div className="timer-alert">⏱ {activeTimerCount} timer{activeTimerCount > 1 ? "s" : ""} running</div>}

        {allTags.length > 0 && (
          <div className="sidebar-tags">
            <p className="sidebar-section-label">Tags</p>
            {allTags.map(t => (
              <button key={t} className={`tag-nav-btn ${tagFilter === t ? "active" : ""}`}
                onClick={() => setTagFilter(prev => prev === t ? null : t)}>
                <span className="tag-dot" style={{ background: tagColor(t) }} />{t}
              </button>
            ))}
          </div>
        )}

        {totalCount > 0 && (
          <div className="sidebar-progress">
            <div className="progress-label-row"><span>Progress</span><span>{progress}%</span></div>
            <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
          </div>
        )}

        <div className="sidebar-actions">
          <button className="sidebar-action-btn" onClick={() => setShowBrainDump(true)}>🧠 Brain Dump <kbd>B</kbd></button>
          <button className="sidebar-action-btn" onClick={() => setShowStats(s => !s)}>📊 Stats</button>
          <button className="sidebar-action-btn" onClick={exportCSV}>⬇ Export CSV</button>
          <button className="sidebar-action-btn" onClick={copyToClipboard}>⎘ Copy List</button>
          <button className="sidebar-action-btn" onClick={() => setShowShortcuts(s => !s)}>? Shortcuts</button>
        </div>

        {doneCount > 0 && (
          <button className="clear-btn" onClick={() => { setTodos(prev => prev.filter(t => !t.completed)); showToast("Cleared completed tasks"); }}>
            Clear Completed
          </button>
        )}
      </div>

      {/* Main */}
      <div className="main">
        <header className="main-header">
          <div>
            <h1>{tagFilter ? `#${tagFilter}` : filter === "all" ? "All Tasks" : filter === "active" ? "Active Tasks" : "Completed Tasks"}</h1>
            <p className="header-sub">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          </div>
          <div className="header-controls">
            <input className="search-input" placeholder="Search… (N)" value={search}
              ref={inputRef} onChange={e => setSearch(e.target.value)} />
            <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
              <option value="created">Sort: Recent</option>
              <option value="dueDate">Sort: Due Date</option>
              <option value="priority">Sort: Priority</option>
            </select>
          </div>
        </header>

        {showStats && <StatsPanel todos={todos} />}

        <div className="add-section">
          <input className="main-input" placeholder="Add a new task… (Enter)" value={text}
            onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && addTodo()} />
          <textarea className="notes-input" placeholder="Notes (optional)…" value={notes}
            onChange={e => setNotes(e.target.value)} rows={2} />
          <div className="add-row">
            <div className="priority-select">
              {(["low","medium","high"] as Priority[]).map(p => (
                <button key={p} className={`pri-btn ${priority === p ? "active" : ""}`}
                  onClick={() => setPriority(p)} style={{"--dot": PRIORITY_CONFIG[p].dot} as React.CSSProperties}>
                  {PRIORITY_CONFIG[p].label}
                </button>
              ))}
            </div>
            <input type="date" className="date-input" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            <select className="recur-select" value={recur} onChange={e => setRecur(e.target.value as RecurInterval)}>
              <option value="none">No recur</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div className="tag-edit-row">
            <div className="tag-list">
              {tags.map(t => (
                <span key={t} className="tag" style={{"--tc": tagColor(t)} as React.CSSProperties}>
                  {t} <button className="tag-remove" onClick={() => setTags(prev => prev.filter(x => x !== t))}>×</button>
                </span>
              ))}
            </div>
            <input className="tag-input" placeholder="Add tag…" value={newTag}
              onChange={e => setNewTag(e.target.value)}
              onKeyDown={e => {
                if ((e.key === "Enter" || e.key === ",") && newTag.trim()) {
                  e.preventDefault();
                  const t = newTag.trim().toLowerCase();
                  if (!tags.includes(t)) setTags(prev => [...prev, t]);
                  setNewTag("");
                }
              }} />
            {allTags.filter(t => !tags.includes(t) && t.includes(newTag) && newTag).slice(0,4).map(t => (
              <button key={t} className="tag-suggest" onClick={() => { setTags(prev => [...prev, t]); setNewTag(""); }}>{t}</button>
            ))}
          </div>
          <div style={{ display:"flex", justifyContent:"flex-end" }}>
            <button className="add-btn" onClick={addTodo}>+ Add Task</button>
          </div>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filtered.map(t => t.id)} strategy={verticalListSortingStrategy}>
            <div className="todo-list">
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-icon">◎</span>
                  <p>{search ? "No tasks match your search." : filter === "done" ? "No completed tasks yet." : "No tasks here. Add one above."}</p>
                </div>
              ) : filtered.map(todo => (
                <SortableItem key={todo.id} todo={todo}
                  onToggle={toggleTodo} onDelete={deleteTodo} onSave={saveTodo}
                  onAddSubtask={addSubtask} onToggleSubtask={toggleSubtask}
                  onDeleteSubtask={deleteSubtask} onSaveSubtask={saveSubtask}
                  allTags={allTags} timer={timers[todo.id] ?? null}
                  onTimerStart={timerStart} onTimerStop={timerStop}
                  onTimerReset={timerReset} onTimerChangeMode={timerChangeMode}
                  onTimerChangeCountdown={timerChangeCountdown}
                  subtaskTimers={subtaskTimers}
                  onSubtaskTimerStart={subtaskTimerStart}
                  onSubtaskTimerStop={subtaskTimerStop}
                  onSubtaskTimerReset={subtaskTimerReset}
                  onSubtaskTimerChangeMode={subtaskTimerChangeMode}
                  onSubtaskTimerChangeCountdown={subtaskTimerChangeCountdown}
                  onSaveTimeGoal={saveTimeGoal} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.undoFn && <button className="toast-undo" onClick={() => { t.undoFn!(); setToasts(prev => prev.filter(x => x.id !== t.id)); }}>Undo</button>}
          </div>
        ))}
      </div>

      {/* Celebration */}
      {celebration && <Confetti onDone={() => setCelebration(false)} />}

      {/* Brain Dump */}
      {showBrainDump && <BrainDump onClose={() => setShowBrainDump(false)} onCapture={brainDumpCapture} />}

      {/* Shortcuts */}
      {showShortcuts && (
        <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Keyboard Shortcuts</h2>
            <div className="shortcuts-list">
              <div className="shortcut"><kbd>N</kbd><span>Focus task input</span></div>
              <div className="shortcut"><kbd>B</kbd><span>Open Brain Dump</span></div>
              <div className="shortcut"><kbd>Enter</kbd><span>Add task / Save edit</span></div>
              <div className="shortcut"><kbd>Esc</kbd><span>Cancel edit</span></div>
              <div className="shortcut"><kbd>?</kbd><span>Toggle shortcuts</span></div>
            </div>
            <button className="save-btn" style={{marginTop:"0.5rem"}} onClick={() => setShowShortcuts(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
