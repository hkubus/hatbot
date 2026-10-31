import { extractText, getDocumentProxy } from "unpdf";

/** Past this, a PDF's quotes stay unchecked rather than hold up the helpers. */
const MAX_PDF_BYTES = 32 * 1024 * 1024;

/** A fetched PDF's text, to find helpers' quotes in; null when it can't be read. */
export async function pdfText(base64: string): Promise<string | null> {
  if (base64.length > (MAX_PDF_BYTES * 4) / 3) return null;
  try {
    const doc = await getDocumentProxy(Uint8Array.from(Buffer.from(base64, "base64")), {
      verbosity: 0,
    });
    const { text } = await extractText(doc, { mergePages: true });
    return text;
  } catch {
    return null;
  }
}
