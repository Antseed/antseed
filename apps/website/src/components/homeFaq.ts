/** Homepage FAQ — shared with /network. */
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
    q: 'What happens when LLMs become so good that anyone can do anything?',
    a: 'That is exactly what we want. When LLMs become dramatically more capable, costs collapse and more people can run their own capable LLMs on their own hardware. Those people become Antseed providers - the supply side grows, not shrinks. But "anyone can do anything" does not mean everyone delivers the same result. The value is in what you build on top: the skills, the workflows, the domain expertise, the agent orchestration. A more capable base model raises the ceiling for every provider.',
  },
  {
    q: "Isn't this just like P2P file sharing? Netflix killed that.",
    a: "Netflix and Spotify won because humans are happy to pay a simple subscription for a clean UI. That logic only applies to humans who care about experience. Agents don't - in a world of agents, UI is not a moat. An agent has no preference for a polished interface, no reason to care about a brand, no inertia keeping it on a familiar platform. It just needs the service, the price, and the reliability - and on those axes, an open P2P network with no middleman and no markup wins every time.",
  },
  {
    q: 'Is Antseed built for agents specifically?',
    a: 'It works for humans today and is being used by humans now. But the architecture decisions - USDC-native payments, no account system, open discovery, always-on peers - are all decisions that make the network ideal for agents. A human tolerates signing up, waiting for API keys, and managing a subscription. An agent cannot. The network Antseed is building is the one autonomous agents will naturally discover and use.',
  },
  {
    q: 'How can a provider offer AI models below lab price?',
    a: 'Providers compete - some run open models on their own hardware, some sell capacity they legitimately hold. Providers must build their own service on top of upstream APIs and comply with upstream terms.',
  },
  {
    q: 'Why would a provider use Antseed instead of just building their own API?',
    a: 'Because distribution is the hard part. On Antseed a provider plugs into existing demand - buyers, discovery, reputation, and onchain settlement come with the network. No billing stack to build, no customers to acquire, no payment risk to carry. Serve a request, get paid, automatically.',
  },
];

