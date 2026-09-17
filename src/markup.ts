// Emphasis rendering for everything the learner sees (spec §7): **bold** and *italic* become Telegram HTML.
// The text is escaped first and only these two paired constructs are recognised, so whatever the model or a
// topic author writes, the generated HTML is valid.

const BOLD = /\*\*([^*\n]+?)\*\*/g;
// No whitespace right inside the markers, so «2 * 3 = 6 и *x» is not an italic run.
const ITALIC = /\*(?!\s)([^*\n]+?)(?<!\s)\*/g;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes HTML, then renders paired markers; lone or unpaired asterisks stay as they are. */
export function emphasisToHtml(text: string): string {
  return escapeHtml(text).replace(BOLD, '<b>$1</b>').replace(ITALIC, '<i>$1</i>');
}

/** Removes the markers for the model prompt, so it neither sees nor imitates them. */
export function stripEmphasis(text: string): string {
  return text.replace(BOLD, '$1').replace(ITALIC, '$1');
}
