import { useState, useEffect, useRef } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type Priority = "low" | "medium" | "high";
type Filter = "all" | "active" | "done";

interface Todo {
  id: string;
  text: string;
  completed: boolean;
  priority: Priority;
  dueDate: string;
  createdAt: number;
}

const PRIORITY_CONFIG: Record<Priority, { label: string; dot: string }> = {
  low:    { label: "Low",    dot: "#34d399" },
  medium: { label: "Medium", dot: "#f59e0b" },
  high:   { label: "High",   dot: "#f87171" },
};

function SortableItem({
  todo,
  onToggle,
  onDelete,
  onSave,
}: {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onSave: (id: string, text: string, priority: Priority, dueDate: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);
  const [editPriority, setEditPriority] = useState<Priority>(todo.priority);
  const [editDueDate, setEditDueDate] = useState(todo.dueDate);
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
    setEditText(todo.text);
    setEditPriority(todo.priority);
    setEditDueDate(todo.dueDate);
    setTimeout(() => editRef.current?.focus(), 50);
  };

  const handleSave = () => {
    if (editText.trim()) {
      onSave(todo.id, editText.trim(), editPriority, editDueDate);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditing(false);
  };

  const isOverdue = todo.dueDate && !todo.completed && new Date(todo.dueDate) < new Date();

  return (
    <div ref={setNodeRef} style={style} className={`todo-item ${todo.completed ? "completed" : ""} priority-${todo.priority}`}>
      <div className="drag-handle" {...attributes} {...listeners} title="Drag to reorder">⠿</div>

      <button
        className={`check-btn ${todo.completed ? "checked" : ""}`}
        onClick={() => onToggle(todo.id)}
        title={todo.completed ? "Mark incomplete" : "Mark complete"}
      />

      {editing ? (
        <div className="edit-section">
          <input
            ref={editRef}
            className="edit-input"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="edit-row">
            <div className="priority-select">
              {(["low", "medium", "high"] as Priority[]).map((p) => (
                <button
                  key={p}
                  className={`pri-btn ${editPriority === p ? "active" : ""}`}
                  onClick={() => setEditPriority(p)}
                  style={{ "--dot": PRIORITY_CONFIG[p].dot } as React.CSSProperties}
                >
                  {PRIORITY_CONFIG[p].label}
                </button>
              ))}
            </div>
            <input
              type="date"
              className="date-input"
              value={editDueDate}
              onChange={(e) => setEditDueDate(e.target.value)}
            />
            <button className="save-btn" onClick={handleSave}>Save</button>
            <button className="cancel-btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="todo-content">
          <span className="todo-text">{todo.text}</span>
          <div className="todo-meta">
            <span
              className="priority-badge"
              style={{ "--dot": PRIORITY_CONFIG[todo.priority].dot } as React.CSSProperties}
            >
              {PRIORITY_CONFIG[todo.priority].label}
            </span>
            {todo.dueDate && (
              <span className={`due-date ${isOverdue ? "overdue" : ""}`}>
                {isOverdue ? "Overdue · " : ""}{todo.dueDate}
              </span>
            )}
          </div>
        </div>
      )}

      {!editing && (
        <div className="item-actions">
          <button className="edit-btn" onClick={handleEdit} title="Edit task">✎</button>
          <button className="delete-btn" onClick={() => onDelete(todo.id)} title="Delete task">✕</button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("fun-todos") || "[]");
    } catch {
      return [];
    }
  });
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem("fun-todos", JSON.stringify(todos));
  }, [todos]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const addTodo = () => {
    if (!text.trim()) return;
    const newTodo: Todo = {
      id: crypto.randomUUID(),
      text: text.trim(),
      completed: false,
      priority,
      dueDate,
      createdAt: Date.now(),
    };
    setTodos((prev) => [newTodo, ...prev]);
    setText("");
    setDueDate("");
    inputRef.current?.focus();
  };

  const toggleTodo = (id: string) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));

  const deleteTodo = (id: string) =>
    setTodos((prev) => prev.filter((t) => t.id !== id));

  const saveTodo = (id: string, text: string, priority: Priority, dueDate: string) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, text, priority, dueDate } : t)));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setTodos((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const filtered = todos.filter((t) => {
    if (filter === "active") return !t.completed;
    if (filter === "done") return t.completed;
    return true;
  });

  const doneCount = todos.filter((t) => t.completed).length;
  const totalCount = todos.length;
  const progress = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);

  return (
    <div className="app">
      <div className="sidebar">
        <div className="brand">
          <span className="brand-icon">▣</span>
          <span className="brand-name">TaskFlow</span>
        </div>
        <nav className="nav">
          {(["all", "active", "done"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`nav-btn ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              <span className="nav-icon">
                {f === "all" ? "≡" : f === "active" ? "◎" : "✓"}
              </span>
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="nav-count">
                {f === "all" ? totalCount : f === "active" ? totalCount - doneCount : doneCount}
              </span>
            </button>
          ))}
        </nav>
        {totalCount > 0 && (
          <div className="sidebar-progress">
            <div className="progress-label-row">
              <span>Progress</span>
              <span>{progress}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        {doneCount > 0 && (
          <button
            className="clear-btn"
            onClick={() => setTodos((prev) => prev.filter((t) => !t.completed))}
          >
            Clear Completed
          </button>
        )}
      </div>

      <div className="main">
        <header className="main-header">
          <div>
            <h1>{filter === "all" ? "All Tasks" : filter === "active" ? "Active Tasks" : "Completed Tasks"}</h1>
            <p className="header-sub">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          </div>
        </header>

        <div className="add-section">
          <input
            ref={inputRef}
            className="main-input"
            placeholder="Add a new task..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTodo()}
          />
          <div className="add-row">
            <div className="priority-select">
              {(["low", "medium", "high"] as Priority[]).map((p) => (
                <button
                  key={p}
                  className={`pri-btn ${priority === p ? "active" : ""}`}
                  onClick={() => setPriority(p)}
                  style={{ "--dot": PRIORITY_CONFIG[p].dot } as React.CSSProperties}
                >
                  {PRIORITY_CONFIG[p].label}
                </button>
              ))}
            </div>
            <input
              type="date"
              className="date-input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            <button className="add-btn" onClick={addTodo}>+ Add Task</button>
          </div>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filtered.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className="todo-list">
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-icon">◎</span>
                  <p>{filter === "done" ? "No completed tasks yet." : "No tasks here. Add one above."}</p>
                </div>
              ) : (
                filtered.map((todo) => (
                  <SortableItem
                    key={todo.id}
                    todo={todo}
                    onToggle={toggleTodo}
                    onDelete={deleteTodo}
                    onSave={saveTodo}
                  />
                ))
              )}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
