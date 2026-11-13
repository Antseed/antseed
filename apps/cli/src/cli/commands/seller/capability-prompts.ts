import chalk from 'chalk';
import {
  SERVICE_CAPABILITY_MODALITIES,
  validateServiceCapabilityFields,
  type ServiceCapabilities,
  type ServiceCapabilityModality,
} from '@antseed/node';
import { parseServiceCapabilitiesInput } from '../../../config/service-metadata.js';

export type Prompt = { question(query: string): Promise<string> };

const MODALITY_HINT = SERVICE_CAPABILITY_MODALITIES.join(', ');

async function askUntilValid<T>(
  rl: Prompt,
  query: string,
  parse: (raw: string) => { value: T } | { error: string },
): Promise<T | undefined> {
  for (;;) {
    const raw = (await rl.question(query)).trim();
    if (!raw) return undefined;
    const parsed = parse(raw);
    if ('error' in parsed) {
      console.log(chalk.red(`  ${parsed.error}`));
      continue;
    }
    return parsed.value;
  }
}

function parseTokenCount(field: 'contextWindow' | 'maxOutputTokens'): (raw: string) => { value: number } | { error: string } {
  return (raw) => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      return { error: 'Enter a positive integer, or press enter to skip.' };
    }
    const candidate: ServiceCapabilities = field === 'contextWindow' ? { contextWindow: value } : { maxOutputTokens: value };
    const errors = validateServiceCapabilityFields(candidate);
    if (errors.length > 0) return { error: errors.join('; ') };
    return { value };
  };
}

function parseYesNo(raw: string): { value: boolean } | { error: string } {
  const normalized = raw.toLowerCase();
  if (normalized === 'y' || normalized === 'yes') return { value: true };
  if (normalized === 'n' || normalized === 'no') return { value: false };
  return { error: 'Enter y or n, or press enter to leave unknown.' };
}

function splitCsv(raw: string): string[] {
  return raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function parseModalities(field: 'inputs' | 'outputs'): (raw: string) => { value: ServiceCapabilityModality[] } | { error: string } {
  return (raw) => {
    const modalities = splitCsv(raw) as ServiceCapabilityModality[];
    if (modalities.length === 0) return { error: 'Enter at least one value, or press enter to skip.' };
    const candidate: ServiceCapabilities = field === 'inputs' ? { inputs: modalities } : { outputs: modalities };
    const errors = validateServiceCapabilityFields(candidate);
    if (errors.length > 0) return { error: errors.join('; ') };
    return { value: modalities };
  };
}

function parseSupportedParameters(raw: string): { value: string[] } | { error: string } {
  const parameters = splitCsv(raw);
  if (parameters.length === 0) return { error: 'Enter at least one value, or press enter to skip.' };
  const errors = validateServiceCapabilityFields({ supportedParameters: parameters });
  if (errors.length > 0) return { error: errors.join('; ') };
  return { value: parameters };
}

/** Which question set the guided flow asks; derived from the service's protocol. */
export type ServiceKind = 'text' | 'image';

/**
 * Guided per-field capability prompts for the seller setup wizard: asks one
 * question per capability, skips anything left empty (absent means unknown),
 * and assembles the validated `capabilities` object. The question set depends
 * on the service kind — image services skip the token-limit and text-feature
 * questions and get image-parameter hints instead. Answering the opening
 * question with a pasted JSON object (starting with `{`) keeps the previous
 * paste-the-JSON path working.
 */
export async function promptServiceCapabilities(rl: Prompt, kind: ServiceKind = 'text'): Promise<ServiceCapabilities | undefined> {
  const opening = (await rl.question('Configure capabilities? (y/N, or paste JSON): ')).trim();
  if (opening.startsWith('{')) {
    return parseServiceCapabilitiesInput(opening);
  }
  if (opening.toLowerCase() !== 'y' && opening.toLowerCase() !== 'yes') {
    return undefined;
  }

  console.log(chalk.gray('  Press enter to skip any field — omitted fields announce as "unknown".'));
  const caps: ServiceCapabilities = {};
  if (kind === 'image') {
    console.log(chalk.gray('  Image service: outputs ["image"] is announced automatically.'));
    const inputs = await askUntilValid(
      rl,
      '  Input modalities (comma-separated; "text" for generation only, "text,image" if the upstream supports edits): ',
      parseModalities('inputs'),
    );
    if (inputs !== undefined) caps.inputs = inputs;
    const supportedParameters = await askUntilValid(
      rl,
      '  Supported request parameters (comma-separated snake_case, e.g. background,output_format,quality,size): ',
      parseSupportedParameters,
    );
    if (supportedParameters !== undefined) caps.supportedParameters = supportedParameters;
  } else {
    const contextWindow = await askUntilValid(rl, '  Context window (tokens): ', parseTokenCount('contextWindow'));
    if (contextWindow !== undefined) caps.contextWindow = contextWindow;
    const maxOutputTokens = await askUntilValid(rl, '  Max output tokens: ', parseTokenCount('maxOutputTokens'));
    if (maxOutputTokens !== undefined) caps.maxOutputTokens = maxOutputTokens;
    const inputs = await askUntilValid(rl, `  Input modalities (comma-separated: ${MODALITY_HINT}): `, parseModalities('inputs'));
    if (inputs !== undefined) caps.inputs = inputs;
    const outputs = await askUntilValid(
      rl,
      `  Output modalities (comma-separated: ${MODALITY_HINT}; usually skip — set e.g. "text,image" for chat models that also generate images): `,
      parseModalities('outputs'),
    );
    if (outputs !== undefined) caps.outputs = outputs;
    const reasoning = await askUntilValid(rl, '  Supports reasoning / extended thinking? (y/n): ', parseYesNo);
    if (reasoning !== undefined) caps.reasoning = reasoning;
    const toolUse = await askUntilValid(rl, '  Supports tool use / function calling? (y/n): ', parseYesNo);
    if (toolUse !== undefined) caps.toolUse = toolUse;
    const structuredOutput = await askUntilValid(rl, '  Supports structured output / JSON schema? (y/n): ', parseYesNo);
    if (structuredOutput !== undefined) caps.structuredOutput = structuredOutput;
    const supportedParameters = await askUntilValid(
      rl,
      '  Extra supported request parameters (comma-separated snake_case, e.g. seed,logprobs): ',
      parseSupportedParameters,
    );
    if (supportedParameters !== undefined) caps.supportedParameters = supportedParameters;
  }

  if (Object.keys(caps).length === 0) {
    return undefined;
  }
  console.log(chalk.gray(`  Capabilities: ${JSON.stringify(caps)}`));
  return caps;
}
