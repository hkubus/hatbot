/**
 * A reply's text with streamed text added. `at` is where that text starts in the reply: the part the
 * page already has, because it loaded the reply after the text was sent, isn't added twice.
 */
export function withDelta(shown: string, delta: { text: string; at?: number }): string {
  const skip = delta.at === undefined ? 0 : Math.max(0, shown.length - delta.at);
  return shown + delta.text.slice(skip);
}
