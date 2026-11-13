import {CommandChip} from './CommandChip';

/** The one command that hands an agent the join-buyer skill. Same chip on
    every page so "give your agent the skill" always means this. */
export const JOIN_BUYER_SKILL_COMMAND = 'gh skill install Antseed/antseed join-buyer';

export function SkillChip({size = 'lg', dark = false}: {size?: 'md' | 'lg'; dark?: boolean}) {
  return <CommandChip command={JOIN_BUYER_SKILL_COMMAND} size={size} dark={dark} />;
}
