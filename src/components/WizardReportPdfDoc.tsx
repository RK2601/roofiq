import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';
import type { WizardWorkflowReportPayload } from '../utils/db';
import type { QuoteBranding } from '../utils/quoteBranding';

interface Props {
  report: WizardWorkflowReportPayload;
  branding: QuoteBranding;
}

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    padding: 30,
    color: '#0f172a',
  },
  // Header
  header: {
    marginBottom: 14,
  },
  companyName: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
    marginBottom: 2,
  },
  tagline: {
    fontSize: 10,
    color: '#64748b',
    marginBottom: 8,
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    marginBottom: 10,
  },
  // Address section
  addressText: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
    marginBottom: 3,
  },
  dateText: {
    fontSize: 9,
    color: '#64748b',
    marginBottom: 14,
  },
  // Sections
  section: {
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  sectionContent: {
    fontSize: 9,
    color: '#334155',
    lineHeight: 1.5,
  },
  // 2-column grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridCell: {
    width: '50%',
    marginBottom: 6,
    paddingRight: 8,
  },
  gridLabel: {
    fontSize: 8,
    color: '#64748b',
    marginBottom: 1,
  },
  gridValue: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
  },
  // Image
  roofImage: {
    width: '100%',
    maxHeight: 200,
    objectFit: 'contain',
    marginBottom: 12,
    borderRadius: 4,
  },
  // Issues list
  issueRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  issueBullet: {
    fontSize: 9,
    color: '#ef4444',
    marginRight: 5,
    marginTop: 1,
  },
  issueText: {
    fontSize: 9,
    color: '#334155',
    flex: 1,
    lineHeight: 1.4,
  },
  // Property info row
  infoRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  infoLabel: {
    fontSize: 9,
    color: '#64748b',
    width: 110,
  },
  infoValue: {
    fontSize: 9,
    color: '#0f172a',
    flex: 1,
  },
  // Footer
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 30,
    right: 30,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 6,
  },
  footerText: {
    fontSize: 8,
    color: '#94a3b8',
    textAlign: 'center',
  },
});

export default function WizardReportPdfDoc({ report, branding }: Props) {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const solar = report.solarStructure as {
    measurements?: {
      totalRoofAreaSqFt?: number;
      facetCount?: number;
      predominantPitch?: string;
      totalRidgeFt?: number;
      totalHipFt?: number;
      totalValleyFt?: number;
      totalEaveFt?: number;
      totalRakeFt?: number;
    };
  } | null;

  const final = report.finalAnalysis as {
    issues?: string[];
    urgency?: string;
    recommendation?: string;
  } | null;

  const measurements = solar?.measurements;
  const issues = final?.issues ?? [];

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.companyName}>{branding.companyName || 'RoofIQ'}</Text>
          {!!branding.tagline && (
            <Text style={styles.tagline}>{branding.tagline}</Text>
          )}
          <View style={styles.divider} />
          <Text style={styles.addressText}>{report.address}</Text>
          <Text style={styles.dateText}>Report generated: {today}</Text>
        </View>

        {/* ── Property Info ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Property Information</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Address</Text>
            <Text style={styles.infoValue}>{report.address}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Coordinates</Text>
            <Text style={styles.infoValue}>
              {report.coordinates.lat.toFixed(6)}, {report.coordinates.lng.toFixed(6)}
            </Text>
          </View>
          {!!branding.companyName && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Prepared by</Text>
              <Text style={styles.infoValue}>{branding.companyName}</Text>
            </View>
          )}
          {!!branding.phone && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Phone</Text>
              <Text style={styles.infoValue}>{branding.phone}</Text>
            </View>
          )}
          {!!branding.email && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Email</Text>
              <Text style={styles.infoValue}>{branding.email}</Text>
            </View>
          )}
        </View>

        {/* ── Roof Outline Image ── */}
        {!!report.roofOutlineSnapshot && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Roof Outline</Text>
            <Image src={report.roofOutlineSnapshot} style={styles.roofImage} />
          </View>
        )}

        {/* ── Measurements ── */}
        {!!measurements && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Measurements</Text>
            <View style={styles.grid}>
              {measurements.totalRoofAreaSqFt !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Total Roof Area</Text>
                  <Text style={styles.gridValue}>
                    {Math.round(measurements.totalRoofAreaSqFt).toLocaleString()} sq ft
                  </Text>
                </View>
              )}
              {measurements.facetCount !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Facet Count</Text>
                  <Text style={styles.gridValue}>{measurements.facetCount}</Text>
                </View>
              )}
              {measurements.predominantPitch !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Predominant Pitch</Text>
                  <Text style={styles.gridValue}>{measurements.predominantPitch}</Text>
                </View>
              )}
              {measurements.totalRidgeFt !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Total Ridge</Text>
                  <Text style={styles.gridValue}>
                    {Math.round(measurements.totalRidgeFt)} ft
                  </Text>
                </View>
              )}
              {measurements.totalHipFt !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Total Hip</Text>
                  <Text style={styles.gridValue}>
                    {Math.round(measurements.totalHipFt)} ft
                  </Text>
                </View>
              )}
              {measurements.totalValleyFt !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Total Valley</Text>
                  <Text style={styles.gridValue}>
                    {Math.round(measurements.totalValleyFt)} ft
                  </Text>
                </View>
              )}
              {measurements.totalEaveFt !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Total Eave</Text>
                  <Text style={styles.gridValue}>
                    {Math.round(measurements.totalEaveFt)} ft
                  </Text>
                </View>
              )}
              {measurements.totalRakeFt !== undefined && (
                <View style={styles.gridCell}>
                  <Text style={styles.gridLabel}>Total Rake</Text>
                  <Text style={styles.gridValue}>
                    {Math.round(measurements.totalRakeFt)} ft
                  </Text>
                </View>
              )}
            </View>
          </View>
        )}

        {/* ── Issues ── */}
        {issues.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Identified Issues</Text>
            {issues.map((issue, i) => (
              <View key={i} style={styles.issueRow}>
                <Text style={styles.issueBullet}>•</Text>
                <Text style={styles.issueText}>{issue}</Text>
              </View>
            ))}
          </View>
        )}

        {/* ── Footer ── */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Generated by RoofIQ · AI-assisted analysis · Not as-built measurements
          </Text>
        </View>
      </Page>
    </Document>
  );
}
