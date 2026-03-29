// ═════════════════════════════════════════════════════════════════════════════
// TASKFLOW — SUPABASE INTEGRATION GUIDE
// ═════════════════════════════════════════════════════════════════════════════
//
// STEP 1 — Create a Supabase project (free)
// ─────────────────────────────────────────
//  1. Go to https://supabase.com → "Start for free"
//  2. Create a new project (note your region & password)
//  3. Go to: SQL Editor → New Query
//     Paste the entire contents of schema.sql and click Run
//  4. Go to: Project Settings → API
//     Copy "Project URL" and "anon/public" key
//
// STEP 2 — Add env vars
// ──────────────────────
//  Create a file called .env in your project root (same level as package.json):
//
//    VITE_SUPABASE_URL=https://your-project-id.supabase.co
//    VITE_SUPABASE_ANON_KEY=eyJhbGci...your-anon-key...
//
//  Add .env to your .gitignore if it isn't already!
//
// STEP 3 — Install the Supabase client
// ──────────────────────────────────────
//  Run in your terminal:
//    npm install @supabase/supabase-js
//
// STEP 4 — Add new files to your src/ folder
// ────────────────────────────────────────────
//  Create: src/lib/supabase.ts        ← paste contents of supabase.ts
//  Create: src/hooks/useSupabaseSync.ts ← paste contents of useSupabaseSync.ts
//
// STEP 5 — Update App.tsx
// ────────────────────────
//  A) Add this import at the top of App.tsx:
//
//     import { useSupabaseSync } from "./hooks/useSupabaseSync";
//
//  B) Add the AuthModal component into App.tsx (paste from AuthModal.tsx),
//     just before the `export default function App()` line.
//
//  C) Inside the App() function, add these lines near the top
//     (right after all the useState declarations, around line 1220):
//
//     const { user, loadingAuth, loadingData, initialData, saveData, signOut } = useSupabaseSync();
//
//     // Load initial data from Supabase when user signs in
//     useEffect(() => {
//       if (!initialData) return;
//       setTodos(initialData.todos);
//       setTaskXP(initialData.taskXP);
//       setSubtaskXP(initialData.subtaskXP);
//       setSubtaskStreak(initialData.subtaskStreak);
//       setAchievements(initialData.achievements);
//       setArchive(initialData.archive);
//       setBrainDumpCount(initialData.brainDumpCount);
//       setDailyStreak(initialData.dailyStreak);
//       setTemplates(initialData.templates);
//       setTheme(initialData.theme);
//     }, [initialData]);
//
//     // Save to Supabase whenever state changes (debounced 1.5s)
//     useEffect(() => {
//       if (!user) return;
//       saveData({ todos, taskXP, subtaskXP, subtaskStreak, achievements,
//                  archive, brainDumpCount, dailyStreak, templates, theme });
//     }, [todos, taskXP, subtaskXP, subtaskStreak, achievements,
//         archive, brainDumpCount, dailyStreak, templates, theme]);
//
//  D) Show loading screen while auth initializes. Add this BEFORE the main
//     return statement in App():
//
//     if (loadingAuth || loadingData) {
//       return (
//         <div className="auth-overlay">
//           <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"1rem" }}>
//             <div className="auth-spinner" style={{ width:32, height:32, borderWidth:3 }} />
//             <p style={{ color:"var(--text-muted)", fontSize:"0.9rem" }}>Loading your tasks…</p>
//           </div>
//         </div>
//       );
//     }
//     if (!user) return <AuthModal />;
//
//  E) Add a Sign Out button to the sidebar. Find the sidebar-actions div
//     and add this button:
//
//     <button className="sidebar-action-btn" onClick={signOut}
//       style={{ color: "var(--text-muted)", marginTop: "auto" }}>
//       ⎋ Sign Out ({user?.email})
//     </button>
//
//  F) REMOVE the old localStorage reads (the useState initializers that call
//     localStorage.getItem). They'll be replaced by Supabase.
//     Change these lines (around 1148–1210):
//
//     // BEFORE:
//     const [todos, setTodos] = useState<Todo[]>(() => {
//       try { return JSON.parse(localStorage.getItem("taskflow-todos") || "[]"); } catch { return []; }
//     });
//
//     // AFTER — start with empty defaults, Supabase fills them in:
//     const [todos, setTodos] = useState<Todo[]>([]);
//
//     Do the same for: taskXP, subtaskXP, subtaskStreak, achievements,
//     archive, brainDumpCount, dailyStreak, templates, theme
//     (replace all the localStorage.getItem initializers with simple defaults)
//
//  G) REMOVE the old localStorage.setItem useEffects (the ones that save
//     to localStorage). Search for `localStorage.setItem` and delete those
//     useEffect blocks — Supabase handles persistence now.
//
// STEP 6 — Add CSS
// ─────────────────
//  Paste the CSS block from AuthModal.tsx (inside the /* */ comment)
//  into the bottom of App.css.
//
// ═════════════════════════════════════════════════════════════════════════════
// That's it! Your data now lives in Postgres in the cloud. ☁️
// ═════════════════════════════════════════════════════════════════════════════
