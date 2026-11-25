import type {FaqItem} from '../../parts/Faq';

/** The four questions only a privacy-minded visitor asks; the rest, including what a passing TEE check proves, live in /docs/faq. */
export const QUESTIONS: readonly FaqItem[] = [
  {
    question: 'Can providers see my prompts?',
    answer: <>Standard providers can. TEE-verified providers cannot, because the hardware prevents it even if the operator wanted to look. When you pay for a TEE-verified request you receive a cryptographic attestation proving the enclave was genuine. <a href="/docs/verify-tee/">How verification works →</a></>,
  },
  {
    question: 'What does a provider learn about me?',
    answer: 'A pseudonymous peer or wallet identity, and the request it serves. Not your name, your email, or your account on the tool you connected. Antseed does not tell the provider who you are; who you are and what you asked are handled separately.',
  },
  {
    question: 'Does Antseed log my requests?',
    answer: 'The protocol creates no central request log. Independent providers, nodes, RPC providers, analytics tools, or other infrastructure may still log or observe data, and each provider has its own data handling practices. Prefer TEE-verified providers where stronger confidentiality matters.',
  },
  {
    question: 'Is paying anonymous too?',
    answer: <>There is no account to pay from. You can top up by card or Apple Pay in Antseed Desktop, or with USDC from the CLI. Settlement happens in USDC on Base, so payments are tied to a wallet, not to your name, and like any public chain that activity is visible onchain. <a href="/docs/faq/">More questions in the FAQ →</a></>,
  },
];
