// Supabase Edge Function · generate-description
//
// Generates a project write-up / description for the Invoice tab using the
// OpenAI Responses API. Called from the browser via supabase.functions.invoke
// ("generate-description") — the caller's session JWT is auto-attached.
//
// Input sources are EPHEMERAL: the frontend base64-encodes up to 2 project
// documents + up to 2 client testimonials + up to 2 tech testimonials (each
// testimonial is either inline text or a file), and POSTs them here with the
// generation options. Files are relayed straight to OpenAI as `input_file`
// content parts — the Responses API extracts text from PDF/Word/Excel/PPT/txt
// itself (PDFs also yield page images on vision models), so no server-side
// document parsing is needed. Nothing is persisted; the generated text is
// returned to the browser, where the user edits/accepts it into the existing
// anticipated_invoice.description column.
//
// Deploy:
//   supabase functions deploy generate-description --project-ref ggqlcsppojypgaiyhods
//
// Required secrets (set via `supabase secrets set ... --project-ref ...`):
//   OPENAI_API_KEY            OpenAI dashboard → API keys (server-only)
//   OPENAI_DESC_MODEL         optional; default "gpt-5.4-mini"
//
// Auto-injected by the Supabase runtime:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//
// Caller auth: a valid Supabase session JWT for any beacon_v2.users row (no
// admin requirement, no anon). The JWT is verified via an anon-key client +
// users-table lookup, mirroring send-alert's user-JWT path.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY        = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPENAI_API_KEY  = Deno.env.get("OPENAI_API_KEY") || "";
const OPENAI_MODEL    = Deno.env.get("OPENAI_DESC_MODEL") || "gpt-5.4-mini";
const OPENAI_URL      = "https://api.openai.com/v1/responses";

// Caps — defense in depth alongside the client-side limits. Files are relayed
// to OpenAI inline as base64; OpenAI allows 50 MB/file and 50 MB/request, but
// we keep the Supabase request body modest.
const MAX_PER_CATEGORY  = 2;
const MAX_FILE_BYTES    = 10 * 1024 * 1024;   // 10 MB raw per file
const MAX_TOTAL_BYTES   = 24 * 1024 * 1024;   // ~24 MB raw across all files

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

interface FileInput  { filename?: string; mime?: string; dataB64?: string }
interface Testimonial { kind: "text" | "file"; text?: string; filename?: string; mime?: string; dataB64?: string }
interface Options {
  targetWords?: number | null;
  paragraphs?: number | null;
  tense?: "past" | "present" | "future";
  paragraphTitles?: string[] | null;
  keywords?: string[];
  style?: string;
  customStyle?: string | null;
}
interface Body {
  project?: { name?: string; number?: string };
  projectDocs?: FileInput[];
  clientTestimonials?: Testimonial[];
  techTestimonials?: Testimonial[];
  options?: Options;
}

// Rough byte size of a base64 string (4 chars → 3 bytes, minus padding).
function b64Bytes(b64: string): number {
  if (!b64) return 0;
  const len = b64.length;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_file"; filename: string; file_data: string };

// One OpenAI Responses request, with an optional `temperature`. Returns the
// parsed JSON or throws with the API error message.
async function callOpenAI(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `OpenAI ${res.status}`;
    const err = new Error(msg) as Error & { status?: number; code?: string; param?: string };
    err.status = res.status;
    err.code = data?.error?.code;
    err.param = data?.error?.param;
    throw err;
  }
  return data;
}

// Pull the generated text out of a Responses API result. Prefer the
// convenience aggregate `output_text`; otherwise walk output[].content[].
function extractText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const out = Array.isArray(data?.output) ? data.output : [];
  const chunks: string[] = [];
  for (const item of out) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string") chunks.push(c.text);
    }
  }
  return chunks.join("").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  // Auth: a valid session JWT belonging to any beacon_v2.users row.
  const bearer = (req.headers.get("authorization") || req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    db: { schema: "beacon_v2" },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: uErr } = await userClient.auth.getUser();
  if (uErr || !u?.user) return json({ ok: false, error: "invalid session" }, 401);
  const { data: me, error: meErr } = await userClient
    .from("users")
    .select("id")
    .eq("auth_user_id", u.user.id)
    .maybeSingle();
  if (meErr)  return json({ ok: false, error: "profile lookup failed" }, 500);
  if (!me)    return json({ ok: false, error: "forbidden" }, 403);

  if (!OPENAI_API_KEY) return json({ ok: false, error: "OPENAI_API_KEY not configured" }, 500);

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const projectDocs = (body.projectDocs || []).slice(0, MAX_PER_CATEGORY);
  const clientT     = (body.clientTestimonials || []).slice(0, MAX_PER_CATEGORY);
  const techT       = (body.techTestimonials || []).slice(0, MAX_PER_CATEGORY);
  const opt         = body.options || {};

  // Validate file sizes up front.
  let totalBytes = 0;
  const allFiles: FileInput[] = [
    ...projectDocs,
    ...clientT.filter(t => t.kind === "file"),
    ...techT.filter(t => t.kind === "file"),
  ];
  for (const f of allFiles) {
    const n = b64Bytes(f.dataB64 || "");
    if (n > MAX_FILE_BYTES) {
      return json({ ok: false, error: `"${f.filename || "file"}" is too large (max 10 MB each)` }, 400);
    }
    totalBytes += n;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return json({ ok: false, error: "Attached files are too large in total (max ~24 MB). Remove one and try again." }, 400);
  }

  // ---- Build the prompt ----------------------------------------------------
  const projName = (body.project?.name || "").trim();
  const projNum  = (body.project?.number || "").trim();
  const tense    = opt.tense === "present" ? "present" : opt.tense === "future" ? "future" : "past";
  const keywords = (opt.keywords || []).map(k => k.trim()).filter(Boolean);
  const titles   = (opt.paragraphTitles || []).map(t => (t || "").trim()).filter(Boolean);
  const style    = (opt.style || "").trim();
  const styleResolved = style.toLowerCase() === "custom"
    ? (opt.customStyle || "").trim() || "professional"
    : style || "professional";

  const constraints: string[] = [];
  if (projName) constraints.push(`Project name: ${projName}`);
  if (projNum)  constraints.push(`Project number: ${projNum}`);
  if (opt.targetWords) constraints.push(`Target length: approximately ${opt.targetWords} words (stay within ±10%).`);
  if (opt.paragraphs)  constraints.push(`Number of paragraphs: exactly ${opt.paragraphs}.`);
  constraints.push(`Tense: write in the ${tense} tense.`);
  constraints.push(`Writing style / voice: ${styleResolved}.`);
  if (keywords.length) constraints.push(`Keywords to weave in naturally (do not list them): ${keywords.join(", ")}.`);
  if (titles.length) {
    constraints.push(
      `Paragraph titles: use these as bold-style headings, one per paragraph, in order: ${titles.join(" | ")}. ` +
      `Put each title on its own line above its paragraph.`,
    );
  } else {
    constraints.push("Do not add section headings or titles — write flowing prose only.");
  }

  const textParts: string[] = [
    "Write a polished project write-up / description for an engineering firm (MSMM Engineering), suitable for proposals and qualifications packages.",
    "",
    "CONSTRAINTS:",
    ...constraints.map(c => `- ${c}`),
  ];

  const inlineTextTestimonials = [
    ...clientT.filter(t => t.kind === "text" && (t.text || "").trim()).map(t => ({ label: "CLIENT TESTIMONIAL", text: t.text!.trim() })),
    ...techT.filter(t => t.kind === "text" && (t.text || "").trim()).map(t => ({ label: "TECHNICAL TESTIMONIAL", text: t.text!.trim() })),
  ];
  if (inlineTextTestimonials.length) {
    textParts.push("", "TESTIMONIALS / QUOTES (use verbatim only if quoting; otherwise paraphrase):");
    for (const t of inlineTextTestimonials) textParts.push(`- ${t.label}: ${t.text}`);
  }

  const hasFiles = allFiles.length > 0;
  if (hasFiles) {
    textParts.push("", "Source documents are attached below. Ground all factual claims in the attached documents and the testimonials above; do not invent specifics (numbers, dates, parties) that are not supported by the sources.");
  } else if (!inlineTextTestimonials.length) {
    textParts.push("", "No source documents were provided — base the description on the project name and keywords above, and keep claims general rather than inventing specific figures.");
  }

  const content: ContentPart[] = [{ type: "input_text", text: textParts.join("\n") }];

  let docIdx = 0;
  for (const f of projectDocs) {
    if (!f.dataB64) continue;
    docIdx++;
    content.push({ type: "input_text", text: `PROJECT DOCUMENT ${docIdx} (${f.filename || "document"}):` });
    content.push({ type: "input_file", filename: f.filename || `document-${docIdx}`, file_data: `data:${f.mime || "application/pdf"};base64,${f.dataB64}` });
  }
  const pushFileTestimonials = (arr: Testimonial[], label: string) => {
    let i = 0;
    for (const t of arr) {
      if (t.kind !== "file" || !t.dataB64) continue;
      i++;
      content.push({ type: "input_text", text: `${label} ${i} (${t.filename || "file"}):` });
      content.push({ type: "input_file", filename: t.filename || `${label.toLowerCase()}-${i}`, file_data: `data:${t.mime || "application/pdf"};base64,${t.dataB64}` });
    }
  };
  pushFileTestimonials(clientT, "CLIENT TESTIMONIAL FILE");
  pushFileTestimonials(techT, "TECHNICAL TESTIMONIAL FILE");

  const instructions =
    "You are a senior proposal writer for a civil/coastal engineering firm. " +
    "Produce a clear, confident, factual project description in plain prose. " +
    "Obey every constraint exactly (tense, word count, paragraph count, style, keywords, paragraph titles). " +
    "Never fabricate facts, figures, clients, or outcomes that are not supported by the provided sources. " +
    "Output only the description text — no preamble, no markdown code fences, no bullet lists unless explicitly requested.";

  const basePayload: Record<string, unknown> = {
    model: OPENAI_MODEL,
    instructions,
    input: [{ role: "user", content }],
  };
  if (opt.targetWords) {
    // Generous cap: billing is per ACTUAL token (the cap only truncates), and
    // reasoning-tier models (gpt-5.x) spend hidden reasoning tokens before the
    // visible answer — too tight a cap returns empty text. The prompt is what
    // actually controls the length.
    basePayload.max_output_tokens = Math.min(8000, Math.max(2000, Math.round(opt.targetWords * 4) + 512));
  }

  // First attempt includes temperature for natural prose; if the model rejects
  // the parameter (some newer models do), retry once without it.
  try {
    let data;
    try {
      data = await callOpenAI({ ...basePayload, temperature: 0.6 });
    } catch (e) {
      const err = e as Error & { status?: number; param?: string };
      if (err.status === 400 && /temperature/i.test(`${err.param || ""} ${err.message || ""}`)) {
        data = await callOpenAI(basePayload);
      } else {
        throw err;
      }
    }
    const text = extractText(data);
    if (!text) return json({ ok: false, error: "The model returned no text. Try again or adjust your inputs." }, 502);
    return json({ ok: true, text, model: OPENAI_MODEL });
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return json({ ok: false, error: (err.message || "generation failed").slice(0, 500) }, status);
  }
});
