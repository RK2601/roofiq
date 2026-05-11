import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { WizardWorkflowReportPayload } from './db';
import type { CombinedRoofAnalysis, StructuralDetection } from './roofVision';

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

export function downloadWizardReportPdf(report: WizardWorkflowReportPayload) {
  const payload = buildExportPayloadFromWizardReport(report);
  if (!payload) return;
  const { final } = payload;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 44;

  doc.setFontSize(18);
  doc.text('Roof Intelligence Final Report', 40, y);
  y += 20;
  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(report.address, 40, y);
  y += 14;
  doc.text(`Generated: ${new Date(payload.generatedAtIso).toLocaleString()}`, 40, y);
  y += 24;

  doc.setTextColor(20);
  doc.setFontSize(12);
  doc.text(`Condition: ${final.condition} (${final.condition_score}/100)`, 40, y);
  y += 14;
  doc.text(`Urgency: ${final.urgency}`, 40, y);
  y += 20;

  autoTable(doc, {
    startY: y,
    head: [['Metric', 'Value']],
    body: [
      ['Roof Type', String(payload.structural.roofType)],
      ['Predominant Pitch', String(payload.structural.predominantPitch)],
      ['Segments', String(payload.structural.segmentCount)],
      ['Total Area (sq ft)', String(Math.round(payload.structural.totalAreaSqFt))],
      ['Photo Slots Analyzed', String(payload.photos.filter(p => p.status === 'done').length)],
    ],
    styles: { fontSize: 9 },
    theme: 'grid',
  });

  const afterMetrics = (doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 120;
  autoTable(doc, {
    startY: afterMetrics + 16,
    head: [['Section', 'Summary']],
    body: [
      ['Structural Summary', final.structuralSummary],
      ['Photo Summary', final.photoSummary],
      ['Recommendation', final.recommendation],
    ],
    styles: { fontSize: 9, cellPadding: 5 },
    theme: 'striped',
    columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: pageWidth - 210 } },
  });

  const afterSummary = (doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? afterMetrics + 140;
  const issues = final.issues.length > 0 ? final.issues : ['No major issues flagged by combined analysis.'];
  autoTable(doc, {
    startY: afterSummary + 16,
    head: [['Identified Issues']],
    body: issues.map(issue => [issue]),
    styles: { fontSize: 9 },
    theme: 'grid',
  });

  doc.save(`roof-report-${Date.now()}.pdf`);
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
  const afterItems = (doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 100;
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
