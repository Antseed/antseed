import { kbfVerificationMigration, RELEASE as SINGLE_AUDITOR_RELEASE } from './m003.mjs';

export const RELEASE = '004-kbf-rounds';
export const POLICY_NOTE = 'M004 deploys the round-based KBF verification contract and its points policy, replacing the '
  + 'single-auditor contract from 003-kbf-verification as the current verification contract. The policy is not '
  + 'registered in the points policy registry by M004; the registry owner registers it separately.';

const m004 = kbfVerificationMigration({ id: 'M004', release: RELEASE, replaces: SINGLE_AUDITOR_RELEASE, note: POLICY_NOTE });
export const { migration, recordErrors, activationRecords } = m004;
