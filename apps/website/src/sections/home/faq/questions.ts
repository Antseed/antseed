import type {FaqItem} from '../../../parts/Faq';

export const HOME_QUESTIONS: readonly FaqItem[] = [
  {
    question: 'What is the difference between the gateway and Antseed Desktop?',
    answer: 'Use the gateway to manage shared access: run your own endpoint on a server and give each agent, app, or teammate their own API key, with budgets and the models and providers you choose. Use Antseed Desktop to connect the tools on your computer, without deploying a server. Both reach the same network.',
    link: {href: '/docs/gateway/', label: 'Read the gateway docs →'},
  },
  {
    question: 'How is this different from OpenRouter?',
    answer: "OpenRouter is a centralized aggregator: it decides which models are listed, routes every request through its own servers, and holds provider payouts until withdrawal. Antseed removes the aggregator from routing. Requests go peer-to-peer, payments settle onchain directly to the provider's wallet, and anyone can provide, no approval needed.",
  },
  {
    question: 'Are the models offered the "real" models?',
    answer: 'Independent auditors test providers with Knowledge Boundary Fingerprinting: fresh questions that distinguish the genuine model from look-alikes. Results and evidence are public. A confirmed mismatch reduces service reputation. This is statistical evidence, not a guarantee for every response.',
  },
  {
    question: 'Do I need crypto?',
    answer: 'No. Top up with a card or Apple Pay. Payments to providers settle in USDC on the Base blockchain, but you never have to touch it.',
  },
  {
    question: 'What happens when LLMs become so good that anyone can do anything?',
    answer: 'That is exactly what we want. When LLMs become dramatically more capable, costs collapse and more people can run their own capable LLMs on their own hardware. Those people become Antseed providers: the supply side grows, not shrinks. The value is in what you build on top: the skills, the workflows, the domain expertise, the agent orchestration.',
  },
  {
    question: "Isn't this just like P2P file sharing? Netflix killed that.",
    answer: "Netflix and Spotify won because humans are happy to pay a simple subscription for a clean UI. Agents don't care about UI. An agent just needs the service, the price, and the reliability, and on those axes an open P2P network with no middleman and no markup wins every time.",
  },
  {
    question: 'Is Antseed built for agents specifically?',
    answer: 'It works for humans today and is being used by humans now. But USDC-native payments, no account system, open discovery and always-on peers make the network ideal for agents. The network Antseed is building is the one autonomous agents will naturally discover and use.',
  },
  {
    question: 'How can a provider offer AI models below lab price?',
    answer: 'Providers compete: some run open models on their own hardware, some sell capacity they legitimately hold. Providers must build their own service on top of upstream APIs and comply with upstream terms.',
  },
  {
    question: 'Why would a provider use Antseed instead of just building their own API?',
    answer: 'Because distribution is the hard part. On Antseed a provider plugs into existing demand: buyers, discovery, reputation, and onchain settlement come with the network. Serve a request, get paid, automatically.',
  },
];
