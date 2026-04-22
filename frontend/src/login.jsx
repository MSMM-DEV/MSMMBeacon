import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { signIn, fetchCurrentBeaconUser } from "./data.js";

// ============================================================================
// LoginPage — entry gate before the Beacon dashboard loads.
//
// Layout: editorial two-column split. Left pane holds a beacon mark, eyebrow,
// and a couple of orientation lines (what Beacon is). Right pane is a minimal
// credentials form. Both sides share the same warm palette as the app itself.
// Collapses to a single centered card on narrow viewports.
//
// Success path: calls signIn() → fetchCurrentBeaconUser() → parent's
// onSignedIn(beaconUser) handler. Parent uses the returned row's role to
// branch Admin-only UI.
// ============================================================================

export const LoginPage = ({ onSignedIn }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const emailRef = useRef(null);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (pending) return;
    const em = email.trim().toLowerCase();
    if (!em || !password) {
      setError("Enter both email and password.");
      return;
    }
    setError("");
    setPending(true);
    const { ok, error: err } = await signIn(em, password);
    if (!ok) {
      // GoTrue's generic "Invalid login credentials" is fine to surface; other
      // errors (rate limit, no internet) come through as-is.
      setError(err?.message || "Sign-in failed. Double-check your credentials.");
      setPending(false);
      return;
    }
    const beaconUser = await fetchCurrentBeaconUser();
    if (!beaconUser) {
      // Edge case: auth.users row exists but beacon.users row doesn't (e.g.
      // seed script ran for someone not in the roster). Don't strand them.
      setError("Signed in, but no matching Beacon profile was found. Contact an admin.");
      setPending(false);
      return;
    }
    onSignedIn(beaconUser);
  };

  return (
    <div className="login">
      <aside className="login-hero" aria-hidden="true">
        <div className="hero-grain"/>
        <div className="hero-stripe stripe-a"/>
        <div className="hero-stripe stripe-b"/>
        <div className="hero-stripe stripe-c"/>

        <div className="hero-top">
          <div className="brand">
            <div className="brand-mark"/>
            <span>Beacon</span>
          </div>
          <div className="brand-sub">MSMM · Project Lifecycle</div>
        </div>

        <div className="hero-body">
          <div className="hero-eyebrow">Signal in the pipeline</div>
          <h1 className="hero-title">
            Every project.<br/>
            <em>One</em> source of truth.
          </h1>
          <p className="hero-copy">
            A shared ledger for Potential, Awaiting Verdict, Awarded, SOQ, Closed-out,
            and the Anticipated Invoice. Board-ready at a glance; row-level when you need it.
          </p>
          <ul className="hero-list">
            <li><span className="dot"/>Carry-forward across every stage</li>
            <li><span className="dot"/>Actual vs. projection, driven by today's date</li>
            <li><span className="dot"/>Row-level alerts with deep links</li>
          </ul>
        </div>

        <div className="hero-foot">
          <span>© MSMM Engineering</span>
          <span className="mono">v · 2026</span>
        </div>
      </aside>

      <main className="login-panel">
        <form className="login-card" onSubmit={submit} noValidate>
          <div className="login-card-head">
            <div className="login-eyebrow">Sign in</div>
            <h2 className="login-title">Welcome back</h2>
            <p className="login-sub">Use your MSMM email to continue.</p>
          </div>

          <label className="login-field">
            <span className="login-label">Email</span>
            <span className="login-input-wrap">
              <Icon name="mail" size={14}/>
              <input
                ref={emailRef}
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@msmmeng.com"
                disabled={pending}
                required
              />
            </span>
          </label>

          <label className="login-field">
            <span className="login-label">Password</span>
            <span className="login-input-wrap">
              <Icon name="lock" size={14}/>
              <input
                type={showPw ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={pending}
                required
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowPw((v) => !v)}
                tabIndex={-1}
                aria-label={showPw ? "Hide password" : "Show password"}
                disabled={pending}
              >
                <Icon name={showPw ? "eyeOff" : "eye"} size={14}/>
              </button>
            </span>
          </label>

          {error && (
            <div className="login-error" role="alert">
              <Icon name="x" size={13}/>
              <span>{error}</span>
            </div>
          )}

          <button className="login-submit" type="submit" disabled={pending}>
            {pending ? (
              <>
                <span className="login-spin"/>
                Signing in…
              </>
            ) : (
              <>
                <Icon name="forward" size={14}/>
                Sign in
              </>
            )}
          </button>

          <div className="login-hint">
            <Icon name="lock" size={11}/>
            Forgot your password? Ask an administrator to reset it.
          </div>
        </form>
      </main>
    </div>
  );
};
