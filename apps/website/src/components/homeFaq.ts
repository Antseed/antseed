/** Homepage FAQ — the four questions only a first-time visitor asks.
    Everything else lives in /docs/faq. */
export const HOME_FAQ = [
  {
    q: 'How is this different from OpenRouter?',
    a: "OpenRouter is a centralized aggregator: it decides which models are listed, routes every request through its own servers, and holds provider payouts until withdrawal. Antseed removes the aggregator from routing. Requests go peer-to-peer, payments settle onchain directly to the provider's wallet, and anyone can provide - no approval needed. <a href=\"/vs/openrouter\">Read the full comparison →</a>",
  },
  {
    q: 'Are the models offered the "real" models?',
    a: "Yes, every response is signed by the provider and matched against the model's fingerprint. Providers who serve something else lose reputation and stop getting routed. You can see who served each request.",
  },
  {
    q: 'Do I need crypto?',
    a: 'No. Top up with a card or Apple Pay. Payments to providers settle in USDC on the Base blockchain, but you never have to touch it.',
  },
  {
    q: 'Is Antseed built for agents specifically?',
    a: 'It works for humans today and is being used by humans now. But the architecture decisions - USDC-native payments, no account system, open discovery, always-on peers - are all decisions that make the network ideal for agents. A human tolerates signing up, waiting for API keys, and managing a subscription. An agent cannot. <a href="/docs/faq">More questions in the FAQ →</a>',
  },
];
