import { describe, expect, it } from 'vitest';
import { grade, looksLikeAttempt, normalizeAnswer, stripDiacritics } from '../src/grade.ts';

describe('normalizeAnswer', () => {
  it('trims, collapses whitespace and lowercases', () => {
    expect(normalizeAnswer('  Poszła   do  ')).toBe('poszła do');
  });
  it('strips a trailing full stop', () => {
    expect(normalizeAnswer('poszła.')).toBe('poszła');
  });
  it('treats punctuation separated by a space the same', () => {
    expect(normalizeAnswer('poszła .')).toBe('poszła');
    expect(normalizeAnswer('poszła. ')).toBe('poszła');
    expect(normalizeAnswer(' poszła . ')).toBe('poszła');
  });
});

describe('stripDiacritics', () => {
  it('maps every Polish diacritic to its base letter', () => {
    expect(stripDiacritics('ąćęłńóśźż ĄĆĘŁŃÓŚŹŻ')).toBe('acelnoszz ACELNOSZZ');
  });
});

describe('grade', () => {
  it('matches exactly after normalisation', () => {
    expect(grade('Poszła ', 'poszła')).toBe('match');
    expect(grade('poszła .', 'poszła')).toBe('match');
  });
  it('matches a decomposed (NFD) Polish letter against its precomposed (NFC) form', () => {
    const decomposed = 'cześć'.normalize('NFD');
    expect(decomposed).not.toBe('cześć');
    expect(grade(decomposed, 'cześć')).toBe('match');
  });
  it('matches only without diacritics', () => {
    expect(grade('poszla', 'poszła')).toBe('match-ignoring-diacritics');
    expect(grade('czesc', 'cześć')).toBe('match-ignoring-diacritics');
  });
  it('reports a mismatch', () => {
    expect(grade('poszli', 'poszła')).toBe('mismatch');
  });
});

describe('looksLikeAttempt', () => {
  it('rejects fewer than two characters', () => {
    expect(looksLikeAttempt('p')).toBe(false);
    expect(looksLikeAttempt('są')).toBe(true);
  });
  it('rejects text without a single Polish letter', () => {
    expect(looksLikeAttempt('не знаю')).toBe(false);
    expect(looksLikeAttempt('123 ???')).toBe(false);
  });
  it('accepts a plausible Polish word', () => {
    expect(looksLikeAttempt('poszła')).toBe(true);
    expect(looksLikeAttempt('szli')).toBe(true);
  });
});
