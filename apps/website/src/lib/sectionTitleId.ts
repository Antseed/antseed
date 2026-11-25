/** The id of a section's title, from its comparison key: `home/privacy` → `home-privacy-title`. */
export const sectionTitleId = (cmp: string): string => `${cmp.replace('/', '-')}-title`;
