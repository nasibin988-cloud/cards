/**
 * PDF text extractor using pdfjs-dist. Lazy-imported so the ~1.3 MB worker
 * never lands in a bundle that doesn't need it.
 *
 * Returns the concatenated text content of every page, separated by blank
 * lines. Per-page errors are swallowed — better to return what we can than
 * fail the whole import on one bad page.
 *
 * The worker is served as a static asset from /pdf.worker.min.mjs (copied
 * into public/ at build time) so we don't depend on bundler-specific URL
 * resolution.
 */
import { withBasePath } from '@/lib/basePath';

export async function extractPdfText(file: File | Blob): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  // Worker URL respects the deploy basePath so it resolves under /cards in prod.
  pdfjs.GlobalWorkerOptions.workerSrc = withBasePath('/pdf.worker.min.mjs');

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items = content.items as Array<{ str: string }>;
      pages.push(items.map(it => it.str).join(' '));
    } catch { /* skip a bad page */ }
  }
  await doc.destroy();
  return pages.join('\n\n');
}
