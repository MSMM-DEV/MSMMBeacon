import React from "react";
import { Icon } from "./icons.jsx";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Switch,
} from "@/ui";

// Each accent ships TWO palettes — light + dark — for the three derived
// tokens (ink / soft / softer). applyTweaks selects the right set based on
// `tweaks.theme`. Without this split, switching to dark mode would leave the
// derived tokens at their light-mode hex (cream/beige), breaking every
// surface that paints with --accent-soft / --accent-softer / --accent-ink
// (chrome-search active, anchor chips, tag pills, role badges, …). The dark
// values mirror the [data-theme="dark"] defaults in styles.css.
export const ACCENTS = [
  {
    key: "#C8823B", name: "amber",    label: "Amber",  accent: "#C8823B",
    light: { ink: "#6B3F10", soft: "#F2E2CB", softer: "#F8ECD6" },
    dark:  { ink: "#FBE8CE", soft: "#3D2B18", softer: "#2E2116" },
  },
  {
    key: "#7E8F6F", name: "sage",     label: "Sage",   accent: "#7E8F6F",
    light: { ink: "#3F4D30", soft: "#D6DFC6", softer: "#E7EDDD" },
    dark:  { ink: "#D6E2C7", soft: "#2F3A26", softer: "#232A1C" },
  },
  {
    key: "#6A86A6", name: "ocean",    label: "Ocean",  accent: "#6A86A6",
    light: { ink: "#334B66", soft: "#C8D4E3", softer: "#DCE4EE" },
    dark:  { ink: "#D6E1EF", soft: "#283648", softer: "#1F2A38" },
  },
  {
    key: "#B86B66", name: "rose",     label: "Rose",   accent: "#B86B66",
    light: { ink: "#6F302C", soft: "#E5BDB9", softer: "#EFD5D2" },
    dark:  { ink: "#F2D1CE", soft: "#3D2422", softer: "#2D1A19" },
  },
  {
    key: "#4F5759", name: "charcoal", label: "Mono",   accent: "#4F5759",
    light: { ink: "#1E2325", soft: "#C8CDCF", softer: "#DADEDF" },
    dark:  { ink: "#E3E6E7", soft: "#2C3133", softer: "#22272A" },
  },
];

export const FONT_PAIRS = [
  { key: "inter_plex",       label: "Inter · Plex Mono" },
  { key: "fraunces_plex",    label: "Fraunces · Plex" },
  { key: "instrument_geist", label: "Instrument · Geist" },
  { key: "geist_jetbrains",  label: "Geist · JetBrains" },
];

// The stacks each pair actually resolves to, mirroring the [data-font="…"]
// blocks in design/tokens.css. `inter_plex` has no block of its own, so it
// renders with the :root defaults — the preview shows what will really be
// painted rather than a family the app never loads.
const FONT_PREVIEW = {
  inter_plex: {
    display: '"Geist", ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
  fraunces_plex: {
    display: '"Fraunces", Georgia, "Times New Roman", serif',
    mono: '"IBM Plex Mono", ui-monospace, monospace',
  },
  instrument_geist: {
    display: '"Instrument Serif", Georgia, "Times New Roman", serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
  geist_jetbrains: {
    display: '"Geist", ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
};

// ---------------------------------------------------------------------------
// Live preview — a miniature of the real chrome (display type, tabular money,
// a status badge, a row at the current density) so every control below shows
// its effect instead of describing it. Inert: aria-hidden + not focusable, so
// it is never a stop for keyboard or screen-reader users.
// ---------------------------------------------------------------------------
const AppearancePreview = () => (
  <div className="tw-preview" aria-hidden="true">
    <div className="tw-preview-bar">
      <span className="tw-preview-mark" />
      <span className="tw-preview-title">Quad Sheet</span>
      <Badge tone="brand">Awaiting</Badge>
    </div>
    <div className="tw-preview-rows">
      <div className="tw-preview-row">
        <span className="tw-preview-cell">Levee inspection</span>
        <span className="tw-preview-num num">$184,000</span>
      </div>
      <div className="tw-preview-row">
        <span className="tw-preview-cell">Pump station rehab</span>
        <span className="tw-preview-num num">$62,400</span>
      </div>
    </div>
    <div className="tw-preview-foot">
      <span className="tw-preview-btn tw-preview-btn-primary">Save</span>
      <span className="tw-preview-btn">Cancel</span>
    </div>
  </div>
);

// One settings row: label + explanation on the left, control on the right.
const TweakRow = ({ id, title, hint, children, stacked = false }) => (
  <div className={"tw-row" + (stacked ? " tw-row-stacked" : "")}>
    <div className="tw-row-text">
      <Label
        htmlFor={id}
        className="tw-row-title normal-case tracking-[var(--tracking-snug)] text-[length:var(--fs-sm)] font-semibold text-[var(--text)]"
      >
        {title}
      </Label>
      {hint ? <p className="tw-row-hint">{hint}</p> : null}
    </div>
    <div className="tw-row-control">{children}</div>
  </div>
);

const AccentPicker = ({ id, value, onSelect }) => {
  const current = ACCENTS.find(a => a.key === value) || ACCENTS[0];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button id={id} variant="default" size="sm" className="tw-accent-trigger justify-start gap-2">
          <span className="tw-swatch" style={{ background: current.accent }} aria-hidden="true" />
          <span>{current.label}</span>
          <Icon name="chevronDown" size={14} className="ml-auto" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[228px] p-2">
        <RadioGroup
          value={value}
          onValueChange={onSelect}
          aria-label="Accent color"
          className="gap-0.5"
        >
          {ACCENTS.map(a => {
            const id = `tw-accent-${a.name}`;
            const on = a.key === value;
            return (
              <label key={a.key} htmlFor={id} className={"tw-accent-opt" + (on ? " is-on" : "")}>
                <RadioGroupItem id={id} value={a.key} className="sr-only" />
                <span className="tw-swatch tw-swatch-lg" style={{ background: a.accent }} aria-hidden="true" />
                <span className="tw-accent-name">{a.label}</span>
                {on ? <Icon name="check" size={14} className="tw-accent-check" /> : null}
              </label>
            );
          })}
        </RadioGroup>
      </PopoverContent>
    </Popover>
  );
};

const FontPicker = ({ value, onSelect }) => (
  <RadioGroup
    value={value}
    onValueChange={onSelect}
    aria-label="Font pairing"
    className="tw-fonts"
  >
    {FONT_PAIRS.map(f => {
      const id = `tw-font-${f.key}`;
      const on = f.key === value;
      const stacks = FONT_PREVIEW[f.key] || FONT_PREVIEW.geist_jetbrains;
      return (
        <label key={f.key} htmlFor={id} className={"tw-font" + (on ? " is-on" : "")}>
          <RadioGroupItem id={id} value={f.key} className="tw-font-radio" />
          <span className="tw-font-body">
            <span className="tw-font-sample" style={{ fontFamily: stacks.display }}>Aa</span>
            <span className="tw-font-meta">
              <span className="tw-font-label">{f.label}</span>
              <span className="tw-font-num" style={{ fontFamily: stacks.mono }}>1,284.06</span>
            </span>
          </span>
        </label>
      );
    })}
  </RadioGroup>
);

// ---------------------------------------------------------------------------
// AppearanceSettings — the preferences panel itself, with no chrome of its
// own so it can sit inline (Admin → Appearance) or inside the standalone
// TweaksPanel dialog below.
// ---------------------------------------------------------------------------
export const AppearanceSettings = ({ tweaks, setTweak }) => {
  const isDark = tweaks.theme === "dark";
  const isCompact = tweaks.density === "compact";

  return (
    <div className="tw-panel">
      <AppearancePreview />

      <div className="tw-rows">
        <TweakRow
          id="tw-theme"
          title="Dark theme"
          hint={isDark ? "Warm charcoal surfaces for low light." : "Warm paper surfaces for daylight."}
        >
          <span className="tw-switch-wrap">
            <Icon name="sun" size={14} className={isDark ? "tw-mode-off" : "tw-mode-on"} />
            <Switch
              id="tw-theme"
              checked={isDark}
              onCheckedChange={(on) => setTweak("theme", on ? "dark" : "light")}
            />
            <Icon name="moon" size={14} className={isDark ? "tw-mode-on" : "tw-mode-off"} />
          </span>
        </TweakRow>

        <TweakRow
          id="tw-density"
          title="Compact rows"
          hint={isCompact ? "Tighter rows, more records per screen." : "Roomier rows, easier to scan."}
        >
          <Switch
            id="tw-density"
            checked={isCompact}
            onCheckedChange={(on) => setTweak("density", on ? "compact" : "comfortable")}
          />
        </TweakRow>

        <TweakRow
          id="tw-accent"
          title="Accent color"
          hint="Used for primary actions, selection and in-progress status."
        >
          <AccentPicker id="tw-accent" value={tweaks.accent} onSelect={(v) => setTweak("accent", v)} />
        </TweakRow>

        <TweakRow
          title="Font pairing"
          hint="Headings and figures. Body copy stays on the same reading size."
          stacked
        >
          <FontPicker value={tweaks.fontPair} onSelect={(v) => setTweak("fontPair", v)} />
        </TweakRow>
      </div>
    </div>
  );
};

// Standalone floating panel (topbar entry point). A Dialog rather than a
// hand-rolled box so Escape, focus trapping and aria wiring come for free.
export const TweaksPanel = ({ tweaks, setTweak, onClose }) => (
  <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent size="sm">
      <DialogHeader>
        <DialogTitle>Appearance</DialogTitle>
        <DialogDescription>
          Saved to this browser only. Every signed-in device keeps its own settings.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <AppearanceSettings tweaks={tweaks} setTweak={setTweak} />
      </DialogBody>
    </DialogContent>
  </Dialog>
);

export const applyTweaks = (tweaks) => {
  const theme = tweaks.theme || "light";
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-density", tweaks.density || "comfortable");
  document.documentElement.setAttribute("data-font", tweaks.fontPair || "geist_jetbrains");
  const a = ACCENTS.find(x => x.key === tweaks.accent) || ACCENTS[0];
  const variant = theme === "dark" ? a.dark : a.light;
  const r = document.documentElement.style;
  r.setProperty("--accent", a.accent);
  r.setProperty("--accent-ink", variant.ink);
  r.setProperty("--accent-soft", variant.soft);
  r.setProperty("--accent-softer", variant.softer);
};
