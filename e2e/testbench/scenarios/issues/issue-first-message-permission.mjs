// A new chat's first message ran with approval though the model was set to Full access: sending it opens the chat,
// which shows Ask first until the model's saved mode is read back, and the send went out with that Ask first.
// Later messages in the chat ran with Full access.
//
// The desktop sets Full access in a new chat, then sends a prompt the mock upstream answers with a file-changing
// shell call (`[shell-write]`). With Full access it runs without asking and the reply arrives; the bug shows the
// approval card instead. A second message in the same chat shows what later messages do. Then the other way: a new
// chat set to Ask first still asks on its first message.
import { SHELL_WRITE_MARKER } from '../../lib/mock.mjs';

export const meta = {
  description: 'Full access in a new chat: the first message runs its file-changing shell call without asking, as later messages do; Ask first still asks.',
  targets: ['local', 'fork'],
  requires: ['desktop', 'mockControl'],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

const APPROVAL = 'Allow file-changing shell command?';

export async function run(tb) {
  const ui = await tb.desktop();
  const { page } = ui;
  await ui.openChat();

  const accessPicker = () => page.locator('button[aria-haspopup="menu"]').filter({ hasText: /Ask first|Full access/ });
  /** Sets Agent access in the composer, as a user does, and returns what the picker shows after. */
  const setAccess = async (label) => {
    await accessPicker().click();
    await page.getByRole('menuitemradio', { name: label }).click();
    // Saved per model: give the save its moment before the first message, as a user would.
    await page.waitForTimeout(1000);
    return (await accessPicker().innerText()).trim();
  };

  const picker = await setAccess('Full access');
  await ui.screenshot('new-chat-full-access');
  tb.check('the new chat shows Full access before the first message', picker === 'Full access', picker);

  /** Sends `prompt`, then waits for the approval card or the reply after it, whichever comes first. */
  const send = async (prompt) => {
    await page.locator('textarea').first().fill(prompt);
    await page.getByRole('button', { name: 'Send message' }).click();
    const approval = page.getByRole('group', { name: APPROVAL });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await approval.isVisible().catch(() => false)) return 'approval';
      const body = await ui.text();
      const at = body.lastIndexOf(prompt);
      if (at >= 0 && /Hello from testbench seller/.test(body.slice(at + prompt.length))) return 'reply';
      await page.waitForTimeout(200);
    }
    return 'timeout';
  };

  const first = await send(`${SHELL_WRITE_MARKER} [req:first-message] make a file`);
  await ui.screenshot(`first-message-${first}`);
  // The run waits on the card; Deny ends it so the chat can take the next message.
  if (first === 'approval') {
    await page.getByRole('group', { name: APPROVAL }).getByRole('button', { name: 'Deny' }).click();
    await page.getByRole('button', { name: 'Send message' }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
  }

  const second = await send(`${SHELL_WRITE_MARKER} [req:second-message] make another file`);
  await ui.screenshot(`second-message-${second}`);

  // A new chat on the same model, set to Ask first: its first message must still ask.
  // New chat lands on Home; the composer is on the Chat page.
  await page.getByRole('button', { name: 'New chat' }).click();
  await ui.openChat();
  const leftover = (await ui.text()).includes('[req:first-message]');
  tb.check('the second new chat opens empty', !leftover, leftover ? 'the earlier chat is on screen' : 'empty');
  const askPicker = await setAccess('Ask first');
  await ui.screenshot('new-chat-ask-first');
  const askFirst = await send(`${SHELL_WRITE_MARKER} [req:ask-first-message] make a third file`);
  await ui.screenshot(`ask-first-message-${askFirst}`);
  if (askFirst === 'approval') await page.getByRole('group', { name: APPROVAL }).getByRole('button', { name: 'Deny' }).click();

  // Judged after every message, so a failing first message still shows what the later ones do.
  tb.check('the first message runs its shell call with Full access, without asking', first === 'reply', first);
  tb.check('the second message runs its shell call with Full access, without asking', second === 'reply', second);
  tb.check('a new chat set to Ask first shows it before its first message', askPicker === 'Ask first', askPicker);
  tb.check('the first message of a new chat set to Ask first still asks', askFirst === 'approval', askFirst);

  tb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
  await ui.close();
}
