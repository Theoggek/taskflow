// src/hooks/useSupabaseSync.ts
//
// Handles loading user data from Supabase on sign-in,
// and debounced saving whenever app state changes.

import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabase";
import type { User } from "@supabase/supabase-js";

// ── Types (mirror what App.tsx uses) ─────────────────────────────────────────
// Import these from App.tsx if you split into modules, or keep them inline.
type Priority = "low" | "medium" | "high";
type RecurInterval = "none" | "daily" | "weekly";

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
interface ArchivedTodo extends Todo { archivedAt: number; completedAt: number; }
interface Achievement { id: string; title: string; description: string; icon: string; unlockedAt: number | null; }
interface TaskTemplate {
  id: string; name: string; icon: string; priority: Priority;
  tags: string[]; notes: string; subtaskTexts: string[];
}

export interface AppState {
  todos: Todo[];
  taskXP: number;
  subtaskXP: number;
  subtaskStreak: { count: number; date: string };
  achievements: Achievement[];
  archive: ArchivedTodo[];
  brainDumpCount: number;
  dailyStreak: { days: string[] };
  templates: TaskTemplate[];
  theme: "dark" | "light";
}

interface SyncHookReturn {
  user: User | null;
  loadingAuth: boolean;
  loadingData: boolean;
  initialData: AppState | null;
  saveData: (state: AppState) => void;
  signOut: () => Promise<void>;
}

const DEBOUNCE_MS = 1500;

export function useSupabaseSync(): SyncHookReturn {
  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [initialData, setInitialData] = useState<AppState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStateRef = useRef<AppState | null>(null);

  // ── Load data for a given user ─────────────────────────────────────────────
  const loadUserData = useCallback(async (uid: string) => {
    setLoadingData(true);
    try {
      const { data, error } = await supabase
        .from("user_data")
        .select("*")
        .eq("user_id", uid)
        .single();

      if (error && error.code !== "PGRST116") {
        // PGRST116 = no rows found (first-time user), that's fine
        console.error("Failed to load data:", error.message);
      }

      if (data) {
        setInitialData({
          todos:          data.todos          ?? [],
          taskXP:         data.task_xp        ?? 0,
          subtaskXP:      data.subtask_xp     ?? 0,
          subtaskStreak:  data.subtask_streak ?? { count: 0, date: "" },
          achievements:   data.achievements   ?? [],
          archive:        data.archive        ?? [],
          brainDumpCount: data.brain_dump_count ?? 0,
          dailyStreak:    data.daily_streak   ?? { days: [] },
          templates:      data.templates      ?? [],
          theme:          data.theme          ?? "dark",
        });
      } else {
        // First time user — start fresh (App.tsx defaults will apply)
        setInitialData(null);
      }
    } finally {
      setLoadingData(false);
    }
  }, []);

  // ── Listen for auth changes ────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) loadUserData(session.user.id);
      setLoadingAuth(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        loadUserData(u.id);
      } else {
        setInitialData(null);
      }
    });

    return () => subscription.unsubscribe();
  }, [loadUserData]);

  // ── Debounced save ─────────────────────────────────────────────────────────
  const saveData = useCallback((state: AppState) => {
    if (!user) return;
    pendingStateRef.current = state;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const s = pendingStateRef.current;
      if (!s || !user) return;
      try {
        await supabase.from("user_data").upsert({
          user_id:          user.id,
          todos:            s.todos,
          task_xp:          s.taskXP,
          subtask_xp:       s.subtaskXP,
          subtask_streak:   s.subtaskStreak,
          achievements:     s.achievements,
          archive:          s.archive,
          brain_dump_count: s.brainDumpCount,
          daily_streak:     s.dailyStreak,
          templates:        s.templates,
          theme:            s.theme,
        }, { onConflict: "user_id" });
      } catch (err) {
        console.error("Failed to save data:", err);
      }
    }, DEBOUNCE_MS);
  }, [user]);

  const signOut = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await supabase.auth.signOut();
  }, []);

  return { user, loadingAuth, loadingData, initialData, saveData, signOut };
}
