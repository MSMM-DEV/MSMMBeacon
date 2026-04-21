import React from "react";
import { Icon } from "./icons.jsx";

export const ACCENTS = [
  { key: "#C8823B", name: "amber",   label: "Amber",  accent: "#C8823B", ink: "#6B3F10", soft: "#F2E2CB", softer: "#F8ECD6" },
  { key: "#7E8F6F", name: "sage",    label: "Sage",   accent: "#7E8F6F", ink: "#3F4D30", soft: "#D6DFC6", softer: "#E7EDDD" },
  { key: "#6A86A6", name: "ocean",   label: "Ocean",  accent: "#6A86A6", ink: "#334B66", soft: "#C8D4E3", softer: "#DCE4EE" },
  { key: "#B86B66", name: "rose",    label: "Rose",   accent: "#B86B66", ink: "#6F302C", soft: "#E5BDB9", softer: "#EFD5D2" },
  { key: "#4F5759", name: "charcoal",label: "Mono",   accent: "#4F5759", ink: "#1E2325", soft: "#C8CDCF", softer: "#DADEDF" },
];

export const FONT_PAIRS = [
  { key: "inter_plex",       label: "Inter · Plex Mono" },
  { key: "fraunces_plex",    label: "Fraunces · Plex" },
  { key: "instrument_geist", label: "Instrument · Geist" },
  { key: "geist_jetbrains",  label: "Geist · JetBrains" },
];

export const TweaksPanel = ({ tweaks, setTweak, onClose }) => (
  <div className="tweaks-panel">
    <div className="tweaks-head">
      <span><Icon name="settings" size={13}/> &nbsp;Tweaks</span>
      <button className="drawer-close" onClick={onClose}><Icon name="x" size={14}/></button>
    </div>
    <div className="tweaks-body">
      <div className="tweak-row">
        <div className="tweak-label">Accent color</div>
        <div className="swatches">
          {ACCENTS.map(a => (
            <div key={a.key}
              className={"swatch" + (tweaks.accent === a.key ? " active" : "")}
              style={{ background: a.accent }}
              title={a.label}
              onClick={() => setTweak("accent", a.key)}/>
          ))}
        </div>
      </div>
      <div className="tweak-row">
        <div className="tweak-label">Theme</div>
        <div className="seg">
          <button className={"seg-btn" + (tweaks.theme === "light" ? " active" : "")} onClick={() => setTweak("theme","light")}>
            <Icon name="sun" size={12}/> Light
          </button>
          <button className={"seg-btn" + (tweaks.theme === "dark" ? " active" : "")} onClick={() => setTweak("theme","dark")}>
            <Icon name="moon" size={12}/> Dark
          </button>
        </div>
      </div>
      <div className="tweak-row">
        <div className="tweak-label">Density</div>
        <div className="seg">
          <button className={"seg-btn" + (tweaks.density === "comfortable" ? " active" : "")} onClick={() => setTweak("density","comfortable")}>Comfortable</button>
          <button className={"seg-btn" + (tweaks.density === "compact" ? " active" : "")} onClick={() => setTweak("density","compact")}>Compact</button>
        </div>
      </div>
      <div className="tweak-row">
        <div className="tweak-label">Font pairing</div>
        <select className="select" value={tweaks.fontPair} onChange={e => setTweak("fontPair", e.target.value)}>
          {FONT_PAIRS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>
    </div>
  </div>
);

export const applyTweaks = (tweaks) => {
  document.documentElement.setAttribute("data-theme", tweaks.theme || "light");
  document.documentElement.setAttribute("data-density", tweaks.density || "comfortable");
  document.documentElement.setAttribute("data-font", tweaks.fontPair || "geist_jetbrains");
  const a = ACCENTS.find(x => x.key === tweaks.accent) || ACCENTS[0];
  const r = document.documentElement.style;
  r.setProperty("--accent", a.accent);
  r.setProperty("--accent-ink", a.ink);
  r.setProperty("--accent-soft", a.soft);
  r.setProperty("--accent-softer", a.softer);
};
