import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { signIn, fetchCurrentBeaconUser } from "./data.js";
import { PwaInstallChip } from "./pwa-ui.jsx";
import { Alert, Button, Field, InputGroup } from "@/ui";

// ============================================================================
// LoginPage — entry gate before the Beacon dashboard loads.
//
// A compact brand header, contextual workspace introduction and one frosted
// credentials card. Supporting content drops away on phones to keep sign-in
// immediate. Presentation lives in design/pages/login.css and uses the shared
// light/dark tokens; auth behavior below is deliberately unchanged.
//
// Success path: calls signIn() → fetchCurrentBeaconUser() → parent's
// onSignedIn(beaconUser) handler. Parent uses the returned row's role to
// branch Admin-only UI. Unchanged from v1.
// ============================================================================

// Id for the error region so both inputs can point at it via aria-describedby.
const ERROR_ID = "login-error";

const WORKSPACE_AREAS = [
  { icon: "briefcase", label: "Projects", note: "Opportunities through awarded work" },
  { icon: "chart", label: "Billing", note: "Monthly actuals and projections" },
  { icon: "users", label: "People", note: "Team calendars, time and leave" },
];

export const LoginPage = ({ onSignedIn, theme = "light", onToggleTheme }) => {
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

  const invalid = error ? true : undefined;
  const describedBy = error ? ERROR_ID : undefined;

  return (
    <div className="beacon-login">
      <header className="beacon-login__masthead">
        <div className="beacon-login__identity">
          <span className="beacon-login__mark" aria-hidden="true">B</span>
          <span><strong>Beacon</strong><span>MSMM Engineering</span></span>
        </div>
        <div className="beacon-login__header-actions">
          <span className="beacon-login__workspace-label">Your team workspace</span>
          {onToggleTheme && <Button type="button" variant="ghost" size="icon" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={onToggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={18}/></Button>}
        </div>
      </header>

      <div className="beacon-login__layout">
        <section className="beacon-login__overview" aria-label="About Beacon">
          <p className="beacon-login__eyebrow">Connected by design</p>
          <p className="beacon-login__statement">A clear view of<br />the work ahead.</p>
          <p className="beacon-login__description">Projects, people and billing. One shared workspace for the details that keep MSMM moving.</p>
          <ul className="beacon-login__areas">
            {WORKSPACE_AREAS.map((area) => (
              <li key={area.label}>
                <span className="beacon-login__area-icon" aria-hidden="true"><Icon name={area.icon} size={19} /></span>
                <span><strong>{area.label}</strong><span>{area.note}</span></span>
              </li>
            ))}
          </ul>
        </section>

      <main className="beacon-login__form-column">
        <form
          className="beacon-login__form"
          onSubmit={submit}
          noValidate
          aria-busy={pending}
        >
          <header className="beacon-login__form-header">
            <span className="beacon-login__entry-icon" aria-hidden="true"><Icon name="lock" size={19} /></span>
            <h1>Welcome back</h1>
            <p>Sign in with your MSMM email to continue.</p>
          </header>

          <Field label="Email" htmlFor="login-email">
            <InputGroup
              id="login-email"
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
              aria-invalid={invalid}
              aria-describedby={describedBy}
              leading={<Icon name="mail" size={16} />}
              inputClassName="beacon-login__input"
            />
          </Field>

          <Field label="Password" htmlFor="login-password">
            <InputGroup
              id="login-password"
              type={showPw ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={pending}
              required
              aria-invalid={invalid}
              aria-describedby={describedBy}
              leading={<Icon name="lock" size={16} />}
              inputClassName="beacon-login__input beacon-login__password"
              trailing={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowPw((v) => !v)}
                  disabled={pending}
                  aria-label="Show password"
                  aria-pressed={showPw}
                  aria-controls="login-password"
                  className="beacon-login__password-toggle"
                >
                  <Icon name={showPw ? "eyeOff" : "eye"} size={16} />
                </Button>
              }
            />
          </Field>

          {error && (
            <Alert id={ERROR_ID} tone="danger" className="items-start gap-2.5 py-2.5 text-[length:var(--fs-sm)]">
              {error}
            </Alert>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={pending}
            disabled={pending}
            className="beacon-login__submit"
          >
            {pending ? "Signing in…" : "Sign in"}
            {!pending && <Icon name="forward" size={17} aria-hidden="true" />}
          </Button>

          <p className="beacon-login__help">
            <Icon name="key" size={13} className="mt-0.5 shrink-0" />
            <span>Forgot your password? Ask a Beacon administrator to reset it.</span>
          </p>

          <div className="beacon-login__form-footer">
            <span>Built for your workday</span>
            <PwaInstallChip />
          </div>
        </form>
      </main>
      </div>
      <footer className="beacon-login__footer"><span>© MSMM Engineering</span><span>Internal workspace</span></footer>
    </div>
  );
};
