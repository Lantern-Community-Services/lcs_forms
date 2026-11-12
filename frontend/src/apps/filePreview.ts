/**
 * Previews of uploaded files for code forms (files.preview in the SDK). The form's frame may only show
 * images (its CSP is default-src 'none', img-src data: blob:), so the app renders here and hands back an
 * image: a photo as it is, a PDF page drawn with PDF.js. PDF.js loads the first time a PDF is previewed,
 * so pages that never show one don't pay for it.
 */

export interface FilePreview {
  /** An image data: URL to put in <img src>. */
  url: string;
  /** The page shown (1-based) and how many there are (1 for a photo). */
  page: number;
  pages: number;
  /** "image" or "pdf". */
  kind: "image" | "pdf";
}

const IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;
const cache = new Map<string, Promise<FilePreview>>();
let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

function loadPdfjs() {
  pdfjs ??= (async () => {
    const lib = await import("pdfjs-dist");
    // The bundler emits the worker as its own file from this URL (Next/Turbopack's module-worker pattern).
    lib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    return lib;
  })();
  pdfjs.catch(() => (pdfjs = null));
  return pdfjs;
}

async function renderPdf(blob: Blob, page: number, width: number): Promise<FilePreview> {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const n = Math.min(Math.max(1, Math.floor(page) || 1), doc.numPages);
    const pg = await doc.getPage(n);
    const base = pg.getViewport({ scale: 1 });
    // Sharp enough to read small print on a receipt, without huge images for big pages.
    const viewport = pg.getViewport({ scale: Math.min(3, Math.max(0.5, width / base.width)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await pg.render({ canvas, viewport, background: "#ffffff" }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.86);
    canvas.width = canvas.height = 0;
    return { url, page: n, pages: doc.numPages, kind: "pdf" };
  } finally {
    void task.destroy();
  }
}

/** A preview of one file (cached per file, page and width for this page load). */
export function previewFile(key: string, load: () => Promise<Blob>, opts: { page?: number; width?: number } = {}): Promise<FilePreview> {
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const width = Math.min(2000, Math.max(200, Math.floor(Number(opts.width) || 1100)));
  const id = `${key}|${page}|${width}`;
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      const blob = await load();
      const type = (blob.type || "").toLowerCase();
      if (IMAGE.test(type)) return { url: await dataUrl(blob), page: 1, pages: 1, kind: "image" as const };
      if (type === "application/pdf") return renderPdf(blob, page, width);
      if (/^image\/hei[cf]$/.test(type)) throw new Error("iPhone HEIC photos can't be shown here. Take the photo in the app, or save it as JPEG.");
      throw new Error("There's no preview for this kind of file. Download it to open it.");
    })();
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
