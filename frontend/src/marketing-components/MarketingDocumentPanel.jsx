import React, { useRef, useState } from "react";
import { Alert, Badge, Button, EmptyState } from "@/ui";
import { Icon } from "../icons.jsx";
import { getMarketingDocumentSignedUrl, removeMarketingDocument, uploadMarketingDocument } from "../data.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg"]);
const DOCUMENT_TYPES = ["Proposal", "SOW", "MSA", "Contract", "Supporting"];

export function validateMarketingDocument(file) {
  if (!file) return "Choose a file.";
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return "Use PDF, DOC/DOCX, XLS/XLSX, PNG, or JPEG.";
  if (file.size > MAX_FILE_BYTES) return "Files must be 25 MiB or smaller.";
  return null;
}

export function MarketingDocumentPanel({ opportunityId, documents = [], onChanged }) {
  const inputRef = useRef(null);
  const [documentType, setDocumentType] = useState("Supporting");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [cleanupRow, setCleanupRow] = useState(null);
  const upload = async event => {
    const file = event.target.files?.[0];
    const validation = validateMarketingDocument(file);
    if (validation) { setError(validation); event.target.value = ""; return; }
    setSaving(true); setError("");
    try { onChanged?.([...documents, await uploadMarketingDocument({ opportunityId, documentType, file })]); }
    catch (uploadError) { setError(uploadError.message || "The document could not be uploaded."); }
    finally { setSaving(false); event.target.value = ""; }
  };
  const download = async row => {
    try { window.open(await getMarketingDocumentSignedUrl(row.filePath), "_blank", "noopener,noreferrer"); }
    catch (downloadError) { setError(downloadError.message || "The document could not be opened."); }
  };
  const remove = async row => {
    setError("");
    try { await removeMarketingDocument({ id: row.id, filePath: row.filePath }); onChanged?.(documents.filter(item => item.id !== row.id)); setCleanupRow(null); }
    catch (removeError) {
      setError(removeError.message || "The document could not be removed.");
      if (removeError.code === "MARKETING_DOCUMENT_CLEANUP") setCleanupRow(row);
    }
  };
  return <section className="marketing-document-panel"><div className="marketing-document-actions"><select aria-label="Document type" value={documentType} onChange={event => setDocumentType(event.target.value)}>{DOCUMENT_TYPES.map(type => <option key={type}>{type}</option>)}</select><input ref={inputRef} className="sr-only" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" onChange={upload}/><Button variant="primary" loading={saving} onClick={() => inputRef.current?.click()}><Icon name="upload"/>Upload document</Button></div>{error && <Alert role="alert" tone="danger" title="Document action failed">{error}{cleanupRow && <Button size="sm" variant="default" onClick={() => remove(cleanupRow)}>Retry cleanup</Button>}</Alert>}{documents.length ? <div className="marketing-document-list">{documents.map(row => <article key={row.id}><Icon name="file"/><div><strong>{row.fileName}</strong><span>{row.sizeBytes ? `${(row.sizeBytes / 1048576).toFixed(1)} MiB` : ""}</span></div><Badge tone="neutral">{row.documentType}</Badge><Button size="sm" variant="default" onClick={() => download(row)}><Icon name="download"/>Open</Button><Button size="sm" variant="ghost" onClick={() => remove(row)}><Icon name="trash"/>Remove</Button></article>)}</div> : <EmptyState iconName="file" title="No documents yet" hint="Upload proposals, SOWs, MSAs, contracts, or supporting files."/>}</section>;
}

export default MarketingDocumentPanel;
