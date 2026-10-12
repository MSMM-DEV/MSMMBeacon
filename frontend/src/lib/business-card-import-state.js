import { releaseCardImages } from "./business-card-images.js";

export function initialImportState() {
  return {
    phase: "upload",
    images: [],
    chunks: [],
    candidates: [],
    failedChunks: [],
    reviewItems: [],
    fileErrors: [],
    error: "",
    notice: "",
    summary: null,
  };
}

export function cleanupPreviewUrls(images, revoke) {
  releaseCardImages(images, revoke);
}

export function replaceChunkCandidates(candidates, chunkId, incoming) {
  return [
    ...(candidates || []).filter(candidate => candidate._chunkId !== chunkId),
    ...(incoming || []),
  ];
}

export function zeroCardNotice(images, candidates) {
  const sources = new Set((candidates || []).map(candidate => candidate.sourceId).filter(Boolean));
  const empty = (images || []).filter(image => !sources.has(image.id));
  if (!empty.length) return "";
  const names = empty.slice(0, 3).map(image => image.filename).join(", ");
  const remainder = empty.length > 3 ? ` and ${empty.length - 3} more` : "";
  return `No cards were detected in ${names}${remainder}. You can return to photos and replace those images if needed.`;
}

function updateChunk(chunks, chunkId, patch) {
  return chunks.map(chunk => chunk.id === chunkId ? { ...chunk, ...patch } : chunk);
}

export function importReducer(state, action) {
  switch (action.type) {
    case "imagesAdded":
      return {
        ...state,
        images: [...state.images, ...(action.images || [])],
        fileErrors: [...state.fileErrors, ...(action.errors || [])],
        error: "",
      };
    case "imageRemoved":
      return { ...state, images: state.images.filter(image => image.id !== action.imageId) };
    case "fileErrorsCleared":
      return { ...state, fileErrors: [] };
    case "analysisStarted":
      return {
        ...state,
        phase: "analyzing",
        chunks: (action.chunks || []).map(chunk => ({ ...chunk, status: "pending", error: "" })),
        candidates: [],
        failedChunks: [],
        reviewItems: [],
        error: "",
        notice: "",
      };
    case "chunkRunning":
      return {
        ...state,
        chunks: updateChunk(state.chunks, action.chunkId, { status: "running", error: "" }),
        failedChunks: state.failedChunks.filter(chunk => chunk.chunkId !== action.chunkId),
      };
    case "chunkSucceeded": {
      const incoming = (action.candidates || []).map(candidate => ({ ...candidate, _chunkId: action.chunkId }));
      return {
        ...state,
        candidates: [
          ...state.candidates.filter(candidate => candidate._chunkId !== action.chunkId),
          ...incoming,
        ],
        failedChunks: state.failedChunks.filter(chunk => chunk.chunkId !== action.chunkId),
        chunks: updateChunk(state.chunks, action.chunkId, { status: "complete", error: "" }),
      };
    }
    case "chunkFailed":
      return {
        ...state,
        failedChunks: [
          ...state.failedChunks.filter(chunk => chunk.chunkId !== action.chunkId),
          { chunkId: action.chunkId, error: action.error || "Analysis failed" },
        ],
        chunks: updateChunk(state.chunks, action.chunkId, {
          status: "failed",
          error: action.error || "Analysis failed",
        }),
      };
    case "reviewReady":
      return {
        ...state,
        phase: "review",
        reviewItems: action.reviewItems || [],
        error: action.error || "",
        notice: action.notice || "",
      };
    case "reviewUpdated":
      return {
        ...state,
        reviewItems: state.reviewItems.map(item => item.id === action.itemId
          ? { ...item, ...action.patch }
          : item),
        error: "",
      };
    case "reviewsReplaced":
      return { ...state, phase: "review", reviewItems: action.reviewItems || [], error: action.error || "" };
    case "returnToUpload":
      return {
        ...state,
        phase: "upload",
        chunks: [],
        candidates: [],
        failedChunks: [],
        reviewItems: [],
        error: "",
        notice: "",
      };
    case "savingStarted":
      return { ...state, phase: "saving", error: "" };
    case "saveSucceeded":
      return {
        ...state,
        phase: "complete",
        images: [],
        chunks: [],
        candidates: [],
        failedChunks: [],
        reviewItems: [],
        fileErrors: [],
        summary: action.summary || {},
        error: "",
        notice: "",
      };
    case "error":
      return { ...state, phase: action.phase || state.phase, error: action.error || "Something went wrong." };
    case "reset":
      return initialImportState();
    default:
      return state;
  }
}
