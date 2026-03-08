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

interface Subtask {
  id: string;
  text: string;
  completed: boolean;
  priority: Priority;
  dueDate: string;
  createdAt: number;
}

interface Todo {
  id: string;
  text: string;
  notes: string;
  completed: boolean;
  priority: Priority;
  dueDate: string;
  tags: string[];
  subtasks: Subtask[];
  recur: RecurInterval;
  lastReset: string; // YYYY-MM-DD
  createdAt: number;
}

interface Toast {
  id: string;
  message: string;
  undoFn?: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const PRIORITY_CONFIG: Record<Priority, { label: string; dot: string; weight: number }> = {
  high:   { label: "High",   dot: "#f87171", weight: 3 },
  medium: { label: "Medium", dot: "#f59e0b", weight: 2 },
  low:    { label: "Low",    dot: "#34d399", weight: 1 },
};

const TAG_COLORS = ["#4f8ef7","#a78bfa","#34d399","#f59e0b","#f87171","#60a5fa","#f472b6"];

const today = () => new Date().toISOString().slice(0, 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function tagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function scheduleNotification(todo: Todo) {
  if (!todo.dueDate || !("Notification" in window) || Notification.permission !== "granted") return;
  const due = new Date(todo.dueDate + "T09:00:00");
  const dayBefore = new Date(due);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const now = new Date();
  [due, dayBefore].forEach((target) => {
    const ms = target.getTime() - now.getTime();
    if (ms > 0 && ms < 7 * 24 * 60 * 60 * 1000) {
      setTimeout(() => {
        new Notification("TaskFlow Reminder", {
          body: `${target === dayBefore ? "Due tomorrow: " : "Due today: "}${todo.text}`,
          icon: "/favicon.ico",
        });
      }, ms);
    }
  });
}

function shouldRecurReset(todo: Todo): boolean {
  if (todo.recur === "none" || !todo.completed) return false;
  const last = new Date(todo.lastReset || today());
  const now = new Date();
  if (todo.recur === "daily") {
    return now.toDateString() !== last.toDateString();
  }
  if (todo.recur === "weekly") {
    const diff = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 7;
  }
  return false;
}

// ─── SubtaskItem ──────────────────────────────────────────────────────────────
function SubtaskItem({
  subtask, onToggle, onDelete, onSave,
}: {
  subtask: Subtask;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onSave: (id: string, text: string, priority: Priority, dueDate: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [eText, setEText] = useState(subtask.text);
  const [ePriority, setEPriority] = useState<Priority>(subtask.priority);
  const [eDueDate, setEDueDate] = useState(subtask.dueDate);
  const ref = useRef<HTMLInputElement>(null);

  const save = () => {
    if (eText.trim()) onSave(subtask.id, eText.trim(), ePriority, eDueDate);
    setEditing(false);
  };

  const isOverdue = subtask.dueDate && !subtask.completed && subtask.dueDate < today();

  return (
    <div className={`subtask-item ${subtask.completed ? "completed" : ""}`}>
      <button className={`check-btn small ${subtask.completed ? "checked" : ""}`} onClick={() => onToggle(subtask.id)} />
      {editing ? (
        <div className="edit-section compact">
          <input ref={ref} className="edit-input" value={eText} onChange={e => setEText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
          <div className="edit-row">
            <div className="priority-select">
              {(["low","medium","high"] as Priority[]).map(p => (
                <button key={p} className={`pri-btn small ${ePriority === p ? "active" : ""}`}
                  onClick={() => setEPriority(p)} style={{"--dot": PRIORITY_CONFIG[p].dot} as React.CSSProperties}>
                  {PRIORITY_CONFIG[p].label}
                </button>
              ))}
            </div>
            <input type="date" className="date-input" value={eDueDate} onChange={e => setEDueDate(e.target.value)} />
            <button className="save-btn" onClick={save}>Save</button>
            <button className="cancel-btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="subtask-content">
          <span className="todo-text">{subtask.text}</span>
          <div className="todo-meta">
            <span className="priority-badge" style={{"--dot": PRIORITY_CONFIG[subtask.priority].dot} as React.CSSProperties}>
              {PRIORITY_CONFIG[subtask.priority].label}
            </span>
            {subtask.dueDate && (
              <span className={`due-date ${isOverdue ? "overdue" : ""}`}>
                {isOverdue ? "Overdue · " : ""}{subtask.dueDate}
              </span>
            )}
          </div>
        </div>
      )}
      {!editing && (
        <div className="item-actions">
          <button className="edit-btn" onClick={() => { setEditing(true); setTimeout(() => ref.current?.focus(), 50); }}>✎</button>
          <button className="delete-btn" onClick={() => onDelete(subtask.id)}>✕</button>
        </div>
      )}
    </div>
  );
}

// ─── SortableItem ─────────────────────────────────────────────────────────────
function SortableItem({
  todo, onToggle, onDelete, onSave, onAddSubtask, onToggleSubtask,
  onDeleteSubtask, onSaveSubtask, allTags,
}: {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onSave: (id: string, updates: Partial<Todo>) => void;
  onAddSubtask: (todoId: string, subtask: Subtask) => void;
  onToggleSubtask: (todoId: string, subtaskId: string) => void;
  onDeleteSubtask: (todoId: string, subtaskId: string) => void;
  onSaveSubtask: (todoId: string, subtaskId: string, text: string, priority: Priority, dueDate: string) => void;
  allTags: string[];
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
  const editRef = useRef<HTMLInputElement>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: todo.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : 1,
  };

  const handleEdit = () => {
    setEditing(true);
    setExpanded(true);
    setEditText(todo.text);
    setEditNotes(todo.notes);
    setEditPriority(todo.priority);
    setEditDueDate(todo.dueDate);
    setEditTags([...todo.tags]);
    setEditRecur(todo.recur);
    setTimeout(() => editRef.current?.focus(), 50);
  };

  const handleSave = () => {
    if (!editText.trim()) return;
    onSave(todo.id, {
      text: editText.trim(),
      notes: editNotes,
      priority: editPriority,
      dueDate: editDueDate,
      tags: editTags,
      recur: editRecur,
    });
    setEditing(false);
  };

  const addSubtask = () => {
    if (!newSubText.trim()) return;
    onAddSubtask(todo.id, {
      id: crypto.randomUUID(),
      text: newSubText.trim(),
      completed: false,
      priority: newSubPriority,
      dueDate: newSubDue,
      createdAt: Date.now(),
    });
    setNewSubText("");
    setNewSubDue("");
  };

  const isOverdue = todo.dueDate && !todo.completed && todo.dueDate < today();
  const subDone = todo.subtasks.filter(s => s.completed).length;
  const subTotal = todo.subtasks.length;

  return (
    <div ref={setNodeRef} style={style}
      className={`todo-item ${todo.completed ? "completed" : ""} priority-${todo.priority} ${expanded ? "expanded" : ""}`}>
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
              {allTags.filter(t => !editTags.includes(t) && t.includes(newTag)).slice(0, 4).map(t => (
                <button key={t} className="tag-suggest" onClick={() => { setEditTags(prev => [...prev, t]); setNewTag(""); }}>
                  {t}
                </button>
              ))}
            </div>
            <div className="edit-actions">
              <button className="save-btn" onClick={handleSave}>Save</button>
              <button className="cancel-btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="todo-content" onClick={() => setExpanded(e => !e)} style={{cursor:"pointer"}}>
            <div className="todo-top-row">
              <span className="todo-text">{todo.text}</span>
              {todo.recur !== "none" && <span className="recur-badge">↺ {todo.recur}</span>}
            </div>
            <div className="todo-meta">
              <span className="priority-badge" style={{"--dot": PRIORITY_CONFIG[todo.priority].dot} as React.CSSProperties}>
                {PRIORITY_CONFIG[todo.priority].label}
              </span>
              {todo.dueDate && (
                <span className={`due-date ${isOverdue ? "overdue" : ""}`}>
                  {isOverdue ? "Overdue · " : ""}{todo.dueDate}
                </span>
              )}
              {subTotal > 0 && (
                <span className="subtask-count">{subDone}/{subTotal} subtasks</span>
              )}
              {todo.tags.map(t => (
                <span key={t} className="tag small" style={{"--tc": tagColor(t)} as React.CSSProperties}>{t}</span>
              ))}
            </div>
          </div>
        )}

        {!editing && (
          <div className="item-actions">
            <button className="expand-btn" onClick={() => setExpanded(e => !e)} title="Expand">
              {expanded ? "▲" : "▼"}
            </button>
            <button className="edit-btn" onClick={handleEdit} title="Edit task">✎</button>
            <button className="delete-btn" onClick={() => onDelete(todo.id)} title="Delete task">✕</button>
          </div>
        )}
      </div>

      {expanded && !editing && (
        <div className="todo-expanded">
          {todo.notes && <p className="notes-display">{todo.notes}</p>}

          {/* Subtasks */}
          <div className="subtasks-section">
            <p className="subtasks-label">Subtasks</p>
            {todo.subtasks.map(s => (
              <SubtaskItem key={s.id} subtask={s}
                onToggle={id => onToggleSubtask(todo.id, id)}
                onDelete={id => onDeleteSubtask(todo.id, id)}
                onSave={(id, text, priority, dueDate) => onSaveSubtask(todo.id, id, text, priority, dueDate)} />
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
  const now = new Date();
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
  const completedThisWeek = todos.filter(t =>
    t.completed && t.createdAt > weekAgo.getTime()
  ).length;
  const overdue = todos.filter(t => t.dueDate && !t.completed && t.dueDate < today()).length;
  const highPriority = todos.filter(t => !t.completed && t.priority === "high").length;
  const total = todos.length;
  const done = todos.filter(t => t.completed).length;

  return (
    <div className="stats-panel">
      <p className="stats-title">This Week</p>
      <div className="stats-grid">
        <div className="stat-card"><span className="stat-val">{completedThisWeek}</span><span className="stat-lbl">Completed</span></div>
        <div className="stat-card"><span className="stat-val">{overdue}</span><span className="stat-lbl overdue">Overdue</span></div>
        <div className="stat-card"><span className="stat-val">{highPriority}</span><span className="stat-lbl">High Priority</span></div>
        <div className="stat-card"><span className="stat-val">{total > 0 ? Math.round((done/total)*100) : 0}%</span><span className="stat-lbl">Done</span></div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [todos, setTodos] = useState<Todo[]>(() => {
    try { return JSON.parse(localStorage.getItem("taskflow-todos") || "[]"); }
    catch { return []; }
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Persist
  useEffect(() => {
    localStorage.setItem("taskflow-todos", JSON.stringify(todos));
  }, [todos]);

  // Request notification permission on mount
  useEffect(() => { requestNotificationPermission(); }, []);

  // Auto-reset recurring tasks
  useEffect(() => {
    setTodos(prev => prev.map(t => {
      if (shouldRecurReset(t)) {
        return { ...t, completed: false, lastReset: today() };
      }
      return t;
    }));
    const interval = setInterval(() => {
      setTodos(prev => prev.map(t => shouldRecurReset(t) ? { ...t, completed: false, lastReset: today() } : t));
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "n" || e.key === "N") { e.preventDefault(); inputRef.current?.focus(); }
      if (e.key === "?") { setShowShortcuts(s => !s); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const showToast = useCallback((message: string, undoFn?: () => void) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, message, undoFn }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const allTags = Array.from(new Set(todos.flatMap(t => t.tags)));

  const addTodo = () => {
    if (!text.trim()) return;
    const newTodo: Todo = {
      id: crypto.randomUUID(),
      text: text.trim(),
      notes,
      completed: false,
      priority,
      dueDate,
      tags: [...tags],
      subtasks: [],
      recur,
      lastReset: today(),
      createdAt: Date.now(),
    };
    setTodos(prev => [newTodo, ...prev]);
    scheduleNotification(newTodo);
    setText(""); setNotes(""); setDueDate(""); setTags([]); setRecur("none");
    inputRef.current?.focus();
    showToast("Task added");
  };

  const toggleTodo = (id: string) =>
    setTodos(prev => prev.map(t => t.id === id ? { ...t, completed: !t.completed } : t));

  const deleteTodo = (id: string) => {
    const deleted = todos.find(t => t.id === id)!;
    setTodos(prev => prev.filter(t => t.id !== id));
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
    setTodos(prev => prev.map(t => t.id === todoId
      ? { ...t, subtasks: t.subtasks.map(s => s.id === subtaskId ? { ...s, completed: !s.completed } : s) }
      : t));

  const deleteSubtask = (todoId: string, subtaskId: string) =>
    setTodos(prev => prev.map(t => t.id === todoId
      ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) }
      : t));

  const saveSubtask = (todoId: string, subtaskId: string, text: string, priority: Priority, dueDate: string) =>
    setTodos(prev => prev.map(t => t.id === todoId
      ? { ...t, subtasks: t.subtasks.map(s => s.id === subtaskId ? { ...s, text, priority, dueDate } : s) }
      : t));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setTodos(items => {
        const oi = items.findIndex(i => i.id === active.id);
        const ni = items.findIndex(i => i.id === over.id);
        return arrayMove(items, oi, ni);
      });
    }
  };

  const exportCSV = () => {
    const rows = [["Text","Priority","Due Date","Tags","Completed","Notes"],
      ...todos.map(t => [t.text, t.priority, t.dueDate, t.tags.join(";"), t.completed ? "Yes" : "No", t.notes])];
    const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tasks.csv"; a.click();
    showToast("Exported to CSV");
  };

  const copyToClipboard = () => {
    const text = todos.filter(t => !t.completed).map(t => `[ ] ${t.text}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n");
    navigator.clipboard.writeText(text);
    showToast("Copied to clipboard");
  };

  // Filter + sort
  let filtered = todos.filter(t => {
    if (filter === "active" && t.completed) return false;
    if (filter === "done" && !t.completed) return false;
    if (tagFilter && !t.tags.includes(tagFilter)) return false;
    if (search && !t.text.toLowerCase().includes(search.toLowerCase()) &&
        !t.notes.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  filtered = [...filtered].sort((a, b) => {
    if (sortBy === "priority") return PRIORITY_CONFIG[b.priority].weight - PRIORITY_CONFIG[a.priority].weight;
    if (sortBy === "dueDate") {
      if (!a.dueDate) return 1; if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    return b.createdAt - a.createdAt;
  });

  const doneCount = todos.filter(t => t.completed).length;
  const totalCount = todos.length;
  const progress = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);
  const overdueCount = todos.filter(t => t.dueDate && !t.completed && t.dueDate < today()).length;

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="brand">
          <span className="brand-icon">▣</span>
          <span className="brand-name">TaskFlow</span>
        </div>

        <nav className="nav">
          {(["all","active","done"] as Filter[]).map(f => (
            <button key={f} className={`nav-btn ${filter === f && !tagFilter ? "active" : ""}`}
              onClick={() => { setFilter(f); setTagFilter(null); }}>
              <span className="nav-icon">{f === "all" ? "≡" : f === "active" ? "◎" : "✓"}</span>
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="nav-count">
                {f === "all" ? totalCount : f === "active" ? totalCount - doneCount : doneCount}
              </span>
            </button>
          ))}
        </nav>

        {overdueCount > 0 && (
          <div className="overdue-alert">⚠ {overdueCount} overdue</div>
        )}

        {allTags.length > 0 && (
          <div className="sidebar-tags">
            <p className="sidebar-section-label">Tags</p>
            {allTags.map(t => (
              <button key={t} className={`tag-nav-btn ${tagFilter === t ? "active" : ""}`}
                onClick={() => setTagFilter(prev => prev === t ? null : t)}>
                <span className="tag-dot" style={{ background: tagColor(t) }} />
                {t}
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
          <button className="sidebar-action-btn" onClick={() => setShowStats(s => !s)}>📊 Stats</button>
          <button className="sidebar-action-btn" onClick={exportCSV}>⬇ Export CSV</button>
          <button className="sidebar-action-btn" onClick={copyToClipboard}>⎘ Copy List</button>
          <button className="sidebar-action-btn" onClick={() => setShowShortcuts(s => !s)}>? Shortcuts</button>
        </div>

        {doneCount > 0 && (
          <button className="clear-btn"
            onClick={() => { setTodos(prev => prev.filter(t => !t.completed)); showToast("Cleared completed tasks"); }}>
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
            <input className="search-input" placeholder="Search tasks… (N to focus)" value={search}
              ref={inputRef} onChange={e => setSearch(e.target.value)} />
            <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
              <option value="created">Sort: Recent</option>
              <option value="dueDate">Sort: Due Date</option>
              <option value="priority">Sort: Priority</option>
            </select>
          </div>
        </header>

        {showStats && <StatsPanel todos={todos} />}

        {/* Add task */}
        <div className="add-section">
          <input className="main-input" placeholder="Add a new task… (Enter to add)"
            value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addTodo()} />
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
          <div style={{display:"flex", justifyContent:"flex-end"}}>
            <button className="add-btn" onClick={addTodo}>+ Add Task</button>
          </div>
        </div>

        {/* Task list */}
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
                  allTags={allTags} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* Toast notifications */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.undoFn && <button className="toast-undo" onClick={() => { t.undoFn!(); setToasts(prev => prev.filter(x => x.id !== t.id)); }}>Undo</button>}
          </div>
        ))}
      </div>

      {/* Keyboard shortcuts modal */}
      {showShortcuts && (
        <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Keyboard Shortcuts</h2>
            <div className="shortcuts-list">
              <div className="shortcut"><kbd>N</kbd><span>Focus task input</span></div>
              <div className="shortcut"><kbd>Enter</kbd><span>Add task / Save edit</span></div>
              <div className="shortcut"><kbd>Escape</kbd><span>Cancel edit</span></div>
              <div className="shortcut"><kbd>?</kbd><span>Toggle this panel</span></div>
            </div>
            <button className="save-btn" onClick={() => setShowShortcuts(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
