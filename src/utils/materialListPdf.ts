import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

type DocWithTable = jsPDF & { lastAutoTable?: { finalY?: number } };

export interface MaterialPdfMeasurements {
  totalSqFt: number;
  cappingFt: number;
  valleyFt: number;
  perimeterFt: number;
}

export interface MaterialPdfBrand {
  name: string;
  unit: string;
  coverage: number;
  overrides: Partial<Record<number, number>>;
}

export interface MaterialPdfSection {
  key: string;
  title: string;
  isArea: boolean;
  baseQtyKey: string;
  brands: MaterialPdfBrand[];
}

export interface MaterialPdfOtherRow {
  label: string;
  unit: string;
  sheetLen: number;
  baseQtyKey: string;
  overrides: Partial<Record<number, number>>;
}

function getBaseQty(key: string, meas: MaterialPdfMeasurements): number {
  if (key === 'totalSqFt') return meas.totalSqFt;
  if (key === 'cappingFt') return meas.cappingFt;
  if (key === 'valleyFt') return meas.valleyFt;
  if (key === 'perimeterFt') return meas.perimeterFt;
  if (key === 'perimeterPlusValley') return meas.perimeterFt + meas.valleyFt;
  return 0;
}

const tableStyles = {
  styles: { fontSize: 9, cellPadding: 4, textColor: [15, 23, 42] as [number, number, number], lineColor: [226, 232, 240] as [number, number, number], lineWidth: 0.25 },
  headStyles: { fillColor: [241, 245, 249] as [number, number, number], textColor: [51, 65, 85] as [number, number, number], fontStyle: 'bold' as const, fontSize: 9 },
  theme: 'grid' as const,
};

/** Column widths: product ~35% of row pool (118–185pt); qty cols ≥46pt; sums to inner width. */
function buildMaterialTableColumnStyles(innerW: number, wastePcts: readonly number[]) {
  const unitW = 40;
  const covW = 102;
  const gutter = 6;
  const n = Math.max(1, wastePcts.length);
  const pool = innerW - unitW - covW - gutter;

  const minWaste = 46;
  const minProduct = 118;
  const maxProduct = 185;

  let targetProduct = Math.min(maxProduct, Math.max(minProduct, Math.round(pool * 0.35)));
  let wasteW = Math.floor((pool - targetProduct) / n);
  if (wasteW < minWaste) wasteW = minWaste;
  let productW = pool - wasteW * n;
  if (productW < minProduct) {
    productW = minProduct;
    wasteW = Math.max(minWaste, Math.floor((pool - productW) / n));
    productW = pool - wasteW * n;
  }

  return {
    0: { cellWidth: productW, overflow: 'linebreak' as const },
    1: { cellWidth: unitW, halign: 'left' as const },
    2: { cellWidth: covW, halign: 'left' as const },
    ...Object.fromEntries(
      wastePcts.map((_, i) => [String(3 + i), { cellWidth: wasteW, halign: 'right' as const }])
    ),
  };
}

/**
 * Vector PDF for the material estimate (jsPDF + autoTable).
 * Uses the same math as the on-screen list — no DOM / html2canvas raster.
 */
export function downloadMaterialListPdf(opts: {
  address?: string | null;
  measurements: MaterialPdfMeasurements;
  hasData: boolean;
  wastePcts: readonly number[];
  sections: MaterialPdfSection[];
  others: MaterialPdfOtherRow[];
  fileName: string;
}): void {
  const { measurements: meas, hasData, wastePcts, sections, others } = opts;
  const margin = 40;
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const innerW = pageW - margin * 2;
  const columnStyles = buildMaterialTableColumnStyles(innerW, wastePcts);

  let y = 48;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(29, 78, 216);
  doc.text('Material estimate', margin, y);
  y += 26;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  if (opts.address?.trim()) {
    doc.text(opts.address.trim(), margin, y, { maxWidth: pageW - margin * 2 });
    y += 16;
  }

  const mLine =
    `Total roof area: ${meas.totalSqFt.toLocaleString()} sq ft  ·  Hips + ridges: ${meas.cappingFt} ft  ·  Valleys: ${meas.valleyFt} ft  ·  Eaves + rakes: ${meas.perimeterFt} ft`;
  doc.text(mLine, margin, y, { maxWidth: pageW - margin * 2 });
  y += 18;

  if (!hasData) {
    doc.setTextColor(146, 64, 14);
    doc.setFontSize(9);
    doc.text(
      'Wizard measurements not loaded — base quantities are zero; rows still show template / manual quantities.',
      margin,
      y,
      { maxWidth: pageW - margin * 2 }
    );
    y += 22;
    doc.setTextColor(71, 85, 105);
    doc.setFontSize(10);
  }

  const head: string[] = ['Product', 'Unit', 'Coverage / unit', ...wastePcts.map(w => `Qty @ ${w}%`)];

  for (const section of sections) {
    const baseQty = getBaseQty(section.baseQtyKey, meas);
    if (hasData && baseQty <= 0 && section.key !== 'shingle') continue;

    const unitSuffix = section.isArea ? 'sqft' : 'ft';
    const wasteTotals = wastePcts.map(w =>
      section.isArea
        ? `${Math.round(baseQty * (1 + w / 100)).toLocaleString()} ${unitSuffix}`
        : `${Math.round(baseQty * (1 + w / 100))} ${unitSuffix}`
    );

    const sectionBanner: (string | { content: string; colSpan?: number; styles?: Record<string, unknown> })[] = [
      { content: section.title, colSpan: 3, styles: { fillColor: [224, 231, 255], fontStyle: 'bold', textColor: [30, 58, 138] } },
      ...wasteTotals.map(t => ({ content: t, styles: { fillColor: [224, 231, 255], fontStyle: 'bold', halign: 'right' as const } })),
    ];

    const body: (string | { content: string; colSpan?: number; styles?: Record<string, unknown> })[][] = [
      sectionBanner as unknown as { content: string; colSpan?: number; styles?: Record<string, unknown> }[],
    ];

    for (const brand of section.brands) {
      const covLabel = `${brand.coverage} ${unitSuffix} / ${brand.unit}`;
      const qtyCells = wastePcts.map(w => {
        const computed = Math.ceil((baseQty * (1 + w / 100)) / Math.max(0.0001, brand.coverage));
        const v = brand.overrides[w] !== undefined && brand.overrides[w] !== null ? brand.overrides[w]! : computed;
        return String(v);
      });
      body.push([brand.name, brand.unit, covLabel, ...qtyCells]);
    }

    autoTable(doc, {
      startY: y,
      head: [head],
      body: body as string[][],
      tableWidth: innerW,
      ...tableStyles,
      margin: { left: margin, right: margin },
      columnStyles,
    });
    y = (doc as DocWithTable).lastAutoTable?.finalY ?? y;
    y += 16;
  }

  // —— Other ——
  const otherBanner: (string | { content: string; colSpan?: number; styles?: Record<string, unknown> })[] = [
    { content: 'Other', colSpan: 3, styles: { fillColor: [224, 231, 255], fontStyle: 'bold', textColor: [30, 58, 138] } },
    ...Array.from({ length: wastePcts.length }, () => ''),
  ];

  const otherHead = ['Item', 'Unit', 'Ft / sheet', ...wastePcts.map(w => `Qty @ ${w}%`)];
  const otherBody: (string | { content: string; colSpan?: number; styles?: Record<string, unknown> })[][] = [
    otherBanner as unknown as { content: string; colSpan?: number; styles?: Record<string, unknown> }[],
  ];

  for (const row of others) {
    const baseQty = getBaseQty(row.baseQtyKey, meas);
    const qtyCells = wastePcts.map(w => {
      const computed = Math.ceil((baseQty * (1 + w / 100)) / Math.max(0.0001, row.sheetLen));
      const v = row.overrides[w] !== undefined && row.overrides[w] !== null ? row.overrides[w]! : computed;
      return String(v);
    });
    otherBody.push([row.label, row.unit, String(row.sheetLen), ...qtyCells]);
  }

  autoTable(doc, {
    startY: y,
    head: [otherHead],
    body: otherBody as string[][],
    tableWidth: innerW,
    ...tableStyles,
    margin: { left: margin, right: margin },
    columnStyles,
  });
  y = (doc as DocWithTable).lastAutoTable?.finalY ?? y;
  y += 20;

  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(
    'Approximations only — verify all order quantities in the field. RoofIQ material list template.',
    margin,
    Math.min(y, doc.internal.pageSize.getHeight() - 36),
    { maxWidth: pageW - margin * 2 }
  );

  const name = opts.fileName.trim();
  doc.save(name.endsWith('.pdf') ? name : `${name}.pdf`);
}
