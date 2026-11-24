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

test('Studio\'s chat says the agent is working while a command runs, and never shows the command', () => {
  const tool = (status: string) => ({ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'cd /tmp/project && jq -n \'{edit:{type:"add-anchor"}}\'' }, status, content: '{"id":"a1"}' });
  const running = renderToStaticMarkup(<ChatBubble message={{ role: 'assistant', content: [tool('running')] } as never} quietWork />);
  assert.match(running, /Working…/);
  assert.ok(!running.includes('jq') && !running.includes('add-anchor') && !running.includes('a1'));
  const done = renderToStaticMarkup(<ChatBubble message={{ role: 'assistant', content: [tool('success'), { type: 'text', text: 'Shot 1 is ready.' }] } as never} quietWork />);
  assert.ok(!done.includes('jq') && !done.includes('Executed') && !done.includes('tool-group'));
  assert.match(done, /Shot 1 is ready\./);
  // Its reasoning stays hidden too: it names ids and files.
  const thinking = renderToStaticMarkup(<ChatBubble message={{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Shot 3 (a6) needs stills/a6-v1.jpg' }, { type: 'text', text: 'Shot 3 is next.' }] } as never} quietWork />);
  assert.ok(!thinking.includes('a6') && !thinking.includes('Internal Thoughts'));
  assert.match(thinking, /Shot 3 is next\./);
  // The Chat page keeps them.
  assert.match(renderToStaticMarkup(<ChatBubble message={{ role: 'assistant', content: [tool('success')] } as never} />), /Executed 1 command/);
});
