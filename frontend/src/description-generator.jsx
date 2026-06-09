import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import { fileToBase64, generateInvoiceDescription } from "./data.js";

// DescriptionGeneratorModal — AI project-description generator for one Invoice
// row. Collects up to 2 project documents + up to 2 client testimonials + up
// to 2 technical testimonials (each testimonial is inline text OR a file) plus
// generation options, calls the generate-description Edge Function (OpenAI
// Responses API), and shows an editable draft the user can Accept / Reject /
// Regenerate. Accepting writes the text into the existing Description field via
// onAccept. All inputs are EPHEMERAL — held in modal state for the session
// (reused on Regenerate) and dropped on close.

const ACCEPT_DOCS =
  ".pdf,.doc,.docx,.txt,.md,.rtf,.odt," +
  "application/pdf," +
  "application/msword," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "text/plain,text/markdown";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — mirrors the Edge Function cap
const STYLE_OPTIONS = ["Civil Engineer", "Project Manager", "Executive level", "Custom"];
const TENSE_OPTIONS = [
  { value: "past",    label: "Past" },
  { value: "present", label: "Present" },
  { value: "future",  label: "Future" },
];

const EXT_MIME = {
  pdf:  "application/pdf",
  doc:  "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt:  "text/plain",
  md:   "text/markdown",
  rtf:  "application/rtf",
  odt:  "application/vnd.oasis.opendocument.text",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function mimeFor(file) {
  if (file?.type) return file.type;
  const ext = (file?.name || "").split(".").pop()?.toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}
function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
const wordCount = (s) => (s || "").trim() ? (s || "").trim().split(/\s+/).length : 0;

// ---- A compact, capped drag/drop file picker (reuses .invoice-dropzone) ----
function FileDrop({ files, onChange, max, accept, label }) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const depth = useRef(0);
  const atMax = files.length >= max;

  const add = (list) => {
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const seen = new Set(files.map(f => `${f.name}::${f.size}::${f.lastModified || 0}`));
    const next = files.slice();
    for (const f of incoming) {
      if (next.length >= max) break;
      if (f.size > MAX_FILE_BYTES) continue;
      const k = `${f.name}::${f.size}::${f.lastModified || 0}`;
      if (!seen.has(k)) { next.push(f); seen.add(k); }
    }
    onChange(next);
  };
  const remove = (i) => onChange(files.filter((_, j) => j !== i));

  return (
    <div className="gen-filedrop">
      {!atMax && (
        <div
          className={"invoice-dropzone gen-dropzone" + (drag ? " dragover" : "")}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); depth.current++; setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDrag(false); }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); depth.current = 0; setDrag(false); add(e.dataTransfer?.files); }}
          role="button" tabIndex={0}
          aria-label={`Add ${label}`}
        >
          <div className="invoice-dropzone-prompt">
            <Icon name="export" size={14}/>
            <span>{drag ? "Drop to attach" : `Drop or browse — ${label} (${files.length}/${max})`}</span>
          </div>
          <input
            ref={inputRef} type="file" accept={accept} multiple
            style={{ display: "none" }}
            onChange={(e) => { add(e.target.files); e.target.value = ""; }}
          />
        </div>
      )}
      {files.length > 0 && (
        <ul className="invoice-staged-list gen-staged">
          {files.map((f, i) => (
            <li key={`${f.name}::${f.size}::${i}`}>
              <Icon name="check" size={12}/>
              <span className="invoice-staged-name mono" title={f.name}>{f.name}</span>
              <span className="invoice-staged-size mono subtle">{fmtBytes(f.size)}</span>
              <button type="button" className="invoice-staged-remove" onClick={() => remove(i)} aria-label={`Remove ${f.name}`}>
                <Icon name="x" size={11}/>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- One testimonial slot (text ⇄ file segmented toggle) -------------------
function TestimonialSlot({ slot, onChange, onRemove, accept }) {
  const inputRef = useRef(null);
  return (
    <div className="gen-testimonial">
      <div className="gen-seg">
        <button type="button" className={"gen-seg-btn" + (slot.mode === "text" ? " on" : "")}
          onClick={() => onChange({ ...slot, mode: "text" })}>Text</button>
        <button type="button" className={"gen-seg-btn" + (slot.mode === "file" ? " on" : "")}
          onClick={() => onChange({ ...slot, mode: "file" })}>File</button>
        <button type="button" className="gen-testimonial-remove" onClick={onRemove} aria-label="Remove testimonial">
          <Icon name="x" size={12}/>
        </button>
      </div>
      {slot.mode === "text" ? (
        <textarea className="input gen-textarea-sm" rows={2}
          placeholder="Paste a quote or testimonial…"
          value={slot.text} onChange={(e) => onChange({ ...slot, text: e.target.value })}/>
      ) : (
        <div className="gen-file-slot">
          {slot.file ? (
            <div className="invoice-staged-list gen-staged"><div>
              <Icon name="check" size={12}/>
              <span className="invoice-staged-name mono" title={slot.file.name}>{slot.file.name}</span>
              <span className="invoice-staged-size mono subtle">{fmtBytes(slot.file.size)}</span>
              <button type="button" className="invoice-staged-remove" onClick={() => onChange({ ...slot, file: null })} aria-label="Remove file">
                <Icon name="x" size={11}/>
              </button>
            </div></div>
          ) : (
            <>
              <button type="button" className="btn ghost sm" onClick={() => inputRef.current?.click()}>
                <Icon name="export" size={12}/> Choose file
              </button>
              <input ref={inputRef} type="file" accept={accept} style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size <= MAX_FILE_BYTES) onChange({ ...slot, file: f });
                  e.target.value = "";
                }}/>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TestimonialGroup({ title, slots, setSlots, max = 2, accept }) {
  const add = () => { if (slots.length < max) setSlots([...slots, { mode: "text", text: "", file: null }]); };
  return (
    <div className="gen-tgroup">
      <div className="gen-subhead">
        <span>{title}</span>
        <button type="button" className="btn ghost sm" onClick={add} disabled={slots.length >= max}>
          <Icon name="plus" size={11}/> Add{slots.length ? ` (${slots.length}/${max})` : ""}
        </button>
      </div>
      {slots.length === 0 && <div className="gen-empty">None added</div>}
      {slots.map((s, i) => (
        <TestimonialSlot key={i} slot={s} accept={accept}
          onChange={(ns) => setSlots(slots.map((x, j) => j === i ? ns : x))}
          onRemove={() => setSlots(slots.filter((_, j) => j !== i))}/>
      ))}
    </div>
  );
}

export function DescriptionGeneratorModal({ meta, onAccept, onClose, acceptLabel = "Accept & save" }) {
  const [projectDocs, setProjectDocs] = useState([]);
  const [clientT, setClientT] = useState([]);
  const [techT, setTechT] = useState([]);

  const [targetWords, setTargetWords] = useState(250);
  const [paragraphs, setParagraphs] = useState(3);
  const [tense, setTense] = useState("past");
  const [style, setStyle] = useState("Civil Engineer");
  const [customStyle, setCustomStyle] = useState("");
  const [keywords, setKeywords] = useState("");
  const [paragraphTitles, setParagraphTitles] = useState("");

  const [phase, setPhase] = useState("idle"); // idle | generating | result | error
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const busy = phase === "generating";
  const hasResult = phase === "result";

  const requestClose = useCallback(() => {
    if (busy) return;            // never close mid-generation
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); requestClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const buildPayload = async () => {
    const docs = await Promise.all(projectDocs.map(async (f) => ({
      filename: f.name, mime: mimeFor(f), dataB64: await fileToBase64(f),
    })));
    const mapT = (slots) => Promise.all(slots.map(async (s) => {
      if (s.mode === "file" && s.file) {
        return { kind: "file", filename: s.file.name, mime: mimeFor(s.file), dataB64: await fileToBase64(s.file) };
      }
      return { kind: "text", text: s.text || "" };
    }));
    const splitList = (s) => (s || "").split(/[\n,]/).map(x => x.trim()).filter(Boolean);
    return {
      project: { name: meta.name || "", number: meta.projectNumber || "" },
      projectDocs: docs,
      clientTestimonials: (await mapT(clientT)).filter(t => t.kind === "file" || (t.text || "").trim()),
      techTestimonials:   (await mapT(techT)).filter(t => t.kind === "file" || (t.text || "").trim()),
      options: {
        targetWords: Number(targetWords) || null,
        paragraphs:  Number(paragraphs) || null,
        tense,
        paragraphTitles: splitList(paragraphTitles),
        keywords: splitList(keywords),
        style,
        customStyle: style === "Custom" ? customStyle.trim() : null,
      },
    };
  };

  const generate = async () => {
    setPhase("generating");
    setError("");
    try {
      const payload = await buildPayload();
      const text = await generateInvoiceDescription(payload);
      setResult(text);
      setPhase("result");
    } catch (e) {
      setError(e.message || "Generation failed.");
      setPhase("error");
    }
  };

  const reject = () => { setResult(""); setPhase("idle"); };
  const accept = () => { onAccept(meta.id, result); };

  const constraintChips = [
    targetWords ? `~${targetWords} words` : null,
    paragraphs ? `${paragraphs} ¶` : null,
    `${tense} tense`,
    style === "Custom" ? (customStyle.trim() || "custom voice") : style,
  ].filter(Boolean);

  return createPortal(
    <>
      <div className="overlay gen-overlay" onClick={phase === "idle" ? requestClose : undefined}/>
      <div className="modal gen-modal" style={{ width: 640 }}>
        <div className="modal-head">
          <div className="note-modal-badge gen-badge"><Icon name="sparkles" size={15}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>Generate Description · AI</div>
            <h3 className="drawer-title note-modal-name" title={meta.name}>{meta.name || "Project"}</h3>
          </div>
          <button className="drawer-close" onClick={requestClose} title="Close" disabled={busy}>
            <Icon name="x" size={16}/>
          </button>
        </div>

        <div className="modal-body gen-body">
          {/* ---- Sources ---- */}
          <div className="gen-section-label"><Icon name="link" size={11}/> Sources</div>
          <div className="gen-field">
            <div className="gen-subhead"><span>Project documents</span><span className="gen-count">{projectDocs.length}/2</span></div>
            <FileDrop files={projectDocs} onChange={setProjectDocs} max={2} accept={ACCEPT_DOCS} label="PDF or Word"/>
          </div>
          <div className="gen-two">
            <TestimonialGroup title="Client testimonials" slots={clientT} setSlots={setClientT} accept={ACCEPT_DOCS}/>
            <TestimonialGroup title="Technical testimonials" slots={techT} setSlots={setTechT} accept={ACCEPT_DOCS}/>
          </div>

          {/* ---- Options ---- */}
          <div className="gen-section-label" style={{ marginTop: 14 }}><Icon name="settings" size={11}/> Options</div>
          <div className="gen-options">
            <label className="gen-opt">
              <span>Target words</span>
              <input className="input" type="number" min={50} max={2000} step={25}
                value={targetWords} onChange={(e) => setTargetWords(e.target.value)}/>
            </label>
            <label className="gen-opt">
              <span>Paragraphs</span>
              <input className="input" type="number" min={1} max={12}
                value={paragraphs} onChange={(e) => setParagraphs(e.target.value)}/>
            </label>
            <label className="gen-opt">
              <span>Tense</span>
              <select className="select" value={tense} onChange={(e) => setTense(e.target.value)}>
                {TENSE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="gen-opt">
              <span>Writing style</span>
              <select className="select" value={style} onChange={(e) => setStyle(e.target.value)}>
                {STYLE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            {style === "Custom" && (
              <label className="gen-opt gen-opt-wide">
                <span>Custom voice</span>
                <input className="input" placeholder="e.g. plain-spoken, persuasive, technical…"
                  value={customStyle} onChange={(e) => setCustomStyle(e.target.value)}/>
              </label>
            )}
            <label className="gen-opt gen-opt-wide">
              <span>Keywords <em>(comma-separated)</em></span>
              <input className="input" placeholder="coastal restoration, levee, hydraulic modeling…"
                value={keywords} onChange={(e) => setKeywords(e.target.value)}/>
            </label>
            <label className="gen-opt gen-opt-wide">
              <span>Paragraph titles <em>(optional, comma-separated)</em></span>
              <input className="input" placeholder="Overview, Scope, Outcomes…"
                value={paragraphTitles} onChange={(e) => setParagraphTitles(e.target.value)}/>
            </label>
          </div>

          {/* ---- Result ---- */}
          {(hasResult || busy) && (
            <div className="gen-result-block">
              <div className="gen-section-label" style={{ marginTop: 14 }}>
                <Icon name="alignLeft" size={11}/> Draft
                {hasResult && <span className="gen-count" style={{ marginLeft: "auto" }}>{wordCount(result)} words</span>}
              </div>
              {busy ? (
                <div className="gen-skeleton" aria-live="polite">
                  <span className="gen-shimmer-line"/><span className="gen-shimmer-line"/>
                  <span className="gen-shimmer-line short"/>
                  <div className="gen-skeleton-label"><Icon name="sparkles" size={12}/> Generating…</div>
                </div>
              ) : (
                <textarea className="input gen-result" value={result}
                  onChange={(e) => setResult(e.target.value)} rows={9}/>
              )}
            </div>
          )}

          {phase === "error" && (
            <div className="gen-error"><Icon name="warn" size={13}/> {error}</div>
          )}
        </div>

        <div className="modal-foot gen-foot">
          <div className="gen-chips">
            {constraintChips.map((c, i) => <span key={i} className="gen-chip">{c}</span>)}
          </div>
          <div className="gen-foot-actions">
            {hasResult ? (
              <>
                <button className="btn sm" onClick={reject}>Reject</button>
                <button className="btn sm" onClick={generate} disabled={busy}>
                  <Icon name="refresh" size={13}/> Regenerate
                </button>
                <button className="btn primary sm" onClick={accept}>
                  <Icon name="check" size={13}/> {acceptLabel}
                </button>
              </>
            ) : (
              <>
                <button className="btn sm" onClick={requestClose} disabled={busy}>Cancel</button>
                <button className={"btn primary sm gen-go" + (busy ? " is-busy" : "")} onClick={generate} disabled={busy}>
                  <Icon name="sparkles" size={13}/> {busy ? "Generating…" : (phase === "error" ? "Try again" : "Generate")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
