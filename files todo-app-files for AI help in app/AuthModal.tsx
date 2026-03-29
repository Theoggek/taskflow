// ─────────────────────────────────────────────────────────────────────────────
// AuthModal component + CSS
//
// PASTE the component into App.tsx (before the App() function).
// PASTE the CSS into App.css.
// ─────────────────────────────────────────────────────────────────────────────

// ─── AuthModal ────────────────────────────────────────────────────────────────
import { supabase } from "./lib/supabase"; // adjust path as needed

function AuthModal() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);
    setInfo(null);
    if (!email.trim() || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setInfo("Account created! Check your email to confirm, then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange in useSupabaseSync will handle the rest
      }
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <div className="auth-brand">
          <span className="auth-brand-icon">▣</span>
          <span className="auth-brand-name">TaskFlow</span>
        </div>
        <h2 className="auth-title">{mode === "signin" ? "Welcome back" : "Create an account"}</h2>
        <p className="auth-subtitle">
          {mode === "signin"
            ? "Sign in to access your tasks from anywhere."
            : "Your data will sync across all your devices."}
        </p>

        {error && <div className="auth-error">{error}</div>}
        {info  && <div className="auth-info">{info}</div>}

        <div className="auth-fields">
          <input
            className="auth-input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
            autoFocus
          />
          <input
            className="auth-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        </div>

        <button className="auth-submit" onClick={submit} disabled={loading}>
          {loading
            ? <span className="auth-spinner" />
            : mode === "signin" ? "Sign In" : "Create Account"}
        </button>

        <p className="auth-switch">
          {mode === "signin" ? "Don't have an account? " : "Already have one? "}
          <button
            className="auth-switch-btn"
            onClick={() => { setMode(m => m === "signin" ? "signup" : "signin"); setError(null); setInfo(null); }}
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   AuthModal CSS — paste into App.css
   ═══════════════════════════════════════════════════════════════════════════ */

/*
.auth-overlay {
  position: fixed; inset: 0; z-index: 500;
  background: rgba(10, 12, 18, 0.92);
  display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(6px);
}
.auth-modal {
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 18px;
  padding: 2.5rem 2rem;
  width: 100%; max-width: 380px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(79,142,247,0.1);
  display: flex; flex-direction: column; gap: 1rem;
}
.auth-brand {
  display: flex; align-items: center; gap: 0.6rem;
  justify-content: center; margin-bottom: 0.25rem;
}
.auth-brand-icon { font-size: 1.3rem; color: var(--accent); }
.auth-brand-name { font-size: 1.1rem; font-weight: 700; }

.auth-title {
  font-size: 1.35rem; font-weight: 700;
  color: var(--text); text-align: center; margin: 0;
}
.auth-subtitle {
  font-size: 0.82rem; color: var(--text-muted);
  text-align: center; line-height: 1.5; margin-top: -0.4rem;
}

.auth-error {
  background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3);
  color: var(--red); border-radius: 8px;
  padding: 0.6rem 0.85rem; font-size: 0.8rem; line-height: 1.4;
}
.auth-info {
  background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3);
  color: var(--green); border-radius: 8px;
  padding: 0.6rem 0.85rem; font-size: 0.8rem; line-height: 1.4;
}

.auth-fields { display: flex; flex-direction: column; gap: 0.65rem; }
.auth-input {
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 9px; padding: 0.7rem 0.9rem;
  color: var(--text); font-family: 'Inter', sans-serif; font-size: 0.88rem;
  width: 100%; outline: none;
  transition: border-color 0.15s;
}
.auth-input:focus { border-color: var(--accent); }
.auth-input::placeholder { color: var(--text-dim); }

.auth-submit {
  background: var(--accent); color: #fff;
  border: none; border-radius: 9px;
  padding: 0.75rem; font-family: 'Inter', sans-serif;
  font-size: 0.9rem; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, transform 0.1s;
}
.auth-submit:hover:not(:disabled) { background: #3a7de8; transform: translateY(-1px); }
.auth-submit:disabled { opacity: 0.5; cursor: not-allowed; }

.auth-spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
}

.auth-switch {
  font-size: 0.8rem; color: var(--text-muted); text-align: center;
}
.auth-switch-btn {
  background: none; border: none; color: var(--accent);
  font-size: 0.8rem; cursor: pointer; padding: 0;
  font-family: 'Inter', sans-serif; font-weight: 600;
}
.auth-switch-btn:hover { text-decoration: underline; }
*/
