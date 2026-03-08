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

const PRIORITY_CONFIG: Record<Priority, { emoji: string; label: string; color: string }> = {
  low: { emoji: "🟢", label: "Low", color: "#6ee7b7" },
  medium: { emoji: "🟡", label: "Medium", color: "#fde68a" },
  high: { emoji: "🔴", label: "High", color: "#fca5a5" },
};

const FILTER_EMOJIS: Record<Filter, string> = {
  all: "🌈",
  active: "⚡",
  done: "✅",
};

function SortableItem({
  todo,
  onToggle,
  onDelete,
}: {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: todo.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : 1,
  };

  const isOverdue =
    todo.dueDate && !todo.completed && new Date(todo.dueDate) < new Date();

  return (
    <div ref={setNodeRef} style={style} className={`todo-item ${todo.completed ? "completed" : ""} priority-${todo.priority}`}>
      <div className="drag-handle" {...attributes} {...listeners}>⠿</div>
      <button
        className={`check-btn ${todo.completed ? "checked" : ""}`}
        onClick={() => onToggle(todo.id)}
      >
        {todo.completed ? "✓" : ""}
      </button>
      <div className="todo-content">
        <span className="todo-text">{todo.text}</span>
        <div className="todo-meta">
          <span className="priority-badge">
            {PRIORITY_CONFIG[todo.priority].emoji} {PRIORITY_CONFIG[todo.priority].label}
          </span>
          {todo.dueDate && (
            <span className={`due-date ${isOverdue ? "overdue" : ""}`}>
              {isOverdue ? "🚨" : "📅"} {todo.dueDate}
            </span>
          )}
        </div>
      </div>
      <button className="delete-btn" onClick={() => onDelete(todo.id)}>
        🗑️
      </button>
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

  const toggleTodo = (id: string) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
    );
  };

  const deleteTodo = (id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  };

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
      <div className="confetti-bg" aria-hidden="true">
        {["🌟", "🎈", "🍭", "🦄", "🎉", "🌈", "🍬", "⭐", "🎊", "💫"].map((e, i) => (
          <span key={i} className="float-emoji" style={{ "--delay": `${i * 0.9}s`, "--x": `${i * 10}%` } as React.CSSProperties}>{e}</span>
        ))}
      </div>

      <div className="card">
        <header>
          <h1>✨ My Todos ✨</h1>
          <p className="subtitle">Let's get things done, superstar! 🚀</p>
          {totalCount > 0 && (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="progress-label">{doneCount}/{totalCount} done 🎯</span>
            </div>
          )}
        </header>

        <div className="add-section">
          <input
            ref={inputRef}
            className="main-input"
            placeholder="What needs doing? 🤔"
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
                >
                  {PRIORITY_CONFIG[p].emoji} {PRIORITY_CONFIG[p].label}
                </button>
              ))}
            </div>
            <input
              type="date"
              className="date-input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            <button className="add-btn" onClick={addTodo}>
              + Add
            </button>
          </div>
        </div>

        <div className="filters">
          {(["all", "active", "done"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {FILTER_EMOJIS[f]} {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filtered.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className="todo-list">
              {filtered.length === 0 ? (
                <div className="empty-state">
                  {filter === "done" ? "No completed tasks yet! Keep going! 💪" : "Nothing here! Add a task above 🎉"}
                </div>
              ) : (
                filtered.map((todo) => (
                  <SortableItem
                    key={todo.id}
                    todo={todo}
                    onToggle={toggleTodo}
                    onDelete={deleteTodo}
                  />
                ))
              )}
            </div>
          </SortableContext>
        </DndContext>

        {todos.length > 0 && (
          <footer>
            <button
              className="clear-btn"
              onClick={() => setTodos((prev) => prev.filter((t) => !t.completed))}
            >
              🧹 Clear completed
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
