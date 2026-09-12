// Local grading for exact-match tasks (spec §5 "Быстрый путь"). Pure.

export type GradeOutcome = 'match' | 'match-ignoring-diacritics' | 'mismatch';

const DIACRITICS: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z',
};

export function stripDiacritics(s: string): string {
  return s.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (ch) => DIACRITICS[ch] ?? ch);
}

export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFC')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pl');
}

export function grade(userAnswer: string, reference: string): GradeOutcome {
  const a = normalizeAnswer(userAnswer);
  const b = normalizeAnswer(reference);
  if (a === b) return 'match';
  if (stripDiacritics(a) === stripDiacritics(b)) return 'match-ignoring-diacritics';
  return 'mismatch';
}

/** Spec §7: shorter than two characters or without a single letter of the target language (currently Latin plus Polish letters) is not an attempt. */
export function looksLikeAttempt(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  return /[a-ząćęłńóśźż]/i.test(t);
}
