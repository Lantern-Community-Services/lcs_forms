/**
 * Sending a photo or file to the server. Every upload in the app goes through
 * here (File fields, code forms, share links), so the same two things happen
 * everywhere:
 *
 *  - Photos are shrunk on the device first (shrinkImage): a phone's 12 MP photo
 *    is several MB, and a page of them filled the database and took ages on a
 *    building's Wi-Fi. A photo stays clear at 2048 px.
 *  - A file over 8 MB goes in 4 MB parts (backend services/uploadChunks.ts):
 *    one request is cut off at the web proxy's body limit, and small requests
 *    survive a weak connection better. The last part's answer is the upload's.
 */

/** The most a file can be once shrunk (the server's cap too). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SINGLE_MAX = 8 * 1024 * 1024;
const PART_BYTES = 4 * 1024 * 1024;

/** Downscale a photo: longest side `max` px, JPEG. Anything else, or a format the browser can't draw, comes back as it was. */
export async function shrinkImage(blob: Blob, max = 1600, quality = 0.85): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(blob.type)) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && blob.type === "image/jpeg" && blob.size < 1.5 * 1024 * 1024) {
      bmp.close();
      return blob;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
    return out && out.size < blob.size ? out : blob;
  } catch {
    // A format this browser can't draw (HEIC outside Safari): keep the original.
    return blob;
  }
}

/** A File field's photo, shrunk, as a File again (renamed .jpg when it became a JPEG). */
export async function shrinkPhotoFile(file: File): Promise<File> {
  const out = await shrinkImage(file, 2048, 0.85);
  if (out === file) return file;
  const name = out.type === "image/jpeg" && !/\.jpe?g$/i.test(file.name) ? `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg` : file.name;
  return new File([out], name, { type: out.type || file.type, lastModified: file.lastModified });
}

const newUploadId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

/**
 * POST a file as the raw body, in parts when it's big. Returns the response to
 * the whole upload: the single request's, or the last part's. A part the
 * server refuses stops it there (that response comes back).
 */
export async function sendFile(url: string, init: { headers: Record<string, string>; credentials: RequestCredentials }, data: Blob, mime: string): Promise<Response> {
  if (data.size <= SINGLE_MAX) return fetch(url, { method: "POST", credentials: init.credentials, headers: init.headers, body: data });
  const uploadId = newUploadId();
  const parts = Math.ceil(data.size / PART_BYTES);
  let res: Response | null = null;
  for (let i = 0; i < parts; i++) {
    const body = data.slice(i * PART_BYTES, Math.min(data.size, (i + 1) * PART_BYTES));
    const headers = {
      ...init.headers,
      "Content-Type": "application/octet-stream",
      "X-File-Type": encodeURIComponent(mime || "application/octet-stream"),
      "X-Upload-Id": uploadId,
      "X-Upload-Part": String(i),
      "X-Upload-Parts": String(parts),
    };
    // A dropped connection gets one more try for that part; the server replaces a part sent twice.
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, { method: "POST", credentials: init.credentials, headers, body });
        if (res.status >= 500 && attempt === 0) continue;
        break;
      } catch (e) {
        if (attempt > 0) throw e;
      }
    }
    if (!res.ok) return res;
  }
  return res!;
}
