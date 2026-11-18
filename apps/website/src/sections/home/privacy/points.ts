import {PAINTINGS, type Painting} from '../../../lib/paintings';

export type Screen =
  | {kind: 'route'}
  | {kind: 'fingerprint'; series: readonly [string, string]}
  | {kind: 'enclave'}
  | {kind: 'ledger'; rows: readonly {term: string; value: string; checked?: boolean}[]};

export type PrivacyPoint = {
  id: string;
  name: string;
  line: string;
  painting: Painting;
  window: {
    title: readonly [string, string];
    screen: Screen;
    result?: string;
    body: string;
    link?: {href: string; label: string};
  };
};

export const PRIVACY_POINTS: readonly PrivacyPoint[] = [
  {
    id: 'direct',
    name: 'Direct, P2P by design',
    line: 'A direct connection removes the intermediary.',
    painting: PAINTINGS.shore,
    window: {
      title: ['Your prompt takes', 'the direct route.'],
      screen: {kind: 'route'},
      result: 'Encrypted in transit · no middleman',
      body: 'A direct connection removes the intermediary. The provider can still read what it serves unless you choose a verified TEE.',
    },
  },
  {
    id: 'model',
    name: 'Know which model you get',
    line: 'Independent auditors compare answers against a genuine model’s knowledge fingerprint.',
    painting: PAINTINGS.poppies,
    window: {
      title: ['A model has a pattern.', 'Auditors check it.'],
      screen: {kind: 'fingerprint', series: ['Genuine model', 'Provider’s answers']},
      result: 'Same questions. Compare the answer patterns.',
      body: 'Models remember obscure facts differently, including their mistakes. Auditors ask fresh questions and compare the error rate with a trusted reference.',
      link: {href: '/docs/verify/overview/', label: 'How model audits work →'},
    },
  },
  {
    id: 'tee',
    name: 'Private inside a TEE',
    line: 'Verified secure hardware protects the data inside it, even from the server operator.',
    painting: PAINTINGS.pond,
    window: {
      title: ['Private where', 'the model runs.'],
      screen: {kind: 'enclave'},
      body: 'Check the hardware attestation before sending sensitive data. Encryption protects the connection; the TEE protects data during processing.',
      link: {href: '/docs/verify-tee/', label: 'Verify a TEE →'},
    },
  },
  {
    id: 'reputation',
    name: 'Reputation & routing',
    line: 'Identity, stake and verifications help you choose who serves your requests.',
    painting: PAINTINGS.ferns,
    window: {
      title: ['Verified identity.', 'Staked reputation.'],
      screen: {kind: 'ledger', rows: [
        {term: 'Domain verification', value: 'Domain ownership verified', checked: true},
        {term: 'GitHub verification', value: 'GitHub account verified', checked: true},
        {term: 'Staking reputation', value: 'ANTS staked behind the provider'},
        {term: 'Routing', value: 'Identity + stake → provider selection'},
      ]},
      body: 'Domain and GitHub verifications establish the provider’s identity. ANTS staking backs its reputation. Your device uses these signals to help choose who serves your requests.',
      link: {href: '/docs/reputation/', label: 'How reputation works →'},
    },
  },
];
