/**
 * Render a written ReportDoc to a sleek PDF that matches the Cards app
 * theme. Saffron heading gradient, persian-toned body text, JetBrains
 * Mono for card-front excerpts. Generous whitespace, readable line
 * height, page numbers + report-meta footer.
 *
 * Uses @react-pdf/renderer (browser-side). No server rendering.
 */

import { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer';
import type { ReportDoc } from './write';

// Same Google fonts the app uses. @react-pdf needs a URL to fetch from;
// gstatic ships the files with permissive CORS so they work in a tab.
Font.register({
  family: 'Inter',
  fonts: [
    { src: 'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.ttf', fontWeight: 300 },
    { src: 'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.ttf', fontWeight: 400 },
    { src: 'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.ttf', fontWeight: 600 },
  ],
});

// Theme constants — pulled from the app's saffron/persian/crimson scheme,
// lightened so they read well on white paper.
const COLOR = {
  pageBg: '#FBFAF7',
  headingFrom: '#A88858',  // saffron-deep
  headingTo:   '#3D6B5F',  // persian-deep
  body:        '#1F1B26',
  bodyMuted:   '#5C5664',
  ruler:       '#E2DCD0',
  trouble:     '#9D3E4A',
  cardFront:   '#3A2F1F',
  cardBack:    '#4A4452',
  bg:          '#F4EFE6',
};

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 56,
    paddingVertical: 48,
    backgroundColor: COLOR.pageBg,
    fontFamily: 'Inter',
    fontSize: 10.5,
    lineHeight: 1.55,
    color: COLOR.body,
  },
  titleBlock: {
    marginBottom: 28,
    borderBottomWidth: 1,
    borderBottomColor: COLOR.ruler,
    paddingBottom: 14,
  },
  title: {
    fontSize: 26,
    fontWeight: 300,
    color: COLOR.headingFrom,
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    fontWeight: 300,
    color: COLOR.bodyMuted,
  },
  metaRow: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 8,
  },
  metaPill: {
    fontSize: 8.5,
    fontWeight: 400,
    color: COLOR.bodyMuted,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  metaNum: {
    fontWeight: 600,
    color: COLOR.headingTo,
  },
  metaNumTrouble: {
    fontWeight: 600,
    color: COLOR.trouble,
  },

  sectionHeading: {
    fontSize: 18,
    fontWeight: 300,
    color: COLOR.headingFrom,
    marginTop: 22,
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  sectionIntro: {
    fontSize: 10.5,
    color: COLOR.bodyMuted,
    marginBottom: 14,
    fontStyle: 'italic',
  },

  clusterHeading: {
    fontSize: 13,
    fontWeight: 600,
    color: COLOR.headingTo,
    marginTop: 14,
    marginBottom: 4,
    letterSpacing: -0.1,
  },
  narrative: {
    fontSize: 10.5,
    color: COLOR.body,
    marginBottom: 8,
  },
  cardList: {
    marginLeft: 6,
    marginTop: 2,
    marginBottom: 6,
  },
  cardItem: {
    marginBottom: 5,
    paddingLeft: 9,
    borderLeftWidth: 1.5,
    borderLeftColor: COLOR.bg,
  },
  cardFront: {
    fontSize: 9.5,
    color: COLOR.cardFront,
  },
  cardBack: {
    fontSize: 9.5,
    color: COLOR.cardBack,
    marginTop: 1,
  },

  connections: {
    marginTop: 28,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLOR.ruler,
  },
  connectionsHeading: {
    fontSize: 14,
    fontWeight: 300,
    color: COLOR.headingTo,
    marginBottom: 8,
    letterSpacing: -0.2,
  },
  connectionsBody: {
    fontSize: 10.5,
    color: COLOR.body,
  },

  footer: {
    position: 'absolute',
    left: 56,
    right: 56,
    bottom: 28,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: COLOR.bodyMuted,
    fontWeight: 400,
  },
});

interface PdfProps {
  doc: ReportDoc;
}

export function ReportPdf({ doc }: PdfProps) {
  return (
    <Document
      title={`${doc.title} — ${doc.subtitle}`}
      author="Cards"
      subject="Study report"
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{doc.title}</Text>
          <Text style={styles.subtitle}>{doc.subtitle}</Text>
          <View style={styles.metaRow}>
            {doc.meta.learnedCount > 0 && (
              <Text style={styles.metaPill}>
                Learned <Text style={styles.metaNum}>{doc.meta.learnedCount}</Text>
              </Text>
            )}
            {doc.meta.reviewedCount > 0 && (
              <Text style={styles.metaPill}>
                Reviewed <Text style={styles.metaNum}>{doc.meta.reviewedCount}</Text>
              </Text>
            )}
            {doc.meta.troubleCount > 0 && (
              <Text style={styles.metaPill}>
                Trouble <Text style={styles.metaNumTrouble}>{doc.meta.troubleCount}</Text>
              </Text>
            )}
            {doc.meta.overviewCount > 0 && (
              <Text style={styles.metaPill}>
                Cards <Text style={styles.metaNum}>{doc.meta.overviewCount}</Text>
              </Text>
            )}
          </View>
        </View>

        {doc.sections.map((section, sIdx) => (
          <View key={sIdx} wrap>
            <Text style={styles.sectionHeading}>{section.heading}</Text>
            {section.intro && <Text style={styles.sectionIntro}>{section.intro}</Text>}
            {section.clusters.map((cluster, cIdx) => (
              <View key={cIdx} wrap={false}>
                <Text style={styles.clusterHeading}>{cluster.heading}</Text>
                <Text style={styles.narrative}>{cluster.narrative}</Text>
                <View style={styles.cardList}>
                  {cluster.cards.slice(0, 12).map((card) => (
                    <View key={card.cardId} style={styles.cardItem}>
                      <Text style={styles.cardFront}>{truncate(card.front, 200)}</Text>
                      {card.back && (
                        <Text style={styles.cardBack}>→ {truncate(card.back, 240)}</Text>
                      )}
                    </View>
                  ))}
                  {cluster.cards.length > 12 && (
                    <Text style={styles.cardBack}>+ {cluster.cards.length - 12} more in this cluster</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        ))}

        {doc.connections && (
          <View style={styles.connections} wrap>
            <Text style={styles.connectionsHeading}>Connections</Text>
            <Text style={styles.connectionsBody}>{doc.connections}</Text>
          </View>
        )}

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) => `Generated ${new Date(doc.generatedAt).toLocaleString()}    ·    page ${pageNumber} of ${totalPages}`}
          fixed
        />
      </Page>
    </Document>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
