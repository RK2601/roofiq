import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { WizardWorkflowReportPayload } from './db';
import type { CombinedRoofAnalysis, StructuralDetection } from './roofVision';

type DocWithTable = jsPDF & { lastAutoTable?: { finalY?: number } };

function asStructure(s: unknown): StructuralDetection | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as StructuralDetection;
  if (!Array.isArray(o.cues)) return null;
  return o;
}

function asFinal(s: unknown): CombinedRoofAnalysis | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as CombinedRoofAnalysis;
  if (typeof o.condition !== 'string' || !Array.isArray(o.issues)) return null;
  return o;
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

/**
 * Avoid hanging forever: `complete` + `naturalWidth === 0` never fires load/error;
 * lazy off-screen images may never start loading unless we bump them to eager.
 */
async function waitForImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  const perImgMs = 12_000;

  for (const img of imgs) {
    if (img.loading === 'lazy') img.loading = 'eager';
    if (!img.complete && typeof img.decode === 'function') {
      try {
        await Promise.race([img.decode(), delay(8000)]);
      } catch {
        // decode rejects for broken images; load/error handlers below still apply
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
        delay(perImgMs),
      ])
    )
  );
}

/** True when the on-screen report has enough content to export. */
export function canDownloadWizardPdf(report: WizardWorkflowReportPayload): boolean {
  return (
    !!report.finalAnalysis ||
    report.segments.length > 0 ||
    (report.outline?.points?.length ?? 0) > 0 ||
    !!report.roofOutlineSnapshot ||
    !!report.satelliteSnapshot ||
    !!report.solarStructure ||
    !!report.structure ||
    report.photos.some(p => p.status === 'done')
  );
}

const PDF_KEEP_ON_ONE_PAGE = '[data-pdf-keep-on-one-page]';

/** ~210 mm at 96 CSS px/in — matches A4 print width for a portrait column. */
const A4_CONTENT_CSS_PX = Math.round((210 / 25.4) * 96);

/** html2canvas scale cap — higher = sharper PDF (watch memory on very long reports). */
const PDF_HTML2CANVAS_SCALE_CAP = 4;
/** Width of the capture canvas must stay under typical browser limits (height is fine — we slice). */
const PDF_RASTER_MAX_EDGE_PX = 16384;

/** PDF only: pitch schematic — extra vertical compression (15% shorter than fit-scale alone). */
const PITCH_SCHEMATIC_PDF_VERTICAL_HEIGHT_FACTOR = 0.85;

/** PDF only: Google Solar “Roof Structure Analysis” diagram — 30% smaller than on-screen (×0.7). */
const SOLAR_STRUCTURE_DIAGRAM_PDF_SCALE = 0.7;
/** PDF only: Street View preview image — 7% shorter vertically (scaleY 0.93). */
const STREET_VIEW_IMAGE_PDF_SCALE_Y = 0.93;

function scaleKeepBlockForPdfClone(el: HTMLElement, scale: number, blockHeightPx: number): void {
  if (scale >= 0.998) return;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('zoom', '1')) {
    (el.style as unknown as { zoom: string }).zoom = String(scale);
    return;
  }
  el.style.transformOrigin = 'top left';
  el.style.transform = `scale(${scale})`;
  el.style.marginBottom = `${-(blockHeightPx * (1 - scale))}px`;
}

/**
 * Narrow the clone to A4-ish width, fix SVG overflow clipping, cap SVG heights,
 * and scale marked figures so they fit one page height.
 */
function applyPdfCloneLayout(clonedRoot: HTMLElement, contentWPt: number, contentHPt: number): void {
  const targetW = Math.min(A4_CONTENT_CSS_PX, Math.max(clonedRoot.scrollWidth, 320));
  clonedRoot.style.width = `${targetW}px`;
  clonedRoot.style.maxWidth = `${targetW}px`;
  clonedRoot.style.boxSizing = 'border-box';
  clonedRoot.style.backgroundColor = '#ffffff';
  void clonedRoot.offsetHeight;

  const w = Math.max(1, clonedRoot.scrollWidth);
  // Maximum height (in CSS px of the clone) that a single page can show
  const maxBlockH = (contentHPt * w) / contentWPt;
  // SVGs inside a keep-block get capped at 82% of page height — the rest is card title/padding/legend
  const maxSvgH = Math.round(maxBlockH * 0.82);

  // Pass 1: fix SVG rendering inside each keep-block before we measure heights
  clonedRoot.querySelectorAll<HTMLElement>(PDF_KEEP_ON_ONE_PAGE).forEach(block => {
    const noScale = block.hasAttribute('data-pdf-no-scale');
    // Allow SVG content (labels, polygons) to overflow their viewBox without clipping
    block.querySelectorAll<SVGSVGElement>('svg').forEach(svg => {
      svg.setAttribute('overflow', 'visible');
      svg.style.overflow = 'visible';
      // Pitch schematic: do not cap height — zoom/maxHeight + viewBox breaks html2canvas.
      if (!noScale && !svg.getAttribute('height') && !svg.style.height) {
        svg.style.maxHeight = `${maxSvgH}px`;
        svg.style.width = '100%';
      } else if (noScale) {
        svg.style.width = '100%';
        svg.style.height = 'auto';
        svg.style.maxHeight = 'none';
      }
    });
    // Remove overflow clipping from divs that wrap SVGs (prevents right-edge cut-off)
    block.querySelectorAll<HTMLElement>('div').forEach(el => {
      if (el.querySelector('svg')) {
        el.style.overflow = 'visible';
      }
    });
  });

  void clonedRoot.offsetHeight; // re-flush after SVG changes

  // PDF only: pitch schematic — fit A4 width/page height, then shorten vertically by 15%.
  clonedRoot.querySelectorAll<HTMLElement>('[data-pdf-pitch-schematic-squash]').forEach(wrap => {
    const block = wrap.closest<HTMLElement>('[data-pdf-keep-on-one-page]');
    if (!block) return;

    wrap.style.transform = '';
    wrap.style.marginBottom = '';
    void wrap.offsetHeight;

    const sw = Math.max(1, wrap.scrollWidth, wrap.offsetWidth);
    const sh = Math.max(1, wrap.offsetHeight, wrap.scrollHeight);

    const maxW = Math.max(80, Math.min(w - 24, block.clientWidth - 32));

    const chromeH = Math.max(0, block.offsetHeight - wrap.offsetHeight);
    const schematicSpace = Math.max(48, maxBlockH - chromeH - 20);

    const sFit = Math.min(1, maxW / sw, schematicSpace / sh);
    const sx = sFit;
    const sy = sFit * PITCH_SCHEMATIC_PDF_VERTICAL_HEIGHT_FACTOR;

    wrap.style.transformOrigin = 'top center';
    wrap.style.transform = `scale(${sx}, ${sy})`;
    wrap.style.marginBottom = `${-(sh * (1 - sy))}px`;
  });

  // PDF only: Solar API structure SVG — fixed 30% size reduction (does not affect on-screen report).
  clonedRoot.querySelectorAll<HTMLElement>('[data-pdf-solar-structure-diagram-shrink]').forEach(wrap => {
    wrap.style.transform = '';
    wrap.style.marginBottom = '';
    void wrap.offsetHeight;
    const h0 = Math.max(1, wrap.offsetHeight, wrap.scrollHeight);
    const s = SOLAR_STRUCTURE_DIAGRAM_PDF_SCALE;
    wrap.style.transformOrigin = 'top center';
    wrap.style.transform = `scale(${s})`;
    wrap.style.marginBottom = `${-(h0 * (1 - s))}px`;
  });

  // PDF only: Street View hero image — compress height by 7% (width unchanged).
  clonedRoot.querySelectorAll<HTMLElement>('[data-pdf-streetview-img-squash-y]').forEach(wrap => {
    wrap.style.transform = '';
    wrap.style.marginBottom = '';
    void wrap.offsetHeight;
    const h0 = Math.max(1, wrap.offsetHeight, wrap.scrollHeight);
    const sy = STREET_VIEW_IMAGE_PDF_SCALE_Y;
    wrap.style.transformOrigin = 'top center';
    wrap.style.transform = `scale(1, ${sy})`;
    wrap.style.marginBottom = `${-(h0 * (1 - sy))}px`;
  });

  void clonedRoot.offsetHeight;

  // Pass 2: scale blocks that are still too tall to fit one page
  clonedRoot.querySelectorAll(PDF_KEEP_ON_ONE_PAGE).forEach(node => {
    const el = node as HTMLElement;
    if (el.hasAttribute('data-pdf-no-scale')) return;
    const oh = el.offsetHeight;
    const ow = el.offsetWidth;
    if (oh < 1) return;
    let s = 1;
    if (oh > maxBlockH) s = Math.min(s, maxBlockH / oh);
    // Only shrink for width when the block truly exceeds the clone. Using (w - 8) made almost every
    // full-bleed keep-block slightly zoomed (ow ≈ w), which breaks flex/label centering in html2canvas.
    if (ow > w + 0.5) s = Math.min(s, w / Math.max(ow, 1));
    scaleKeepBlockForPdfClone(el, s, oh);
  });
}

async function flushLayout(): Promise<void> {
  await new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

/**
 * Rasterises the live wizard report DOM into a multi-page A4 PDF.
 *
 * Smart page breaks: block positions of every [data-pdf-keep-on-one-page] element
 * are measured in the cloned DOM after layout is applied. The slicing loop then
 * snaps page cut points to just before any keep-block, so no block ever splits
 * across pages regardless of how tall the content above it is.
 */
export async function downloadWizardReportPdf(
  rootElement: HTMLElement,
  report: WizardWorkflowReportPayload
): Promise<void> {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    compress: false,
  });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 20;
  const contentW = pageWidth - margin * 2;
  const contentH = pageHeight - margin * 2;

  await flushLayout();
  await waitForImages(rootElement);
  await flushLayout();

  const w0 = Math.max(1, rootElement.scrollWidth);
  // Limit scale by width only — height is fine because we slice into pages
  const scale = Math.min(PDF_HTML2CANVAS_SCALE_CAP, PDF_RASTER_MAX_EDGE_PX / w0);

  // Collected during onclone — positions in clone CSS px (before ×scale)
  const keepBlocksClonePx: Array<{ top: number; bottom: number }> = [];
  type LinkItem = { top: number; bottom: number; left: number; right: number; url: string };
  const linkItemsClonePx: LinkItem[] = [];

  const captureMs = 90_000;
  const canvas = await withTimeout(
    html2canvas(rootElement, {
      scale,
      useCORS: true,
      allowTaint: false,
      logging: false,
      backgroundColor: '#ffffff',
      scrollX: 0,
      scrollY: 0,
      onclone: (_clonedDoc, clonedEl) => {
        const el = clonedEl as HTMLElement;
        applyPdfCloneLayout(el, contentW, contentH);
        void el.offsetHeight; // force reflow so getBoundingClientRect is accurate

        // Measure every keep-block's position relative to the cloned root.
        // html2canvas places the clone off-screen at a fixed position, so
        // getBoundingClientRect() is valid and relative subtraction gives layout offset.
        const rootRect = el.getBoundingClientRect();
        el.querySelectorAll<HTMLElement>(PDF_KEEP_ON_ONE_PAGE).forEach(block => {
          const rect = block.getBoundingClientRect();
          keepBlocksClonePx.push({
            top: rect.top - rootRect.top,
            bottom: rect.bottom - rootRect.top,
          });
        });
        // Collect clickable links for PDF annotations
        el.querySelectorAll<HTMLElement>('[data-pdf-href]').forEach(link => {
          const url = link.getAttribute('data-pdf-href') ?? '';
          if (!url) return;
          const rect = link.getBoundingClientRect();
          linkItemsClonePx.push({
            top: rect.top - rootRect.top,
            bottom: rect.bottom - rootRect.top,
            left: rect.left - rootRect.left,
            right: rect.right - rootRect.left,
            url,
          });
        });
      },
    }),
    captureMs,
    'Capturing the report timed out. Scroll through the whole report once so images load, then try again.'
  );

  if (!canvas.width || !canvas.height) {
    throw new Error('Could not capture the report (empty canvas). Try refreshing the page.');
  }

  // Convert clone CSS-px positions → canvas pixel positions
  const keepBlocksCanvas = keepBlocksClonePx.map(b => ({
    top: b.top * scale,
    bottom: b.bottom * scale,
  }));
  const linkItemsCanvas = linkItemsClonePx.map(l => ({
    ...l,
    top: l.top * scale,
    bottom: l.bottom * scale,
    left: l.left * scale,
    right: l.right * scale,
  }));

  const imgScaledW = contentW;
  const imgScaledH = (canvas.height * imgScaledW) / canvas.width;
  const pdfPerCanvasPx = imgScaledH / canvas.height;
  const pageCanvasH = contentH / pdfPerCanvasPx;

  // Track the canvas-Y where each PDF page starts (for link annotation placement)
  const pageStartsCanvas: number[] = [];

  let yCanvas = 0;
  let pageIdx = 0;

  while (yCanvas < canvas.height - 0.5) {
    pageStartsCanvas.push(yCanvas);
    let yEnd = Math.min(yCanvas + pageCanvasH, canvas.height);

    // Smart page break: if the natural cut point falls inside a keep-block,
    // snap it to just before that block's top so the block starts fresh on
    // the next page. This is the core mechanism that prevents splits.
    for (const block of keepBlocksCanvas) {
      const blockAlreadyStarted = block.top <= yCanvas + 2;
      const cutInsideBlock = yEnd > block.top + 4 && yEnd < block.bottom - 4;
      if (!blockAlreadyStarted && cutInsideBlock) {
        // Leave whitespace at the bottom of this page and start fresh
        const candidate = Math.max(yCanvas + 1, block.top);
        if (candidate < yEnd) {
          yEnd = candidate;
        }
        break;
      }
    }

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
      // JPEG at 0.97 quality — jsPDF embeds JPEG natively without re-compression, giving
      // sharper results than PNG which jsPDF internally re-encodes.
      data = slice.toDataURL('image/jpeg', 0.97);
    } catch (err) {
      const hint =
        err instanceof DOMException && err.name === 'SecurityError'
          ? ' A cross-origin image blocked export (try again after photos/maps finish loading).'
          : '';
      throw new Error(`Could not build PDF image data.${hint}`);
    }
    if (pageIdx > 0) pdf.addPage();
    pdf.addImage(data, 'JPEG', margin, margin, contentW, slicePdfH);

    yCanvas = yEnd;
    pageIdx++;
  }

  // Inject clickable link annotations onto the correct PDF pages
  const canvasToPageX = (cx: number) => margin + (cx / canvas.width) * contentW;
  const canvasToPageY = (cy: number, pageStart: number) =>
    margin + (cy - pageStart) * pdfPerCanvasPx;

  for (const link of linkItemsCanvas) {
    // Find which page the top of this link falls on
    let pg = pageStartsCanvas.length - 1;
    for (let i = 0; i < pageStartsCanvas.length; i++) {
      const pageEnd = i + 1 < pageStartsCanvas.length ? pageStartsCanvas[i + 1] : canvas.height;
      if (link.top >= pageStartsCanvas[i] && link.top < pageEnd) {
        pg = i;
        break;
      }
    }
    const pageStart = pageStartsCanvas[pg];
    const x = canvasToPageX(link.left);
    const y = canvasToPageY(link.top, pageStart);
    const w = (link.right - link.left) / canvas.width * contentW;
    const h = (link.bottom - link.top) * pdfPerCanvasPx;
    pdf.setPage(pg + 1);
    pdf.link(x, y, w, h, { url: link.url });
  }

  const slug = report.address
    .slice(0, 40)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '');
  pdf.save(`wizard-report-${slug || 'roof'}-${Date.now()}.pdf`);
}

export function buildExportPayloadFromWizardReport(report: WizardWorkflowReportPayload) {
  const structure = asStructure(report.structure);
  const final = asFinal(report.finalAnalysis);
  if (!final) return null;
  return {
    generatedAtIso: report.updatedAtIso,
    address: report.address,
    coordinates: report.coordinates,
    structural: {
      segmentCount: report.segments.length,
      roofType: structure?.roofType ?? 'unknown',
      predominantPitch: structure?.predominantPitch ?? '4/12',
      totalAreaSqFt: structure?.totalAreaSqFt ?? 0,
      cues: structure?.cues ?? [],
    },
    photos: report.photos.map(p => ({
      slot: p.label,
      status: p.status,
      quality: p.qualityScore ?? null,
      cueCount: p.cueCount ?? 0,
    })),
    final,
  };
}

export async function shareWizardReport(report: WizardWorkflowReportPayload) {
  const payload = buildExportPayloadFromWizardReport(report);
  if (!payload) return;
  const { final } = payload;
  const text = [
    `Roof Report — ${report.address}`,
    `Condition: ${final.condition} (${final.condition_score}/100)`,
    `Urgency: ${final.urgency}`,
    `Recommendation: ${final.recommendation ?? ''}`,
  ].join('\n');

  try {
    if (navigator.share) {
      await navigator.share({ title: 'Roof Analysis Report', text });
      return;
    }
    await navigator.clipboard.writeText(`${text}\n\n${JSON.stringify(payload, null, 2)}`);
  } catch {
    // share can be blocked
  }
}

export function downloadWizardQuoteDraftPdf(report: WizardWorkflowReportPayload) {
  const structure = asStructure(report.structure);
  const final = asFinal(report.finalAnalysis);
  if (!final) return;

  const structureArea = Math.max(1, Math.round(structure?.totalAreaSqFt ?? 0));
  const squares = Math.max(1, Math.round(structureArea / 100));
  const baseRate =
    final.condition === 'Excellent'
      ? 380
      : final.condition === 'Good'
        ? 430
        : final.condition === 'Fair'
          ? 520
          : final.condition === 'Poor'
            ? 610
            : 690;
  const subtotal = squares * baseRate;
  const tax = Math.round(subtotal * 0.13);
  const total = subtotal + tax;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 44;
  doc.setFontSize(18);
  doc.text('Roof Quote Draft', 40, y);
  y += 20;
  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(report.address, 40, y);
  y += 16;
  doc.text(`Condition: ${final.condition} (${final.condition_score}/100)`, 40, y);
  y += 12;
  doc.text(`Urgency: ${final.urgency}`, 40, y);
  y += 18;

  autoTable(doc, {
    startY: y,
    head: [['Line Item', 'Qty', 'Unit', 'Amount']],
    body: [
      ['Roof System', `${squares} sq`, `$${baseRate}`, `$${subtotal}`],
      ['Assessment/QA', '1', '$350', '$350'],
      ['Disposal & Cleanup', '1', '$420', '$420'],
    ],
    styles: { fontSize: 10 },
    theme: 'grid',
  });
  const afterItems = (doc as DocWithTable).lastAutoTable?.finalY ?? y + 100;
  doc.setTextColor(20);
  doc.setFontSize(11);
  doc.text(`Subtotal: $${(subtotal + 770).toLocaleString()}`, 40, afterItems + 20);
  doc.text(`Estimated Tax: $${tax.toLocaleString()}`, 40, afterItems + 36);
  doc.setFontSize(13);
  doc.text(`Estimated Total: $${(total + 770).toLocaleString()}`, 40, afterItems + 56);
  doc.setFontSize(10);
  doc.setTextColor(70);
  doc.text(`Recommended Scope: ${final.recommendation}`, 40, afterItems + 82, { maxWidth: 500 });
  doc.save(`quote-draft-${Date.now()}.pdf`);
}
