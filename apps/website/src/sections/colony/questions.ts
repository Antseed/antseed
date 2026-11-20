import type {FaqItem} from '../../parts/Faq';

export const QUESTIONS: readonly FaqItem[] = [
  {question: 'What is a Colony?', answer: 'A Colony is a group of machines working together to serve AI on Antseed. An operator coordinates the Colony, and each machine is paid for the answers it gives.'},
  {question: 'Can I join the Mac Colony today?', answer: 'Join the waitlist with your email and your Mac, and we’ll email you when there’s a spot.', link: {href: '#join', label: 'Join the waitlist →'}},
  {question: 'Can I download the app now?', answer: 'Not yet. The download comes with your invite, along with the address of the Colony you join.'},
  {question: 'Which Macs can join?', answer: 'Any Mac with Apple silicon on macOS 14 or later can sign up.'},
  {question: 'What do I need once I’m invited?', answer: 'The address of the Colony from your invite, and a wallet on Base for what your Mac earns. The app walks you through both.', link: {href: '#setup', label: 'Set up your Mac →'}},
  {question: 'Can I still use my Mac?', answer: 'Yes. Pause sharing in the app any time.'},
  {question: 'Does my Mac need to stay on?', answer: 'Your Mac serves while it’s awake and online. The app can open at login and keep the Mac awake while it shares.'},
  {question: 'How do I get paid?', answer: 'Your Mac is paid for the answers it gives. The app shows what it has earned, and you claim it to your own wallet.'},
  {question: 'Does it cost anything to join?', answer: 'No. Joining is free.'},
  {question: 'Can I build my own Colony?', answer: 'Not yet. Building a Colony of your own is coming soon.'},
  {question: 'Can the pool operator read prompts or keep my earnings?', answer: 'The operator routes only ciphertext, and the pool contract pays workers from what the buyer signed for them. The operator still decides which Mac gets work.'},
  {question: 'Is this a TEE?', answer: 'No. The Mac keeps its keys in the Secure Enclave, but memory is not encrypted and the Mac’s owner can still read prompts in the inference engine. For hardware-encrypted inference, use TEE sellers.'},
];
