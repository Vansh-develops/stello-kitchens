import QRCode from "qrcode";
import { printDocToHtml, type PrintDoc } from "@stello/shared";

// Browser print path: render the shared PrintDoc to 58/80mm HTML and print it
// from a hidden iframe. Works on any device with a system printer and no
// install. Without Chrome's --kiosk-printing flag the browser shows its print
// dialog; the drawer kick is an ESC/POS pulse, so it needs the agent.

let queue: Promise<void> = Promise.resolve();

/** Print a document from a hidden iframe. Calls are serialised (one dialog at a time). */
export function printViaBrowser(doc: PrintDoc, options: { title?: string; copies?: number } = {}): Promise<void> {
  const run = queue.then(() => printNow(doc, options));
  queue = run.catch(() => undefined);
  return run;
}

async function printNow(doc: PrintDoc, { title, copies = 1 }: { title?: string; copies?: number }) {
  if (typeof document === "undefined") return;
  const repeated: PrintDoc = { ...doc, ops: Array.from({ length: Math.max(1, copies) }, () => doc.ops).flat() };
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  try {
    const win = frame.contentWindow!;
    const d = win.document;
    d.open();
    d.write(printDocToHtml(repeated, { title }));
    d.close();
    // Fill QR placeholders (UPI scan-to-pay, test page) with real images.
    await Promise.all(
      Array.from(d.querySelectorAll<HTMLImageElement>("img[data-qr]")).map(async (img) => {
        img.src = await QRCode.toDataURL(img.dataset.qr ?? "", { margin: 0, width: 240 });
        await img.decode().catch(() => undefined);
      }),
    );
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      win.addEventListener("afterprint", finish);
      win.focus();
      win.print();
      // Some browsers don't fire afterprint for iframes; print() blocks until the
      // dialog closes in most, so a short grace timer is enough.
      setTimeout(finish, 1500);
    });
  } finally {
    setTimeout(() => frame.remove(), 1000);
  }
}
