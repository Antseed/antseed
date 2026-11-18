import type {FaqItem} from '../../parts/Faq';
import {SIGN_UP_HREF} from './signUpLinks';

/** The answer the privacy band's "Read the limits" link opens. */
export const TEE_ANSWER_ID = 'is-this-a-tee';

export const QUESTIONS: readonly FaqItem[] = [
  {question: 'What is a Colony?', answer: 'A Colony is a group of machines working together to serve AI on Antseed. An operator coordinates the Colony, and each machine is paid for the answers it gives.'},
  {question: 'Can I join the Mac Colony today?', answer: 'Early access is invite-only while we test. Sign up with your Mac’s details and we’ll reach out with an invite to the early group.', link: {href: SIGN_UP_HREF, label: 'Sign up →'}},
  {question: 'Can I download the app now?', answer: 'Not yet. Early members get it from our team in the early group.'},
  {question: 'Which Macs can join?', answer: 'Macs with Apple silicon on macOS 14 or later. The first Colony serves a large model, so it starts with Mac Studios with 256 GB or more.'},
  {question: 'Can I still use my Mac?', answer: 'Yes. Pause sharing from the menu bar any time.'},
  {question: 'Does my Mac need to stay on?', answer: 'Your Mac serves while it’s awake and online. The app can open at login and keep the Mac awake while it shares.'},
  {question: 'How do I get paid?', answer: 'Your Mac is paid for the answers it gives. The app shows what it has earned, and you claim it to your own wallet.'},
  {question: 'Does it cost anything to join?', answer: 'No. Joining is free.'},
  {question: 'Can I build my own Colony?', answer: 'Not yet. Building a Colony of your own is coming soon.'},
  {question: 'Can the pool operator read prompts or keep my earnings?', answer: 'The operator routes only ciphertext, and the pool contract pays workers from what the buyer signed for them. The operator still decides which Mac gets work.'},
  {id: TEE_ANSWER_ID, question: 'Is this a TEE?', answer: 'No. The Mac keeps its keys in the Secure Enclave, but memory is not encrypted and the Mac’s owner can still read prompts in the inference engine. For hardware-encrypted inference, use TEE sellers.'},
];
