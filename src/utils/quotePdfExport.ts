import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  for (const img of imgs) {
    if (img.loading === 'lazy') img.loading = 'eager';
    if (!img.complete && typeof img.decode === 'function') {
      try {
        await Promise.race([img.decode(), delay(8000)]);
      } catch {
        /* broken decode — still wait for load/error below */
      }
    }
  }
  await Promise.all(
    imgs.map(img =>
      Promise.race([
        new Promise<void>(resolve => {
          if (img.complete) {
            resolve();
            return;
          }
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }),
        delay(12_000),
      ])
    )
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    id = setTimeout(() => rej(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (id !== undefined) clearTimeout(id);
  }
}

/** Raster capture → A4 PDF (multi-page when content is taller than one page). */
export async function downloadQuoteDocumentPdf(
  element: HTMLElement,
  options?: { fileName?: string }
): Promise<void> {
  await waitForImages(element);
  await delay(50);

  const w0 = Math.max(1, element.scrollWidth);
  const scale = Math.min(3, 8192 / w0);

  const captureMs = 60_000;
  const canvas = await withTimeout(
    html2canvas(element, {
      scale,
      useCORS: true,
      allowTaint: false,
      logging: false,
      backgroundColor: '#ffffff',
      scrollX: 0,
      scrollY: 0,
      onclone: (_clonedDoc, clonedRoot) => {
        const root = clonedRoot as HTMLElement;
        // html2canvas reads the HTML *attribute* (defaultValue), not the live JS *property*.
        // React-controlled inputs update the property but not the attribute, so all typed
        // values appear blank. Sync property → attribute before capture.
        root.querySelectorAll('input, textarea, select').forEach(node => {
          if (node instanceof HTMLInputElement) {
            const t = node.type;
            if (t === 'checkbox' || t === 'radio' || t === 'hidden' || t === 'file' || t === 'button' || t === 'color') return;
            // Sync the live value into the HTML attribute so html2canvas can read it
            node.setAttribute('value', node.value);
            node.style.setProperty('color', '#0f172a', 'important');
            node.style.setProperty('background-color', '#ffffff', 'important');
            node.style.setProperty('-webkit-text-fill-color', '#0f172a', 'important');
            node.style.setProperty('opacity', '1', 'important');
            node.style.setProperty('caret-color', 'transparent', 'important');
            node.style.setProperty('border', '1px solid #cbd5e1', 'important');
          } else if (node instanceof HTMLTextAreaElement) {
            node.textContent = node.value;
            node.style.setProperty('color', '#0f172a', 'important');
            node.style.setProperty('background-color', '#ffffff', 'important');
            node.style.setProperty('-webkit-text-fill-color', '#0f172a', 'important');
            node.style.setProperty('opacity', '1', 'important');
          } else if (node instanceof HTMLSelectElement) {
            // Mark the correct <option> as selected so html2canvas shows the right text
            Array.from(node.options).forEach(opt => {
              opt.selected = opt.value === node.value;
              if (opt.selected) opt.setAttribute('selected', '');
              else opt.removeAttribute('selected');
            });
          }
        });
      },
    }),
    captureMs,
    'Capturing the quote timed out. Try again in a moment.'
  );

  if (!canvas.width || !canvas.height) {
    throw new Error('Could not capture the quote (empty canvas).');
  }

  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const contentW = pageWidth - margin * 2;
  const contentH = pageHeight - margin * 2;

  const imgScaledH = (canvas.height * contentW) / canvas.width;
  const pdfPerCanvasPx = imgScaledH / canvas.height;
  const pageCanvasH = contentH / pdfPerCanvasPx;

  let yCanvas = 0;
  let pageIdx = 0;

  while (yCanvas < canvas.height - 0.5) {
    const yEnd = Math.min(yCanvas + pageCanvasH, canvas.height);
    const sliceCanvasH = yEnd - yCanvas;
    if (!(sliceCanvasH > 0)) break;

    const slicePdfH = sliceCanvasH * pdfPerCanvasPx;
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = Math.max(1, Math.ceil(sliceCanvasH));
    const ctx = slice.getContext('2d');
    if (!ctx) break;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, yCanvas, canvas.width, sliceCanvasH, 0, 0, slice.width, slice.height);

    let data: string;
    try {
      data = slice.toDataURL('image/jpeg', 0.97);
    } catch (err) {
      const hint =
        err instanceof DOMException && err.name === 'SecurityError'
          ? ' A cross-origin image blocked export.'
          : '';
      throw new Error(`Could not build PDF image data.${hint}`);
    }

    if (pageIdx > 0) pdf.addPage();
    pdf.addImage(data, 'JPEG', margin, margin, contentW, slicePdfH);

    yCanvas = yEnd;
    pageIdx++;
  }

  const name =
    options?.fileName?.trim() ||
    `RoofIQ-quote-${Date.now()}.pdf`;
  pdf.save(name.endsWith('.pdf') ? name : `${name}.pdf`);
}
