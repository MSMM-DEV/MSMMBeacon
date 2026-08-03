import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { signIn, fetchCurrentBeaconUser } from "./data.js";
import { PwaInstallChip } from "./pwa-ui.jsx";
import { Alert, Button, Field, InputGroup } from "@/ui";

// ============================================================================
// LoginPage — entry gate before the Beacon dashboard loads.
//
// Layout: two columns. The left column is a branded panel on a dark ochre
// ground — wordmark, a single statement, and the four pipeline stages the
// product is actually built around (Leads & Bids → Proposals → Awarded →
// Anticipated Invoice), so a returning user is oriented rather than sold to.
// The right column is the credentials form, built entirely on the @/ui kit
// (Field / InputGroup / Button / Alert) so it inherits the app's focus ring,
// hover, active, disabled and loading treatments for free.
//
// Below `lg` the branded panel collapses to a short header band (mark +
// wordmark only) instead of squeezing; the statement, stage list and panel
// footer drop out. Nothing is hidden that the form needs.
//
// Panel-local colour lives in the `LOGIN v2` block at the end of styles.css —
// the panel is a dark ground in BOTH themes, so it cannot read --text /
// --text-muted (which invert per theme) and needs its own scoped ink vars.
//
// Success path: calls signIn() → fetchCurrentBeaconUser() → parent's
// onSignedIn(beaconUser) handler. Parent uses the returned row's role to
// branch Admin-only UI. Unchanged from v1.
// ============================================================================

// Id for the error region so both inputs can point at it via aria-describedby.
const ERROR_ID = "login-error";

// The product's real pipeline, copy lifted from the page descriptions in
// App.jsx so the panel can never drift from what the app actually does.
const STAGES = [
  { n: "01", label: "Leads & Bids",        note: "Opportunities and RFQ/RFPs under evaluation" },
  { n: "02", label: "Proposals",           note: "Submitted, awaiting a verdict" },
  { n: "03", label: "Awarded",             note: "Won contracts, tracked against capacity" },
  { n: "04", label: "Anticipated Invoice", note: "Monthly billing, actual against projection" },
];

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

  const invalid = error ? true : undefined;
  const describedBy = error ? ERROR_ID : undefined;

  return (
    <div className="lgn-root grid min-h-[100dvh] w-full grid-rows-[auto_minmax(0,1fr)] bg-[var(--bg)] text-[var(--text)] lg:grid-cols-[minmax(0,1.02fr)_minmax(0,1fr)] lg:grid-rows-1">

      {/* ---------------------------------------------------------------- */}
      {/* Branded panel. Real content, not decoration, so it stays in the   */}
      {/* accessibility tree; it carries no heading so the form keeps the   */}
      {/* page's single <h1>.                                              */}
      {/* ---------------------------------------------------------------- */}
      <section
        aria-label="About Beacon"
        className="lgn-brand relative isolate flex min-w-0 flex-col justify-between gap-6 overflow-hidden px-[var(--page-gutter)] py-4 sm:px-8 sm:py-8 lg:gap-10 lg:px-12 lg:py-12 xl:px-16 3xl:px-24"
      >
        <div className="relative z-[1] flex items-center gap-3">
          <span className="lgn-mark size-9 shrink-0 lg:size-10" aria-hidden="true" />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="font-display text-[length:var(--fs-lg)] font-semibold tracking-[var(--tracking-tight)] text-[var(--lgn-ink)]">
              Beacon
            </span>
            <span className="truncate font-mono text-[length:var(--fs-2xs)] uppercase tracking-[var(--tracking-caps)] text-[var(--lgn-ink-3)]">
              MSMM Engineering
            </span>
          </span>
        </div>

        {/* Three tiers, so the panel thins out instead of squeezing:
            below sm it is the mark band alone, at sm it gains the
            statement (a masthead), at lg it becomes the full panel. */}
        <div className="relative z-[1] hidden min-w-0 sm:block">
          <p className="m-0 font-mono text-[length:var(--fs-2xs)] uppercase tracking-[var(--tracking-caps)] text-[var(--lgn-accent)]">
            Project lifecycle, one ledger
          </p>
          <span className="mt-3 mb-4 block h-px w-10 bg-[var(--lgn-rule-2)] lg:mt-4 lg:mb-5" aria-hidden="true" />
          <p className="m-0 max-w-[24ch] font-display text-[length:clamp(26px,2.3vw,34px)] font-semibold leading-[1.12] tracking-[var(--tracking-tight)] text-balance text-[var(--lgn-ink)] lg:max-w-[19ch]">
            From the first lead to the final invoice.
          </p>

          <div className="hidden lg:block">
            <p className="mt-4 mb-0 max-w-[46ch] text-[length:var(--fs-md)] leading-[var(--lh-relaxed)] text-pretty text-[var(--lgn-ink-2)]">
              One record per project, carried across every stage. What was bid, what
              was won, what is being billed, and what is still outstanding all read
              from the same numbers.
            </p>

            <ol className="mt-8 mb-0 grid max-w-[42ch] list-none border-l border-[var(--lgn-rule)] pl-5">
              {STAGES.map((s) => (
                <li key={s.n} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-baseline gap-x-3 py-2">
                  <span className="num font-mono text-[length:var(--fs-2xs)] tracking-[var(--tracking-wide)] text-[var(--lgn-accent)]">
                    {s.n}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[length:var(--fs-sm)] font-semibold text-[var(--lgn-ink)]">
                      {s.label}
                    </span>
                    <span className="block text-[length:var(--fs-xs)] leading-[var(--lh-snug)] text-[var(--lgn-ink-3)]">
                      {s.note}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="relative z-[1] hidden items-center justify-between gap-4 text-[length:var(--fs-2xs)] text-[var(--lgn-ink-3)] lg:flex">
          <span>© MSMM Engineering</span>
          <span className="font-mono uppercase tracking-[var(--tracking-caps)]">Internal use only</span>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Credentials form.                                                */}
      {/* ---------------------------------------------------------------- */}
      <main className="lgn-formcol flex min-w-0 items-center justify-center px-[var(--page-gutter)] py-10 sm:px-8 lg:py-12">
        <form
          className="flex w-full max-w-[380px] min-w-0 flex-col gap-4"
          onSubmit={submit}
          noValidate
        >
          <header className="flex flex-col gap-1.5 border-b border-[var(--border)] pb-5">
            <p className="m-0 font-mono text-[length:var(--fs-2xs)] uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
              Sign in
            </p>
            <h1 className="m-0 font-display text-[length:var(--fs-3xl)] font-semibold leading-[var(--lh-tight)] tracking-[var(--tracking-tight)] text-[var(--text)]">
              Welcome back
            </h1>
            <p className="m-0 text-[length:var(--fs-sm)] leading-[var(--lh-snug)] text-[var(--text-muted)]">
              Use your MSMM email address to continue.
            </p>
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
              inputClassName="h-11 rounded-[var(--radius)] text-[length:var(--fs-md)] sm:h-[var(--control-h-lg)]"
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
              inputClassName="h-11 rounded-[var(--radius)] pr-11 text-[length:var(--fs-md)] sm:h-[var(--control-h-lg)]"
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
                  // 36px on touch (the kit's icon-sm is 28px, below the
                  // 36px minimum target), back to icon-sm from `sm` up.
                  className="size-9 rounded-[var(--radius-xs)] text-[var(--text-soft)] aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent-ink)] sm:size-[var(--control-h-sm)]"
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
            // The size tokens in ui/button.jsx are written `text-[var(--fs-md)]`
            // without the `length:` hint, so Tailwind compiles them to
            // `color: var(--fs-md)` and wipes the variant's own text colour.
            // Restated here until the kit is fixed; see the report note.
            className="mt-1 h-11 rounded-[var(--radius)] text-[length:var(--fs-md)] font-semibold text-[var(--accent-on)] sm:h-[var(--control-h-lg)]"
          >
            {pending ? "Signing in…" : "Sign in"}
          </Button>

          <p className="m-0 flex items-start gap-2 text-[length:var(--fs-xs)] leading-[var(--lh-snug)] text-[var(--text-soft)]">
            <Icon name="key" size={13} className="mt-0.5 shrink-0" />
            <span>Forgot your password? Ask a Beacon administrator to reset it.</span>
          </p>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
            <span className="font-mono text-[length:var(--fs-2xs)] uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
              Beacon for MSMM
            </span>
            <PwaInstallChip />
          </div>
        </form>
      </main>
    </div>
  );
};
