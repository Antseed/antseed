import type {CodeLine, Token, TokenKind} from './Terminal';

const kind = (k: TokenKind) => (text: string): Token => ({text, kind: k});

/** Token makers, one per colour. */
export const sub = kind('sub');
export const flag = kind('flag');
export const value = kind('value');
export const string = kind('string');
export const plain = kind('plain');

/** A shell line: the prompt, the command, then its words one space apart. */
export function shell(command: string, ...words: Token[]): CodeLine {
  return [{text: '$ ', kind: 'prompt'}, {text: command, kind: 'command'}, ...words.flatMap((w) => [{text: ' '}, w])];
}
