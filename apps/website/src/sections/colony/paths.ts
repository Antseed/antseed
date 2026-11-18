const A = '/site/assets/colony';

export type ColonyPath = {
  id?: string;
  name: string;
  state: string;
  copy: string;
  painting: {day: string; night: string; label: string};
  /** `signUp`: the sign-up (and community) buttons; `soon`: a faded button, nothing to click yet. */
  action: 'signUp' | 'soon';
};

export const PATHS: readonly ColonyPath[] = [
  {
    id: 'join-mac',
    name: 'Join the Mac Colony.',
    state: 'Early access',
    copy: 'Put your Mac to work alongside others. The Mac Colony brings Apple silicon Macs together to serve AI on Antseed, and each Mac is paid for the answers it gives. Mac Studios with 256 GB or more go first, and 512 GB is ideal. Any Mac can sign up.',
    painting: {
      day: `${A}/join-day.webp`,
      night: `${A}/join-night.webp`,
      label: 'Three ants stand behind three Mac Studios joined by cables on a wooden plank. A fourth ant walks up carrying its own Mac Studio to the empty space at the end.',
    },
    action: 'signUp',
  },
  {
    name: 'Build a Colony.',
    state: 'Coming soon',
    copy: 'Bring a community of machines together and run the Colony others join. You choose the models it serves and coordinate the work.',
    painting: {
      day: `${A}/build-day.webp`,
      night: `${A}/build-night.webp`,
      label: 'One ant with a rolled-up plan drives a stake into a roped-off circle of bare ground beside a blank wooden sign. A second ant sits on a pile of twigs and watches.',
    },
    action: 'soon',
  },
];
