import { describe, expect, it } from 'vitest';
import { emphasisToHtml, escapeHtml, stripEmphasis } from '../src/markup.ts';

describe('markup', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
  it('turns **bold** and *italic* into Telegram HTML, escaping the rest', () => {
    expect(emphasisToHtml('Формы **ty**, **on**: *i*/*y* → *ę* (**ja**) & <x>')).toBe(
      'Формы <b>ty</b>, <b>on</b>: <i>i</i>/<i>y</i> → <i>ę</i> (<b>ja</b>) &amp; &lt;x&gt;',
    );
  });
  it('leaves a lone asterisk and unpaired markers alone', () => {
    expect(emphasisToHtml('2 * 3 = 6 и *открытый')).toBe('2 * 3 = 6 и *открытый');
  });
  it('does not pair markers across lines', () => {
    expect(emphasisToHtml('*a\nb*')).toBe('*a\nb*');
  });
  it('strips the markers for the model', () => {
    expect(stripEmphasis('**ty** и *ć*: 2 * 3')).toBe('ty и ć: 2 * 3');
  });
});
