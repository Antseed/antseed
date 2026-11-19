import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatBubble } from './ChatBubble';

const LINE = '[Studio: Shot 1 "Wanted" (anchor a1) · image stills/shot1-v2.png · aspect 16:9]';

test('a message sent with a Studio selection keeps it as a chip, not as the raw line', () => {
  for (const content of [`${LINE}\nok please do`, [{ type: 'text', text: `${LINE}\nok please do` }]]) {
    const markup = renderToStaticMarkup(<ChatBubble message={{ role: 'user', content }} />);
    assert.match(markup, />Shot 1 · Wanted<\/span>/);
    assert.match(markup, /ok please do/);
    assert.ok(!markup.replace(/title="[^"]*"/g, '').includes('[Studio:'), 'the line shows only as the chip\'s tooltip');
    assert.ok(markup.includes(`title="${LINE.replace(/"/g, '&quot;')}"`));
  }
});

test('an ordinary message and an assistant reply are left as they are', () => {
  assert.ok(!renderToStaticMarkup(<ChatBubble message={{ role: 'user', content: 'hello' }} />).includes('context-chip'));
  assert.match(renderToStaticMarkup(<ChatBubble message={{ role: 'assistant', content: `${LINE}\nquoted` }} />), /\[Studio:/);
});
