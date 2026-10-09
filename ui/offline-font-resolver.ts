/**
 * Factory shape consumed by Troika's font resolver. All missing characters use
 * the bundled font's missing-glyph outline; no Unicode font service is queried.
 * Keep the factory self-contained because Troika can serialize it for workers.
 */
export default function createOfflineUnicodeFontResolver() {
  return {
    getFontsForString(text: string) {
      return Promise.resolve({
        fontUrls: [new URL("/assets/font.ttf", self.location.origin).href],
        chars: new Uint8Array(text.length),
      })
    },
  }
}
