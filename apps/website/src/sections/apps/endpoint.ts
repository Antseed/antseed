import type {Feature} from '../../parts/FeatureList';
import type {TerminalBlock} from '../../parts/Terminal/Terminal';
import {plain, string, value} from '../../parts/Terminal/tokens';

export const POINTS: readonly Feature[] = [
  {icon: 'plug', text: 'Compatible with OpenAI and Anthropic APIs.'},
  {icon: 'directions', text: 'Choose models and providers through one endpoint.'},
  {icon: 'analytics', text: 'Give each app its own key and budget.'},
];

/** A minimal OpenAI SDK connection; model IDs come from the gateway catalog. */
export const BLOCKS: readonly TerminalBlock[] = [
  {comment: '# Python with the openai package installed', lines: [[value('import os')], [value('from openai import OpenAI')]]},
  {
    comment: '# Use your gateway URL; set ANTSEED_API_KEY to its key',
    lines: [[plain('client = OpenAI(')], [string('    base_url="https://gateway.example.com/v1",')], [string('    api_key=os.environ["ANTSEED_API_KEY"],')], [plain(')')]],
  },
  {
    comment: '# Replace this model ID with one from your gateway',
    lines: [
      [plain('reply = client.chat.completions.create(')],
      [string('    model="deepseek-v4-flash",')],
      [plain('    messages=[{"role": "user", "content": "Hello"}],')],
      [plain(')')],
      [plain('print(reply.choices[0].message.content)')],
    ],
  },
];
