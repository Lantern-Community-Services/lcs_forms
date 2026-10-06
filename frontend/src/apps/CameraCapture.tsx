import { useEffect, useRef, useState } from "react";
import { Camera, ImageUp, RefreshCw, SwitchCamera } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * The camera, for a code form's device.takePhoto(). It runs here in the app
 * rather than in the form's sandboxed frame, so the browser asks for camera
 * access once for the whole site. A live preview with a shutter; "Choose a
 * photo" opens the device's own picker (on a phone or iPad that offers the
 * camera too), and it's all there is when the browser has no camera access.
 */

export interface CameraRequest {
  title?: string;
  facing?: "environment" | "user";
}

/** Downscale a photo so a dozen of them don't fill the database: longest side `max` px, JPEG. */
export async function shrinkImage(blob: Blob, max = 1600, quality = 0.85): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(blob.type)) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && blob.type === "image/jpeg" && blob.size < 1.5 * 1024 * 1024) return blob;
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

export function CameraCapture({ request, onDone }: { request: CameraRequest | null; onDone: (photo: File | null) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const open = request !== null;

  useEffect(() => {
    if (request) {
      setFacing(request.facing ?? "environment");
      setShot(null);
      setFailed(null);
    }
  }, [request]);

  // The live camera, while the dialog is open and no photo is waiting to be confirmed.
  useEffect(() => {
    if (!open || shot) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setFailed("This browser can't show the camera here.");
      return;
    }
    let live = true;
    let s: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
      .then((st) => {
        if (!live) return st.getTracks().forEach((t) => t.stop());
        s = st;
        setStream(st);
        setFailed(null);
      })
      .catch((e: Error) => live && setFailed(e.name === "NotAllowedError" ? "Camera access is turned off for this site." : "No camera was found."));
    return () => {
      live = false;
      s?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [open, shot, facing]);

  // The dialog's content mounts in a portal, so attach the stream once both exist.
  useEffect(() => {
    const v = video.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
  }, [stream, shot]);

  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);

  function snap() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    canvas.toBlob((b) => {
      if (!b) return;
      const file = new File([b], `photo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`, { type: "image/jpeg" });
      setShot({ file, url: URL.createObjectURL(b) });
    }, "image/jpeg", 0.9);
  }

  function picked(files: FileList | null) {
    const f = files?.[0];
    if (picker.current) picker.current.value = "";
    if (f) onDone(f);
  }

  return (
    <>
      <input ref={picker} type="file" accept="image/*" capture={facing} className="hidden" onChange={(e) => picked(e.target.files)} />
      <Dialog open={open} onOpenChange={(o) => !o && onDone(null)}>
        <DialogContent aria-describedby={undefined} className="w-[min(720px,calc(100vw-1rem))]">
          <DialogHeader title={request?.title || "Take a photo"} />
          <DialogBody>
            <div className="relative overflow-hidden rounded-input bg-black" style={{ aspectRatio: "4 / 3" }}>
              {shot ? (
                <img src={shot.url} alt="The photo you took" className="h-full w-full object-contain" />
              ) : failed ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[14px] text-white/80">
                  <Camera className="h-8 w-8" />
                  <p>{failed}</p>
                  <p className="text-[12.5px] text-white/60">You can still choose a photo, or take one with the device's camera app.</p>
                </div>
              ) : (
                <video ref={video} playsInline muted autoPlay className="h-full w-full object-contain" />
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => picker.current?.click()}>
                <ImageUp className="h-4 w-4" /> Choose a photo
              </Button>
              {shot ? (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setShot(null)}>
                    <RefreshCw className="h-4 w-4" /> Retake
                  </Button>
                  <Button onClick={() => onDone(shot.file)}>Use photo</Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  {stream && (
                    <Button variant="secondary" size="icon" aria-label="Switch camera" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>
                      <SwitchCamera className="h-4 w-4" />
                    </Button>
                  )}
                  <Button onClick={snap} disabled={!stream}>
                    <Camera className="h-4 w-4" /> Take photo
                  </Button>
                </div>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
