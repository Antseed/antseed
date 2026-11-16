/**
 * Lines the walking ant shows while a reply is on its way. One is picked at
 * random per turn and re-rolled every few seconds. Keep them short, kind and
 * work-safe; the ant adds the trailing ellipsis.
 */
export const THINKING_PHRASES: readonly string[] = [
  // The originals.
  'Hodl',
  'Brrrr',
  'NGMI',
  'WAGMI',
  'To the moon',
  'Wen channel',
  'gm',
  'Stacking sats',
  'Few understand',
  'LFG',
  'Probably nothing',
  'Aping in',
  'This is the way',
  'Ser, pls wait',
  'Number go up',
  'Diamond hands',
  'p2p2pinging',
  'Foraging for tokens',
  'Pinning to the DHT',
  'Sharding the prompt',
  // Ants.
  'Waking up the colony',
  'Asking the queen',
  'Following the scent trail',
  'Carrying 50x my weight in tokens',
  'Marching in single file',
  'Walking around a twig',
  'Antennae up',
  'Sniffing out the answer',
  'Digging a tunnel',
  'Building an anthill of thoughts',
  'Small legs, big ideas',
  'Six legs, full speed',
  'The colony is on it',
  'Hold on, carrying a leaf',
  'Teaching ants to type',
  'Queueing behind a beetle',
  // Seeds.
  'Planting seeds',
  'Watering the prompt',
  'Germinating ideas',
  'Sprouting an answer',
  'Myrmecochory in progress',
  'Seeds take time',
  'Good things grow slowly',
  'Composting bad ideas',
  'Rooting for you',
  'Almost sprouted',
  // Models and tokens.
  'Counting tokens',
  'Warming up the weights',
  'Waking the attention heads',
  'Picking the next token',
  'Shuffling the logits',
  'One token at a time',
  'Brewing tokens',
  'Embedding the vibes',
  'Gathering crumbs of context',
  'Tunneling through layers',
  // Peers and waiting.
  'Peer to peer to peer',
  'Shaking hands with a peer',
  'Good answers take a moment',
  'Thinking with all six legs',
];

export function pickThinkingPhrase(exclude?: string, random: () => number = Math.random): string {
  const pick = () => THINKING_PHRASES[Math.floor(random() * THINKING_PHRASES.length)];
  for (let i = 0; i < 6; i += 1) {
    const phrase = pick();
    if (phrase !== exclude) return phrase;
  }
  return pick();
}
