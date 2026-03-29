import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
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

interface ArchivedTodo extends Todo {
  archivedAt: number;  // timestamp when archived
  completedAt: number; // timestamp when completed
}

interface Toast { id: string; message: string; undoFn?: () => void; }

interface SubtaskReward {
  id: string;
  message: string;
  xp: number;
  x: number; // percent from left for positioning
  y: number; // percent from top
}

type ThemeMode = "dark" | "light";

interface Achievement {
  id: string; title: string; description: string; icon: string;
  unlockedAt: number | null;
}

interface TaskTemplate {
  id: string; name: string; icon: string; priority: Priority;
  tags: string[]; notes: string; subtaskTexts: string[];
}

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
const SUBTASK_XP = 10;
const TASK_XP = 25;
const ENCOURAGEMENTS = [
  "Keep going! 💪", "You're crushing it! 🔥", "One step closer! ⚡",
  "Nice work! 🌟", "Building momentum! 🚀", "That's the way! 👊",
  "Unstoppable! 💥", "On a roll! 🎯", "Killing it! 🏆", "Yes!! 🙌",
];
const POMODORO_BREAK = 5 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);

const ACHIEVEMENT_DEFS: Omit<Achievement, "unlockedAt">[] = [
  // Task milestones
  { id: "task_1",   icon: "🌱", title: "First Step",      description: "Complete your first task" },
  { id: "task_10",  icon: "🔥", title: "On Fire",         description: "Complete 10 tasks" },
  { id: "task_50",  icon: "⚡", title: "Powerhouse",      description: "Complete 50 tasks" },
  { id: "task_100", icon: "👑", title: "Centurion",       description: "Complete 100 tasks" },
  // Streak milestones
  { id: "streak_3",  icon: "📅", title: "3-Day Streak",   description: "Complete subtasks 3 days in a row" },
  { id: "streak_7",  icon: "🗓", title: "Week Warrior",   description: "Complete subtasks 7 days in a row" },
  { id: "streak_14", icon: "💎", title: "Fortnight",      description: "Complete subtasks 14 days in a row" },
  { id: "streak_30", icon: "🏆", title: "Iron Will",      description: "Complete subtasks 30 days in a row" },
  // Timer milestones
  { id: "pomo_1",    icon: "🍅", title: "First Pomodoro", description: "Complete your first Pomodoro" },
  { id: "time_1hr",  icon: "⏱",  title: "Hour Down",      description: "Log 1 hour of focused time" },
  { id: "time_10hr", icon: "🕰", title: "Time Lord",      description: "Log 10 hours of focused time" },
  // Brain Dump milestones
  { id: "dump_1",  icon: "🧠", title: "Mind Clear",       description: "Complete your first Brain Dump" },
  { id: "dump_10", icon: "🌊", title: "Thought Flow",     description: "Complete 10 Brain Dumps" },
  // Level milestones
  { id: "lvl_5",  icon: "⭐", title: "Rising Star",       description: "Reach Task Level 5" },
  { id: "lvl_10", icon: "🌟", title: "Veteran",           description: "Reach Task Level 10" },
  { id: "lvl_20", icon: "💫", title: "Legend",            description: "Reach Task Level 20" },
  // Speed milestones
  { id: "speed_5", icon: "🚀", title: "Speed Runner",     description: "Complete 5 tasks in one day" },
];

const DEFAULT_TEMPLATES: TaskTemplate[] = [
  { id: "tpl_work",    name: "Work Project",   icon: "💼", priority: "high",   tags: ["work"],     notes: "Project notes here", subtaskTexts: ["Define scope","Research","Draft","Review","Submit"] },
  { id: "tpl_personal",name: "Personal Goal",  icon: "🎯", priority: "medium", tags: ["personal"], notes: "",                   subtaskTexts: ["Plan","Take action","Review progress"] },
  { id: "tpl_meeting", name: "Meeting Prep",   icon: "📋", priority: "medium", tags: ["work"],     notes: "Agenda:",            subtaskTexts: ["Prepare agenda","Send invites","Take notes","Follow up"] },
];

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

// ─── Greeting helper ─────────────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// ─── OnboardingFlow ───────────────────────────────────────────────────────────
function OnboardingFlow({ onComplete }: { onComplete: (name: string) => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [tooltipStep, setTooltipStep] = useState(0);
  const [error, setError] = useState("");

  const features = [
    { icon: "✅", title: "Capture tasks instantly", desc: "Before they slip away from your mind. Add priorities, due dates, tags and notes." },
    { icon: "⏱", title: "Focus with Pomodoro timers", desc: "Built-in timers on every task. Work in focused sprints and take structured breaks." },
    { icon: "🏆", title: "Earn XP and level up", desc: "Every task you complete earns XP. Build streaks, unlock achievements, stay motivated." },
  ];

  const tooltips = [
    { text: "Type your task here and press Enter to add it instantly.", highlight: "Add your first task here ↑", icon: "✏️" },
    { text: "Use the sidebar to filter tasks, browse by tag, and access all app features.", highlight: "Explore the sidebar →", icon: "🗂" },
    { text: "Your XP and level appear here. Complete tasks to level up and unlock achievements!", highlight: "Watch your XP grow ↓", icon: "⭐" },
  ];

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">

        {/* ── Step 0: Name ── */}
        {step === 0 && (
          <div className="onboarding-step">
            <div className="onboarding-logo">
              <span className="onboarding-logo-icon">▣</span>
              <span className="onboarding-logo-name">TaskFlow</span>
            </div>
            <div className="onboarding-emoji">👋</div>
            <h2 className="onboarding-title">Welcome to TaskFlow!</h2>
            <p className="onboarding-subtitle">Let's get you set up. What should we call you?</p>
            <input
              className="onboarding-input"
              placeholder="Your first name…"
              value={name}
              onChange={e => { setName(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Enter" && name.trim() && setStep(1)}
              autoFocus
            />
            {error && <p className="onboarding-error">{error}</p>}
            <button className="onboarding-btn" onClick={() => {
              if (!name.trim()) { setError("Please enter your name to continue."); return; }
              setStep(1);
            }}>
              Let's go →
            </button>
          </div>
        )}

        {/* ── Step 1: Features ── */}
        {step === 1 && (
          <div className="onboarding-step">
            <div className="onboarding-emoji">🚀</div>
            <h2 className="onboarding-title">Hi {name}! Here's what TaskFlow does</h2>
            <p className="onboarding-subtitle">Built specifically for ADHD minds that need structure and momentum.</p>
            <div className="onboarding-features">
              {features.map((f, i) => (
                <div key={i} className="onboarding-feature">
                  <span className="onboarding-feature-icon">{f.icon}</span>
                  <div>
                    <div className="onboarding-feature-title">{f.title}</div>
                    <div className="onboarding-feature-desc">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <button className="onboarding-btn" onClick={() => setStep(2)}>
              Got it, show me around →
            </button>
            <button className="onboarding-skip" onClick={() => onComplete(name.trim())}>Skip tour</button>
          </div>
        )}

        {/* ── Step 2: Tooltip tour ── */}
        {step === 2 && (
          <div className="onboarding-step">
            <div className="onboarding-emoji">{tooltips[tooltipStep].icon}</div>
            <div className="onboarding-tour-progress">
              {tooltips.map((_, i) => (
                <div key={i} className={`onboarding-tour-dot ${i <= tooltipStep ? "active" : ""}`} />
              ))}
            </div>
            <h2 className="onboarding-title">{tooltips[tooltipStep].highlight}</h2>
            <p className="onboarding-subtitle">{tooltips[tooltipStep].text}</p>
            <button className="onboarding-btn" onClick={() => {
              if (tooltipStep < tooltips.length - 1) setTooltipStep(t => t + 1);
              else setStep(3);
            }}>
              {tooltipStep < tooltips.length - 1 ? "Next →" : "Almost done →"}
            </button>
            <button className="onboarding-skip" onClick={() => onComplete(name.trim())}>Skip</button>
          </div>
        )}

        {/* ── Step 3: First task ── */}
        {step === 3 && (
          <div className="onboarding-step">
            <div className="onboarding-emoji">🎯</div>
            <h2 className="onboarding-title">You're all set, {name}!</h2>
            <p className="onboarding-subtitle">
              What's the <strong>one most important thing</strong> you need to get done today?
            </p>
            <p className="onboarding-hint">You can add it now or jump straight into the app.</p>
            <button className="onboarding-btn" onClick={() => onComplete(name.trim())}>
              Take me to TaskFlow! 🚀
            </button>
          </div>
        )}

      </div>
    </div>
  );
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

// ─── MiniConfetti ────────────────────────────────────────────────────────────
function MiniConfetti({ reward }: { reward: SubtaskReward }) {
  const pieces = Array.from({ length: 14 }, (_, i) => ({
    id: i,
    color: ["#4f8ef7","#f87171","#34d399","#f59e0b","#a78bfa","#f472b6"][i % 6],
    delay: Math.random() * 0.3,
    size: 4 + Math.random() * 5,
    dx: (Math.random() - 0.5) * 80,
  }));
  return (
    <div className="mini-confetti-wrap" style={{ left: `${reward.x}%`, top: `${reward.y}%` }} aria-hidden="true">
      {pieces.map(p => (
        <div key={p.id} className="mini-confetti-piece"
          style={{ background: p.color, width: p.size, height: p.size,
            animationDelay: `${p.delay}s`, "--dx": `${p.dx}px` } as React.CSSProperties} />
      ))}
      <div className="mini-reward-popup">
        <span className="mini-reward-xp">+{reward.xp} XP</span>
        <span className="mini-reward-msg">{reward.message}</span>
      </div>
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
  onSaveTimeGoal, onArchive,
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
  onArchive: (id: string) => void;
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
            {todo.completed && (
              <button className="archive-btn" onClick={() => onArchive(todo.id)} title="Archive task">📦</button>
            )}
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

// ─── BadgeUnlock ─────────────────────────────────────────────────────────────
function BadgeUnlock({ achievement, onDone }: { achievement: Achievement; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  const pieces = Array.from({ length: 40 }, (_, i) => ({
    id: i, color: ["#4f8ef7","#f87171","#34d399","#f59e0b","#a78bfa","#f472b6","#fff"][i%7],
    x: Math.random()*100, delay: Math.random()*0.5, size: 5+Math.random()*9,
  }));
  return (
    <div className="badge-unlock-overlay" onClick={onDone}>
      <div className="badge-unlock-confetti" aria-hidden>
        {pieces.map(p => (
          <div key={p.id} className="confetti-piece"
            style={{ left:`${p.x}%`, background:p.color, width:p.size, height:p.size, animationDelay:`${p.delay}s` }} />
        ))}
      </div>
      <div className="badge-unlock-card" onClick={e => e.stopPropagation()}>
        <p className="badge-unlock-label">🎖 Achievement Unlocked!</p>
        <div className="badge-unlock-icon">{achievement.icon}</div>
        <p className="badge-unlock-title">{achievement.title}</p>
        <p className="badge-unlock-desc">{achievement.description}</p>
        <button className="save-btn" style={{marginTop:"1rem"}} onClick={onDone}>Awesome! 🙌</button>
      </div>
    </div>
  );
}

// ─── AchievementsPanel ────────────────────────────────────────────────────────
function AchievementsPanel({ achievements, onClose }: { achievements: Achievement[]; onClose: () => void }) {
  const unlocked = achievements.filter(a => a.unlockedAt);
  const locked   = achievements.filter(a => !a.unlockedAt);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal achievements-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🏅 Achievements</h2>
          <span className="achievements-count">{unlocked.length}/{achievements.length} unlocked</span>
        </div>
        <div className="achievements-grid">
          {unlocked.map(a => (
            <div key={a.id} className="achievement-card unlocked">
              <span className="achievement-icon">{a.icon}</span>
              <span className="achievement-title">{a.title}</span>
              <span className="achievement-desc">{a.description}</span>
              <span className="achievement-date">{new Date(a.unlockedAt!).toLocaleDateString()}</span>
            </div>
          ))}
          {locked.map(a => (
            <div key={a.id} className="achievement-card locked">
              <span className="achievement-icon">🔒</span>
              <span className="achievement-title">{a.title}</span>
              <span className="achievement-desc">{a.description}</span>
            </div>
          ))}
        </div>
        <button className="save-btn" style={{marginTop:"1rem"}} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ─── FocusMode ────────────────────────────────────────────────────────────────
function FocusMode({ todos, focusId, onSetFocus, onToggle, onClose }: {
  todos: Todo[]; focusId: string | null;
  onSetFocus: (id: string) => void; onToggle: (id: string) => void; onClose: () => void;
}) {
  const activeTodos = todos.filter(t => !t.completed);
  const task = todos.find(t => t.id === focusId) ?? activeTodos[0] ?? null;
  const subDone = task?.subtasks.filter(s => s.completed).length ?? 0;
  const subTotal = task?.subtasks.length ?? 0;
  const pct = subTotal > 0 ? Math.round((subDone / subTotal) * 100) : 0;

  return (
    <div className="focus-overlay">
      <div className="focus-header">
        <span className="focus-brand">▣ Focus Mode</span>
        <button className="focus-close" onClick={onClose}>✕ Exit</button>
      </div>
      <div className="focus-body">
        {task ? (
          <>
            <p className="focus-label">Current Task</p>
            <h1 className="focus-task-title">{task.text}</h1>
            {task.notes && <p className="focus-notes">{task.notes}</p>}
            {subTotal > 0 && (
              <div className="focus-progress">
                <div className="focus-progress-bar"><div className="focus-progress-fill" style={{width:`${pct}%`}} /></div>
                <span className="focus-progress-label">{subDone}/{subTotal} subtasks · {pct}%</span>
              </div>
            )}
            {task.subtasks.length > 0 && (
              <div className="focus-subtasks">
                {task.subtasks.map(s => (
                  <div key={s.id} className={`focus-subtask ${s.completed ? "done" : ""}`}>
                    <button className={`check-btn small ${s.completed ? "checked" : ""}`} onClick={() => {}} />
                    <span>{s.text}</span>
                  </div>
                ))}
              </div>
            )}
            <button className="focus-complete-btn" onClick={() => { onToggle(task.id); onClose(); }}>
              ✓ Complete Task
            </button>
          </>
        ) : (
          <div className="focus-empty">
            <span>🎉</span>
            <p>All tasks complete! Amazing work.</p>
          </div>
        )}
      </div>
      {activeTodos.length > 1 && (
        <div className="focus-queue">
          <p className="focus-queue-label">Up Next</p>
          {activeTodos.filter(t => t.id !== task?.id).slice(0, 4).map(t => (
            <button key={t.id} className="focus-queue-item" onClick={() => onSetFocus(t.id)}>
              <span className="focus-queue-dot" style={{background: PRIORITY_CONFIG[t.priority].dot}} />
              {t.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TemplatesModal ───────────────────────────────────────────────────────────
function TemplatesModal({ templates, onApply, onDelete, onClose, onAdd }: {
  templates: TaskTemplate[]; onApply: (t: TaskTemplate) => void;
  onDelete: (id: string) => void; onClose: () => void;
  onAdd: (t: TaskTemplate) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(""); const [icon, setIcon] = useState("📌");
  const [priority, setPriority] = useState<Priority>("medium");
  const [tags, setTags] = useState(""); const [notes, setNotes] = useState("");
  const [subtasks, setSubtasks] = useState("");
  const save = () => {
    if (!name.trim()) return;
    onAdd({ id: crypto.randomUUID(), name: name.trim(), icon, priority,
      tags: tags.split(",").map(t=>t.trim()).filter(Boolean),
      notes, subtaskTexts: subtasks.split("\n").map(t=>t.trim()).filter(Boolean) });
    setCreating(false); setName(""); setIcon("📌"); setTags(""); setNotes(""); setSubtasks("");
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal templates-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📋 Templates</h2>
          <button className="save-btn" style={{padding:"0.3rem 0.7rem",fontSize:"0.8rem"}} onClick={() => setCreating(c=>!c)}>
            {creating ? "Cancel" : "+ New Template"}
          </button>
        </div>
        {creating && (
          <div className="template-create-form">
            <div className="template-create-row">
              <input className="edit-input" style={{width:"3rem",textAlign:"center"}} value={icon} onChange={e=>setIcon(e.target.value)} placeholder="📌" maxLength={2} />
              <input className="edit-input" style={{flex:1}} value={name} onChange={e=>setName(e.target.value)} placeholder="Template name…" />
            </div>
            <div className="priority-select">
              {(["low","medium","high"] as Priority[]).map(p => (
                <button key={p} className={`pri-btn small ${priority===p?"active":""}`}
                  onClick={()=>setPriority(p)} style={{"--dot":PRIORITY_CONFIG[p].dot} as React.CSSProperties}>
                  {PRIORITY_CONFIG[p].label}
                </button>
              ))}
            </div>
            <input className="edit-input" value={tags} onChange={e=>setTags(e.target.value)} placeholder="Tags (comma-separated)…" />
            <textarea className="brain-dump-textarea" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Notes…" rows={2} />
            <textarea className="brain-dump-textarea" value={subtasks} onChange={e=>setSubtasks(e.target.value)} placeholder="Subtasks (one per line): Step one / Step two" rows={4} />
            <button className="save-btn" onClick={save}>Save Template</button>
          </div>
        )}
        <div className="templates-grid">
          {templates.map(t => (
            <div key={t.id} className="template-card">
              <span className="template-icon">{t.icon}</span>
              <div className="template-info">
                <span className="template-name">{t.name}</span>
                <span className="template-meta">
                  {t.priority} · {t.subtaskTexts.length} subtasks
                  {t.tags.length > 0 && ` · ${t.tags.join(", ")}`}
                </span>
              </div>
              <div className="template-actions">
                <button className="save-btn" style={{padding:"0.25rem 0.6rem",fontSize:"0.75rem"}} onClick={()=>onApply(t)}>Use</button>
                {!["tpl_work","tpl_personal","tpl_meeting"].includes(t.id) && (
                  <button className="delete-btn" style={{opacity:1}} onClick={()=>onDelete(t.id)}>✕</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <button className="cancel-btn" style={{marginTop:"0.5rem"}} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ─── WeeklyReview ─────────────────────────────────────────────────────────────
function WeeklyReview({ todos, taskXP, subtaskXP, achievements, onClose }: {
  todos: Todo[]; taskXP: number; subtaskXP: number; achievements: Achievement[]; onClose: () => void;
}) {
  const weekAgo = Date.now() - 7*86400000;
  const completed = todos.filter(t => t.completed);
  const completedThisWeek = completed.filter(t => t.createdAt > weekAgo);
  const totalTimeMs = todos.reduce((a,t) => a+(t.totalTimeMs||0),0) + todos.flatMap(t=>t.subtasks).reduce((a,s)=>a+(s.totalTimeMs||0),0);
  const totalMins = Math.floor(totalTimeMs/60000);
  const unlockedThisWeek = achievements.filter(a => a.unlockedAt && a.unlockedAt > weekAgo);
  const highPriDone = completedThisWeek.filter(t => t.priority==="high").length;
  const dayMap: Record<string,number> = {};
  completedThisWeek.forEach(t => { const d=new Date(t.createdAt).toLocaleDateString("en-US",{weekday:"short"}); dayMap[d]=(dayMap[d]||0)+1; });
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const maxDay = Math.max(...Object.values(dayMap), 1);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal weekly-modal" onClick={e=>e.stopPropagation()}>
        <h2>📆 Weekly Review</h2>
        <p className="weekly-subtitle">{new Date(weekAgo).toLocaleDateString("en-US",{month:"short",day:"numeric"})} – {new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}</p>

        <div className="weekly-stats-grid">
          <div className="weekly-stat"><span className="weekly-stat-val">{completedThisWeek.length}</span><span className="weekly-stat-lbl">Tasks Done</span></div>
          <div className="weekly-stat"><span className="weekly-stat-val">{highPriDone}</span><span className="weekly-stat-lbl">High Priority</span></div>
          <div className="weekly-stat"><span className="weekly-stat-val">{totalMins<60?`${totalMins}m`:`${Math.floor(totalMins/60)}h${totalMins%60}m`}</span><span className="weekly-stat-lbl">Time Logged</span></div>
          <div className="weekly-stat"><span className="weekly-stat-val">{taskXP+subtaskXP}</span><span className="weekly-stat-lbl">Total XP</span></div>
        </div>

        <p className="weekly-section-title">Activity This Week</p>
        <div className="weekly-chart">
          {days.map(d => (
            <div key={d} className="weekly-bar-col">
              <div className="weekly-bar-wrap">
                <div className="weekly-bar" style={{height:`${((dayMap[d]||0)/maxDay)*100}%`}} />
              </div>
              <span className="weekly-bar-label">{d}</span>
              {dayMap[d] > 0 && <span className="weekly-bar-count">{dayMap[d]}</span>}
            </div>
          ))}
        </div>

        {unlockedThisWeek.length > 0 && (
          <>
            <p className="weekly-section-title">Badges Earned This Week</p>
            <div className="weekly-badges">
              {unlockedThisWeek.map(a => (
                <div key={a.id} className="weekly-badge">
                  <span>{a.icon}</span><span>{a.title}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {completedThisWeek.length > 0 && (
          <>
            <p className="weekly-section-title">Completed Tasks</p>
            <div className="weekly-tasks">
              {completedThisWeek.slice(0,10).map(t => (
                <div key={t.id} className="weekly-task-item">
                  <span className="weekly-task-dot" style={{background:PRIORITY_CONFIG[t.priority].dot}} />
                  <span>{t.text}</span>
                </div>
              ))}
              {completedThisWeek.length > 10 && <p className="weekly-more">+{completedThisWeek.length-10} more</p>}
            </div>
          </>
        )}

        <button className="save-btn" style={{marginTop:"1rem",width:"100%"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

// ─── XPBar ───────────────────────────────────────────────────────────────────
function XPBar({ taskXP, subtaskXP, subtaskStreak, unlockedCount, totalCount, onShowAchievements }: {
  taskXP: number; subtaskXP: number; subtaskStreak: { count: number; date: string };
  unlockedCount: number; totalCount: number; onShowAchievements: () => void;
}) {
  const taskLevel = Math.floor(taskXP / 100) + 1;
  const taskLevelXP = taskXP % 100;
  const subtaskLevel = Math.floor(subtaskXP / 50) + 1;
  const subtaskLevelXP = subtaskXP % 50;
  const streakToday = subtaskStreak.date === today() ? subtaskStreak.count : 0;

  return (
    <div className="xp-bar-wrap">
      <div className="xp-section">
        <div className="xp-label-row">
          <span className="xp-title">🏆 Tasks</span>
          <span className="xp-level">Lv {taskLevel}</span>
          <span className="xp-pts">{taskXP} XP</span>
        </div>
        <div className="xp-track"><div className="xp-fill task-fill" style={{ width: `${taskLevelXP}%` }} /></div>
        <span className="xp-sub">{taskLevelXP}/100 XP to next level</span>
      </div>
      <div className="xp-divider" />
      <div className="xp-section">
        <div className="xp-label-row">
          <span className="xp-title">⚡ Subtasks</span>
          <span className="xp-level">Lv {subtaskLevel}</span>
          <span className="xp-pts">{subtaskXP} XP</span>
        </div>
        <div className="xp-track"><div className="xp-fill subtask-fill" style={{ width: `${subtaskLevelXP * 2}%` }} /></div>
        <span className="xp-sub">{subtaskLevelXP}/50 XP to next level</span>
      </div>
      <div className="xp-divider" />
      <div className="xp-streak">
        <span className="streak-fire">{streakToday >= 5 ? "🔥" : streakToday >= 3 ? "⚡" : "✅"}</span>
        <div>
          <span className="streak-count">{streakToday}</span>
          <span className="streak-label"> subtasks today</span>
        </div>
      </div>
      <div className="xp-divider" />
      <button className="achievements-peek" onClick={onShowAchievements}>
        <span>🏅 Achievements</span>
        <span className="achievements-peek-count">{unlockedCount}/{totalCount}</span>
      </button>
    </div>
  );
}

// ─── ArchivePanel ────────────────────────────────────────────────────────────
function ArchivePanel({ archive, onRestore, onDelete, onClose }: {
  archive: ArchivedTodo[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"archivedAt" | "priority">("archivedAt");

  const filtered = archive
    .filter(a => !search || a.text.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === "archivedAt"
      ? b.archivedAt - a.archivedAt
      : PRIORITY_CONFIG[b.priority].weight - PRIORITY_CONFIG[a.priority].weight
    );

  const expiresIn = (archivedAt: number) => {
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    const daysLeft = Math.ceil((archivedAt + NINETY_DAYS - Date.now()) / 86400000);
    if (daysLeft <= 7) return { label: `Expires in ${daysLeft}d`, urgent: true };
    return { label: `Expires in ${daysLeft}d`, urgent: false };
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal archive-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📦 Archive</h2>
          <span className="achievements-count">{archive.length} task{archive.length !== 1 ? "s" : ""}</span>
        </div>
        <p className="archive-hint">Tasks are kept for 90 days then permanently deleted.</p>

        <div className="archive-controls">
          <input className="search-input" style={{flex:1}} placeholder="Search archive…"
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value as "archivedAt" | "priority")}>
            <option value="archivedAt">Most Recent</option>
            <option value="priority">Priority</option>
          </select>
        </div>

        {filtered.length === 0 ? (
          <div className="archive-empty">
            <span>📭</span>
            <p>{search ? "No archived tasks match your search." : "Archive is empty — completed tasks auto-archive after 7 days."}</p>
          </div>
        ) : (
          <div className="archive-list">
            {filtered.map(a => {
              const exp = expiresIn(a.archivedAt);
              return (
                <div key={a.id} className="archive-item">
                  <div className="archive-item-left">
                    <span className="archive-priority-dot" style={{background: PRIORITY_CONFIG[a.priority].dot}} />
                    <div className="archive-item-info">
                      <span className="archive-item-text">{a.text}</span>
                      <div className="archive-item-meta">
                        <span>Archived {new Date(a.archivedAt).toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"})}</span>
                        {a.tags.length > 0 && <span>· {a.tags.join(", ")}</span>}
                        {a.totalTimeMs > 0 && <span>· {fmtDuration(a.totalTimeMs)} logged</span>}
                        <span className={`archive-expires ${exp.urgent ? "urgent" : ""}`}>· {exp.label}</span>
                      </div>
                    </div>
                  </div>
                  <div className="archive-item-actions">
                    <button className="save-btn" style={{padding:"0.2rem 0.6rem", fontSize:"0.75rem"}}
                      onClick={() => onRestore(a.id)}>↩ Restore</button>
                    <button className="delete-btn" style={{opacity:1, padding:"0.2rem 0.5rem"}}
                      onClick={() => onDelete(a.id)}>✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <button className="cancel-btn" style={{marginTop:"0.5rem"}} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ─── Supabase Client ──────────────────────────────────────────────────────────
// Make sure you have a .env file in your project root with:
//   VITE_SUPABASE_URL=https://your-project.supabase.co
//   VITE_SUPABASE_ANON_KEY=your-anon-key
const supabase = createClient(
  (import.meta as unknown as { env: Record<string,string> }).env.VITE_SUPABASE_URL,
  (import.meta as unknown as { env: Record<string,string> }).env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      storageKey: "taskflow-auth",
      storage: window.localStorage,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }
  }
);

// ─── AppState (for sync) ──────────────────────────────────────────────────────
interface AppState {
  todos: Todo[]; taskXP: number; subtaskXP: number;
  subtaskStreak: { count: number; date: string };
  achievements: Achievement[]; archive: ArchivedTodo[];
  brainDumpCount: number; dailyStreak: { days: string[] };
  templates: TaskTemplate[]; theme: ThemeMode;
  userName: string; onboardingComplete: boolean;
}

// ─── useSupabaseSync ──────────────────────────────────────────────────────────
function useSupabaseSync() {
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [initialData, setInitialData] = useState<AppState | null>(null);
  const [showReset, setShowReset] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<AppState | null>(null);

  const loadUserData = useCallback(async (uid: string) => {
    setLoadingData(true);
    try {
      const { data, error } = await supabase
        .from("user_data").select("*").eq("user_id", uid).single();
      if (error && error.code !== "PGRST116") console.error("Load error:", error.message);
      if (data) {
        setInitialData({
          todos:              data.todos              ?? [],
          taskXP:             data.task_xp            ?? 0,
          subtaskXP:          data.subtask_xp         ?? 0,
          subtaskStreak:      data.subtask_streak     ?? { count: 0, date: "" },
          achievements:       data.achievements       ?? [],
          archive:            data.archive            ?? [],
          brainDumpCount:     data.brain_dump_count   ?? 0,
          dailyStreak:        data.daily_streak       ?? { days: [] },
          templates:          data.templates          ?? DEFAULT_TEMPLATES,
          theme:              data.theme              ?? "dark",
          userName:           data.user_name          ?? "",
          onboardingComplete: data.onboarding_complete ?? false,
        });
      }
    } finally { setLoadingData(false); }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) loadUserData(u.id);
      setLoadingAuth(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user ?? null;
      if (event === "PASSWORD_RECOVERY") {
        setShowReset(true);
        setUser(u);
        setLoadingAuth(false);
        return;
      }
      setShowReset(false);
      setUser(u);
      if (u) loadUserData(u.id);
      else { setInitialData(null); setLoadingAuth(false); }
    });
    return () => subscription.unsubscribe();
  }, [loadUserData]);

  const saveData = useCallback((state: AppState) => {
    if (!user) return;
    pendingRef.current = state;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const s = pendingRef.current; if (!s || !user) return;
      try {
        await supabase.from("user_data").upsert({
          user_id: user.id, todos: s.todos,
          task_xp: s.taskXP, subtask_xp: s.subtaskXP,
          subtask_streak: s.subtaskStreak, achievements: s.achievements,
          archive: s.archive, brain_dump_count: s.brainDumpCount,
          daily_streak: s.dailyStreak, templates: s.templates, theme: s.theme,
          user_name: s.userName, onboarding_complete: s.onboardingComplete,
        }, { onConflict: "user_id" });
      } catch (err) { console.error("Save error:", err); }
    }, 1500);
  }, [user]);

  const signOut = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await supabase.auth.signOut();
  }, []);

  return { user, loadingAuth, loadingData, initialData, saveData, signOut, showReset, setShowReset };
}

// ─── ResetPasswordModal ───────────────────────────────────────────────────────
function ResetPasswordModal({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);
    if (!password.trim()) { setError("Please enter a new password."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setInfo("Password updated! Signing you in…");
      setTimeout(onDone, 1500);
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? "Something went wrong.");
    } finally { setLoading(false); }
  };

  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <div className="auth-brand">
          <span className="auth-brand-icon">▣</span>
          <span className="auth-brand-name">TaskFlow</span>
        </div>
        <h2 className="auth-title">Set new password</h2>
        <p className="auth-subtitle">Choose a strong password for your account.</p>
        {error && <div className="auth-error">{error}</div>}
        {info  && <div className="auth-info">{info}</div>}
        <div className="auth-fields">
          <input className="auth-input" type="password" placeholder="New password"
            value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} autoFocus />
          <input className="auth-input" type="password" placeholder="Confirm new password"
            value={confirm} onChange={e => setConfirm(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <button className="auth-submit" onClick={submit} disabled={loading}>
          {loading ? <span className="auth-spinner" /> : "Update Password"}
        </button>
      </div>
    </div>
  );
}

// ─── AuthModal ────────────────────────────────────────────────────────────────
function AuthModal() {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = () => { setError(null); setInfo(null); };

  const submit = async () => {
    reset();
    setLoading(true);
    try {
      if (mode === "forgot") {
        if (!email.trim()) { setError("Please enter your email address."); setLoading(false); return; }
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (error) throw error;
        setInfo("Check your email for a password reset link!");
      } else if (mode === "signup") {
        if (!email.trim() || !password.trim()) { setError("Please enter your email and password."); setLoading(false); return; }
        if (password.length < 6) { setError("Password must be at least 6 characters."); setLoading(false); return; }
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setInfo("Account created! You can now sign in.");
        setMode("signin");
      } else {
        if (!email.trim() || !password.trim()) { setError("Please enter your email and password."); setLoading(false); return; }
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? "Something went wrong.");
    } finally { setLoading(false); }
  };

  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <div className="auth-brand">
          <span className="auth-brand-icon">▣</span>
          <span className="auth-brand-name">TaskFlow</span>
        </div>
        <h2 className="auth-title">
          {mode === "signin" ? "Welcome back" : mode === "signup" ? "Create an account" : "Reset password"}
        </h2>
        <p className="auth-subtitle">
          {mode === "signin"  ? "Sign in to access your tasks from anywhere."
          : mode === "signup" ? "Your data will sync across all your devices."
          : "Enter your email and we'll send you a reset link."}
        </p>
        {error && <div className="auth-error">{error}</div>}
        {info  && <div className="auth-info">{info}</div>}
        <div className="auth-fields">
          <input className="auth-input" type="email" placeholder="Email" value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} autoFocus />
          {mode !== "forgot" && (
            <input className="auth-input" type="password" placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()} />
          )}
        </div>
        {mode === "signin" && (
          <div style={{ textAlign: "right", marginTop: "-0.25rem" }}>
            <button className="auth-switch-btn" style={{ fontSize: "0.75rem" }}
              onClick={() => { setMode("forgot"); reset(); }}>
              Forgot password?
            </button>
          </div>
        )}
        <button className="auth-submit" onClick={submit} disabled={loading}>
          {loading ? <span className="auth-spinner" />
            : mode === "signin"  ? "Sign In"
            : mode === "signup"  ? "Create Account"
            : "Send Reset Link"}
        </button>
        <p className="auth-switch">
          {mode === "forgot" ? (
            <>Remember your password? <button className="auth-switch-btn"
              onClick={() => { setMode("signin"); reset(); }}>Sign in</button></>
          ) : mode === "signin" ? (
            <>Don't have an account? <button className="auth-switch-btn"
              onClick={() => { setMode("signup"); reset(); }}>Sign up</button></>
          ) : (
            <>Already have one? <button className="auth-switch-btn"
              onClick={() => { setMode("signin"); reset(); }}>Sign in</button></>
          )}
        </p>
      </div>
    </div>
  );
}


// ─── AIFocusSuggest ───────────────────────────────────────────────────────────
interface AIsuggestion { id: string; reason: string; }

function AIFocusSuggest({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<AIsuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<string | null>(null);

  const activeTodos = todos.filter(t => !t.completed);

  const getSuggestions = async () => {
    if (activeTodos.length === 0) { setSuggestions([]); return; }
    setLoading(true); setError(null); setSuggestions(null);
    const taskList = activeTodos.map(t => ({
      id: t.id, text: t.text, priority: t.priority,
      dueDate: t.dueDate || null,
      overdue: !!t.dueDate && t.dueDate < today(),
      subtasksDone: t.subtasks.filter(s => s.completed).length,
      subtasksTotal: t.subtasks.length,
      timeLoggedMs: t.totalTimeMs || 0,
      tags: t.tags,
    }));
    try {
      const supabaseAnonKey = (import.meta as unknown as { env: Record<string,string> }).env.VITE_SUPABASE_ANON_KEY;
      const res = await fetch("https://tsyjhicnbtegmgbmvqam.supabase.co/functions/v1/ai-focus", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "apikey": supabaseAnonKey,
        },
        body: JSON.stringify({
          system: `You are a productivity coach helping someone with ADHD decide what to focus on today. Analyze their task list and return the top 3 most important tasks. Prioritize: overdue tasks, high-priority tasks, tasks already in progress (partial subtasks done). Keep reasons short, direct, and motivating — max 12 words. Respond ONLY with valid JSON — no markdown, no preamble — in this exact format: {"suggestions":[{"id":"task_id","reason":"short motivating reason"}]}`,
          messages: [{ role: "user", content: `Today is ${today()}. Here are my active tasks:\n${JSON.stringify(taskList, null, 2)}\n\nPick my top 3 focus tasks.` }],
        }),
      });
      const data = await res.json();
      const raw = data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setSuggestions(parsed.suggestions ?? []);
      setLastFetched(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch {
      setError("Couldn't reach AI. Check your connection and try again.");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open && suggestions === null && !loading) getSuggestions();
  }, [open]);

  const suggestedTodos = suggestions
    ?.map(s => ({ ...s, todo: activeTodos.find(t => t.id === s.id) }))
    .filter((s): s is AIsuggestion & { todo: Todo } => !!s.todo) ?? [];

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <>
      <button
        className={`ai-focus-fab ${open ? "open" : ""}`}
        onClick={() => setOpen(o => !o)}
        title="AI Daily Focus"
        aria-label={open ? "Close AI Focus panel" : "Open AI Daily Focus"}
      >
        <span className="ai-fab-icon">{open ? "✕" : "✨"}</span>
        <span className="ai-fab-label">{open ? "Close" : "Focus AI"}</span>
      </button>

      {open && (
        <div className="ai-focus-panel" role="dialog" aria-label="AI Daily Focus suggestions">
          <div className="ai-focus-header">
            <div>
              <h3 className="ai-focus-title">✨ Today's Focus</h3>
              <p className="ai-focus-sub">{lastFetched ? `Updated ${lastFetched}` : "AI-picked tasks for right now"}</p>
            </div>
            <button className="ai-refresh-btn" onClick={getSuggestions} disabled={loading} title="Refresh suggestions">
              <span className={loading ? "ai-refresh-spinning" : ""}>↺</span>
            </button>
          </div>
          {loading && (
            <div className="ai-loading">
              <div className="ai-spinner" />
              <span>Analyzing your {activeTodos.length} tasks…</span>
            </div>
          )}
          {!loading && error && (
            <div className="ai-error-box">
              <span>⚠</span><p>{error}</p>
              <button className="ai-retry-btn" onClick={getSuggestions}>Retry</button>
            </div>
          )}
          {!loading && !error && activeTodos.length === 0 && (
            <div className="ai-empty">
              <span className="ai-empty-icon">🎉</span>
              <p>No active tasks! Add some tasks first.</p>
            </div>
          )}
          {!loading && !error && suggestedTodos.map((s, i) => {
            const isOverdue = !!s.todo.dueDate && s.todo.dueDate < today();
            const subDone = s.todo.subtasks.filter(st => st.completed).length;
            const subTotal = s.todo.subtasks.length;
            return (
              <div key={s.id} className={`ai-task-card ai-rank-${i}`}>
                <div className="ai-task-medal">{medals[i]}</div>
                <div className="ai-task-body">
                  <div className="ai-task-top">
                    <span className="ai-priority-dot" style={{ background: PRIORITY_CONFIG[s.todo.priority].dot }} />
                    <span className="ai-task-text">{s.todo.text}</span>
                  </div>
                  <div className="ai-task-meta">
                    {s.todo.dueDate && (
                      <span className={`ai-task-due ${isOverdue ? "overdue" : ""}`}>
                        {isOverdue ? "⚠ Overdue" : `📅 Due ${s.todo.dueDate}`}
                      </span>
                    )}
                    {subTotal > 0 && <span className="ai-task-progress">◎ {subDone}/{subTotal} done</span>}
                    {s.todo.tags.length > 0 && <span className="ai-task-tag">#{s.todo.tags[0]}</span>}
                  </div>
                  <p className="ai-task-reason">"{s.reason}"</p>
                </div>
              </div>
            );
          })}
          {!loading && suggestedTodos.length > 0 && (
            <p className="ai-focus-footer">💡 Try tackling just one. You've got this.</p>
          )}
        </div>
      )}
    </>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
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
  const [subtaskRewards, setSubtaskRewards] = useState<SubtaskReward[]>([]);
  const [taskXP, setTaskXP] = useState<number>(0);
  const [subtaskXP, setSubtaskXP] = useState<number>(0);
  const [subtaskStreak, setSubtaskStreak] = useState<{ count: number; date: string }>({ count: 0, date: "" });
  const [timers, setTimers] = useState<Record<string, ActiveTimer>>({});
  const [subtaskTimers, setSubtaskTimers] = useState<Record<string, ActiveTimer>>({});
  const [archive, setArchive] = useState<ArchivedTodo[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [achievements, setAchievements] = useState<Achievement[]>(
    ACHIEVEMENT_DEFS.map(def => ({ ...def, unlockedAt: null }))
  );
  const [unlockedBadge, setUnlockedBadge] = useState<Achievement | null>(null);
  const [showAchievements, setShowAchievements] = useState(false);
  const [showFocusMode, setShowFocusMode] = useState(false);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplate[]>(DEFAULT_TEMPLATES);
  const [showWeeklyReview, setShowWeeklyReview] = useState(false);
  const [brainDumpCount, setBrainDumpCount] = useState<number>(0);
  const [dailyStreak, setDailyStreak] = useState<{ days: string[] }>({ days: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userName, setUserName] = useState("");
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const { user, loadingAuth, loadingData, initialData, saveData, signOut, showReset, setShowReset } = useSupabaseSync();

  // Load data from Supabase when user signs in
  useEffect(() => {
    if (!initialData) return;
    setTodos(initialData.todos);
    setTaskXP(initialData.taskXP);
    setSubtaskXP(initialData.subtaskXP);
    setSubtaskStreak(initialData.subtaskStreak);
    setAchievements(prev => ACHIEVEMENT_DEFS.map(def => ({
      ...def,
      unlockedAt: initialData.achievements.find((a: Achievement) => a.id === def.id)?.unlockedAt ?? null,
    })));
    setArchive(initialData.archive);
    setBrainDumpCount(initialData.brainDumpCount);
    setDailyStreak(initialData.dailyStreak);
    setTemplates(initialData.templates.length ? initialData.templates : DEFAULT_TEMPLATES);
    setTheme(initialData.theme);
    setUserName(initialData.userName ?? "");
    setOnboardingComplete(initialData.onboardingComplete ?? false);
    if (!initialData.onboardingComplete) setShowOnboarding(true);
  }, [initialData]);

  // Guard: only save AFTER initial data has loaded — prevents race condition
  const dataLoadedRef = useRef(false);
  useEffect(() => {
    if (initialData) dataLoadedRef.current = true;
  }, [initialData]);

  // Save to Supabase whenever state changes (debounced 1.5s)
  useEffect(() => {
    if (!user || !dataLoadedRef.current) return;
    saveData({ todos, taskXP, subtaskXP, subtaskStreak, achievements,
               archive, brainDumpCount, dailyStreak, templates, theme,
               userName, onboardingComplete });
  }, [todos, taskXP, subtaskXP, subtaskStreak, achievements,
      archive, brainDumpCount, dailyStreak, templates, theme,
      userName, onboardingComplete]);

  // Apply theme to document
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  useEffect(() => { requestNotificationPermission(); }, []);

  // Recurring reset
  useEffect(() => {
    setTodos(prev => prev.map(t => shouldRecurReset(t) ? { ...t, completed: false, lastReset: today() } : t));
    const iv = setInterval(() => setTodos(prev => prev.map(t => shouldRecurReset(t) ? { ...t, completed: false, lastReset: today() } : t)), 60000);
    return () => clearInterval(iv);
  }, []);

  // Auto-archive completed tasks after 7 days
  useEffect(() => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const autoArchive = () => {
      const now = Date.now();
      setTodos(prev => {
        const toArchive = prev.filter(t => t.completed && (now - t.createdAt) > SEVEN_DAYS);
        if (toArchive.length === 0) return prev;
        setArchive(arch => {
          const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
          const pruned = arch.filter(a => now - a.archivedAt < NINETY_DAYS);
          const newEntries: ArchivedTodo[] = toArchive.map(t => ({ ...t, archivedAt: now, completedAt: t.createdAt }));
          return [...pruned, ...newEntries];
        });
        return prev.filter(t => !(t.completed && (now - t.createdAt) > SEVEN_DAYS));
      });
    };
    autoArchive();
    const iv = setInterval(autoArchive, 60 * 60 * 1000); // check every hour
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
                unlockAchievement("pomo_1");
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

  const unlockAchievement = useCallback((id: string) => {
    setAchievements(prev => {
      const ach = prev.find(a => a.id === id);
      if (!ach || ach.unlockedAt) return prev; // already unlocked
      const updated = prev.map(a => a.id === id ? { ...a, unlockedAt: Date.now() } : a);
      const unlocked = updated.find(a => a.id === id)!;
      setTimeout(() => setUnlockedBadge(unlocked), 100);
      return updated;
    });
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
    if (!wasCompleted) {
      setCelebration(true);
      const newXP = taskXP + TASK_XP;
      setTaskXP(newXP);
      // Count completed after this toggle
      const completedCount = todos.filter(t => t.completed).length + 1;
      if (completedCount >= 1)   unlockAchievement("task_1");
      if (completedCount >= 10)  unlockAchievement("task_10");
      if (completedCount >= 50)  unlockAchievement("task_50");
      if (completedCount >= 100) unlockAchievement("task_100");
      // Level milestones
      const newLevel = Math.floor(newXP / 100) + 1;
      if (newLevel >= 5)  unlockAchievement("lvl_5");
      if (newLevel >= 10) unlockAchievement("lvl_10");
      if (newLevel >= 20) unlockAchievement("lvl_20");
      // Speed: 5 tasks in one day
      const todayStr = today();
      const todayDone = todos.filter(t => t.completed && new Date(t.createdAt).toISOString().slice(0,10) === todayStr).length + 1;
      if (todayDone >= 5) unlockAchievement("speed_5");
      // Daily streak tracking
      setDailyStreak(prev => {
        const days = prev.days.includes(todayStr) ? prev.days : [...prev.days, todayStr].slice(-35);
        // Check consecutive streak
        const sorted = [...days].sort();
        let streak = 1, max = 1;
        for (let i = sorted.length - 1; i > 0; i--) {
          const d1 = new Date(sorted[i]), d2 = new Date(sorted[i-1]);
          const diff = (d1.getTime() - d2.getTime()) / 86400000;
          if (diff === 1) { streak++; max = Math.max(max, streak); } else break;
        }
        if (max >= 3)  unlockAchievement("streak_3");
        if (max >= 7)  unlockAchievement("streak_7");
        if (max >= 14) unlockAchievement("streak_14");
        if (max >= 30) unlockAchievement("streak_30");
        return { days };
      });
    }
  };

  const deleteTodo = (id: string) => {
    const deleted = todos.find(t => t.id === id)!;
    setTodos(prev => prev.filter(t => t.id !== id));
    setTimers(prev => { const n = { ...prev }; delete n[id]; return n; });
    showToast(`Deleted "${deleted.text}"`, () => setTodos(prev => [deleted, ...prev]));
  };

  const archiveTodo = (id: string) => {
    const todo = todos.find(t => t.id === id);
    if (!todo) return;
    const now = Date.now();
    setArchive(prev => {
      const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
      const pruned = prev.filter(a => now - a.archivedAt < NINETY_DAYS);
      return [...pruned, { ...todo, archivedAt: now, completedAt: now }];
    });
    setTodos(prev => prev.filter(t => t.id !== id));
    showToast(`Archived "${todo.text}"`, () => {
      setArchive(prev => prev.filter(a => a.id !== id));
      setTodos(prev => [todo, ...prev]);
    });
  };

  const restoreFromArchive = (id: string) => {
    const item = archive.find(a => a.id === id);
    if (!item) return;
    const { archivedAt, completedAt, ...todo } = item;
    setTodos(prev => [{ ...todo, completed: false }, ...prev]);
    setArchive(prev => prev.filter(a => a.id !== id));
    showToast(`Restored "${todo.text}"`);
  };

  const deleteFromArchive = (id: string) => {
    const item = archive.find(a => a.id === id);
    setArchive(prev => prev.filter(a => a.id !== id));
    showToast(`Permanently deleted "${item?.text}"`);
  };

  const saveTodo = (id: string, updates: Partial<Todo>) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
    const updated = { ...todos.find(t => t.id === id)!, ...updates };
    if (updates.dueDate) scheduleNotification(updated);
  };

  const addSubtask = (todoId: string, subtask: Subtask) =>
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, subtasks: [...t.subtasks, subtask] } : t));
  const toggleSubtask = (todoId: string, subtaskId: string) => {
    const todo = todos.find(t => t.id === todoId);
    const subtask = todo?.subtasks.find(s => s.id === subtaskId);
    const wasCompleted = subtask?.completed;
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, subtasks: t.subtasks.map(s => s.id === subtaskId ? { ...s, completed: !s.completed } : s) } : t));
    if (!wasCompleted) {
      // Award subtask XP
      setSubtaskXP(prev => prev + SUBTASK_XP);
      // Update streak
      setSubtaskStreak(prev => {
        const isToday = prev.date === today();
        return { count: isToday ? prev.count + 1 : 1, date: today() };
      });
      // Show floating reward
      const reward: SubtaskReward = {
        id: crypto.randomUUID(),
        message: ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)],
        xp: SUBTASK_XP,
        x: 20 + Math.random() * 60,
        y: 20 + Math.random() * 40,
      };
      setSubtaskRewards(prev => [...prev, reward]);
      setTimeout(() => setSubtaskRewards(prev => prev.filter(r => r.id !== reward.id)), 2200);
    }
  };
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
      setTodos(todos => {
        const updated = todos.map(td => td.id === todoId ? { ...td, totalTimeMs: (td.totalTimeMs || 0) + elapsed - (prev[todoId]?.elapsed || 0) } : td);
        // Check total time across all tasks
        const totalMs = updated.reduce((a, td) => a + (td.totalTimeMs || 0), 0);
        if (totalMs >= 3600000)  unlockAchievement("time_1hr");
        if (totalMs >= 36000000) unlockAchievement("time_10hr");
        return updated;
      });
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
    const newCount = brainDumpCount + 1;
    setBrainDumpCount(newCount);
    if (newCount >= 1)  unlockAchievement("dump_1");
    if (newCount >= 10) unlockAchievement("dump_10");
    showToast(`Captured ${newTodos.length} task${newTodos.length > 1 ? "s" : ""} from brain dump`);
  };

  const applyTemplate = (tpl: TaskTemplate) => {
    const newTodo: Todo = {
      id: crypto.randomUUID(), text: tpl.name, notes: tpl.notes,
      completed: false, priority: tpl.priority, dueDate: "",
      tags: [...tpl.tags], recur: "none", lastReset: today(),
      createdAt: Date.now(), totalTimeMs: 0, timeGoalMs: 0,
      subtasks: tpl.subtaskTexts.map(st => ({
        id: crypto.randomUUID(), text: st, completed: false,
        priority: "medium", dueDate: "", createdAt: Date.now(), totalTimeMs: 0,
      })),
    };
    setTodos(prev => [newTodo, ...prev]);
    setShowTemplates(false);
    showToast(`Created task from template: ${tpl.name}`);
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

  // ── Auth gate ────────────────────────────────────────────────────────────────
  if (loadingAuth || loadingData) {
    return (
      <div className="auth-overlay">
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"1rem" }}>
          <div className="auth-spinner" style={{ width:32, height:32, borderWidth:"3px" as unknown as number }} />
          <p style={{ color:"var(--text-muted)", fontSize:"0.9rem" }}>Loading your tasks…</p>
        </div>
      </div>
    );
  }
  if (showReset) return <ResetPasswordModal onDone={() => { setShowReset(false); }} />;
  if (!user) return <AuthModal />;
  if (showOnboarding) return (
    <OnboardingFlow
      onComplete={(name) => {
        setUserName(name);
        setOnboardingComplete(true);
        setShowOnboarding(false);
      }}
    />
  );

  return (
    <div className="app">
      {/* Mobile hamburger */}
      <button className="hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Open menu">
        {sidebarOpen ? "✕" : "☰"}
      </button>
      {/* Sidebar overlay */}
      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />
      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-icon">▣</span>
          <span className="brand-name">TaskFlow</span>
          <button className="theme-toggle" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} title="Toggle theme">
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
        <nav className="nav">
          {(["all","active","done"] as Filter[]).map(f => (
            <button key={f} className={`nav-btn ${filter === f && !tagFilter ? "active" : ""}`}
              onClick={() => { setFilter(f); setTagFilter(null); setSidebarOpen(false); }}>
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

        <XPBar taskXP={taskXP} subtaskXP={subtaskXP} subtaskStreak={subtaskStreak}
          unlockedCount={achievements.filter(a=>a.unlockedAt).length}
          totalCount={achievements.length}
          onShowAchievements={() => setShowAchievements(true)} />

        <div className="sidebar-actions">
          <button className="sidebar-action-btn" onClick={() => setShowBrainDump(true)}>🧠 Brain Dump <kbd>B</kbd></button>
          <button className="sidebar-action-btn" onClick={() => setShowFocusMode(true)}>🎯 Focus Mode</button>
          <button className="sidebar-action-btn" onClick={() => setShowTemplates(true)}>📋 Templates</button>
          <button className="sidebar-action-btn" onClick={() => setShowWeeklyReview(true)}>📆 Weekly Review</button>
          <button className="sidebar-action-btn" onClick={() => setShowArchive(true)}>
            📦 Archive {archive.length > 0 && <span className="archive-count">{archive.length}</span>}
          </button>
          <button className="sidebar-action-btn" onClick={() => setShowStats(s => !s)}>📊 Stats</button>
          <button className="sidebar-action-btn" onClick={exportCSV}>⬇ Export CSV</button>
          <button className="sidebar-action-btn" onClick={copyToClipboard}>⎘ Copy List</button>
          <button className="sidebar-action-btn" onClick={() => setShowShortcuts(s => !s)}>? Shortcuts</button>
          <button className="sidebar-action-btn sign-out-btn" onClick={signOut} title={user?.email}>
            ⎋ Sign Out
          </button>
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
            <p className="header-sub">
              {userName ? `${getGreeting()}, ${userName}! · ` : ""}{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
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
                  onSaveTimeGoal={saveTimeGoal}
                  onArchive={archiveTodo} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* Subtask reward overlays */}
      {subtaskRewards.map(r => <MiniConfetti key={r.id} reward={r} />)}

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

      {/* Badge Unlock */}
      {unlockedBadge && <BadgeUnlock achievement={unlockedBadge} onDone={() => setUnlockedBadge(null)} />}

      {/* Achievements */}
      {showAchievements && <AchievementsPanel achievements={achievements} onClose={() => setShowAchievements(false)} />}

      {/* Focus Mode */}
      {showFocusMode && (
        <FocusMode todos={todos} focusId={focusTaskId}
          onSetFocus={setFocusTaskId} onToggle={toggleTodo} onClose={() => setShowFocusMode(false)} />
      )}

      {/* Templates */}
      {showTemplates && (
        <TemplatesModal templates={templates} onApply={applyTemplate}
          onDelete={id => setTemplates(prev => prev.filter(t => t.id !== id))}
          onAdd={t => setTemplates(prev => [...prev, t])}
          onClose={() => setShowTemplates(false)} />
      )}

      {/* Weekly Review */}
      {showWeeklyReview && (
        <WeeklyReview todos={todos} taskXP={taskXP} subtaskXP={subtaskXP}
          achievements={achievements} onClose={() => setShowWeeklyReview(false)} />
      )}

      {/* Archive */}
      {showArchive && (
        <ArchivePanel
          archive={archive}
          onRestore={restoreFromArchive}
          onDelete={deleteFromArchive}
          onClose={() => setShowArchive(false)} />
      )}

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
      <AIFocusSuggest todos={todos} />
    </div>
  );
}
