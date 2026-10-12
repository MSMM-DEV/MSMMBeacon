export const MAX_CARD_FILES = 20;
export const MAX_CARD_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CARD_CHUNK_BYTES = 25 * 1024 * 1024;
export const MAX_CARD_CHUNK_COUNT = 8;

const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const EXTENSION_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

function fileMime(file) {
  const declared = String(file?.type || "").toLowerCase();
  if (declared) return declared;
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  return EXTENSION_MIME[extension] || "";
}

export function validateCardFiles(files, { existingCount = 0, maxFiles = MAX_CARD_FILES } = {}) {
  const accepted = [];
  const rejected = [];
  for (const file of Array.from(files || [])) {
    const mime = fileMime(file);
    let error = "";
    if (!ACCEPTED_MIME_TYPES.has(mime)) {
      error = "Unsupported image format. Use JPEG, PNG, WebP, HEIC, or HEIF.";
    } else if (!Number.isFinite(Number(file?.size)) || Number(file.size) <= 0) {
      error = "This image is empty or its size could not be read.";
    } else if (Number(file.size) > MAX_CARD_FILE_BYTES) {
      error = "This image is larger than the 10 MB limit.";
    } else if (existingCount + accepted.length >= maxFiles) {
      error = `An import can contain at most ${maxFiles} images.`;
    }
    if (error) rejected.push({ file, name: file?.name || "image", error });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("The browser could not encode this image.")),
      "image/jpeg",
      0.86,
    );
  });
}

function blobToBase64(blob) {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("The normalized image could not be read."));
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
}

function loadWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, objectUrl });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This phone image format cannot be decoded by this browser. Try sharing it as JPEG."));
    };
    image.src = objectUrl;
  });
}

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {
      // Safari may reject HEIC here but still decode it through an Image.
    }
  }
  const fallback = await loadWithImageElement(file);
  return {
    ...fallback,
    close: () => URL.revokeObjectURL(fallback.objectUrl),
  };
}

export async function normalizeCardImage(file, { id } = {}) {
  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("The image has no readable dimensions.");
    const maxDimension = 2048;
    const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The browser could not prepare this image.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(decoded.source, 0, 0, width, height);
    const blob = await canvasBlob(canvas);
    const dataB64 = await blobToBase64(blob);
    const previewUrl = URL.createObjectURL(blob);
    return {
      id: id || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `card-${Date.now()}`),
      filename: file?.name || "business-card.jpg",
      mime: "image/jpeg",
      width,
      height,
      originalByteSize: Number(file?.size) || 0,
      byteSize: blob.size,
      blob,
      dataB64,
      previewUrl,
    };
  } finally {
    decoded.close?.();
  }
}

export function chunkCardImages(images, {
  maxBytes = MAX_CARD_CHUNK_BYTES,
  maxCount = MAX_CARD_CHUNK_COUNT,
} = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(maxCount) || maxCount <= 0) {
    throw new Error("Image chunk limits must be positive numbers.");
  }
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const image of images || []) {
    const size = Number(image?.byteSize) || 0;
    if (size > maxBytes) throw new Error(`${image?.filename || image?.id || "An image"} is too large for one analysis request.`);
    if (current.length && (current.length >= maxCount || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(image);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function releaseCardImages(images, revoke = url => URL.revokeObjectURL(url)) {
  const urls = new Set();
  for (const image of images || []) {
    if (image?.previewUrl) urls.add(image.previewUrl);
  }
  for (const url of urls) revoke(url);
  for (const image of images || []) {
    if (!image || typeof image !== "object") continue;
    image.previewUrl = null;
    image.dataB64 = null;
    image.blob = null;
  }
}
