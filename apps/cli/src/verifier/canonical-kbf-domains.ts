import { canonicalJsonStringify, sha256Hex, type KbfProbe, type ProbeTolerance } from '@antseed/fingerprints'

export interface CanonicalKbfDomain<TKey extends string = string> {
  key: TKey
  name: string
  range: [number, number]
  tolerance: ProbeTolerance
  template: string
  generationSubject: string
  themes: readonly string[]
}

function domain<const TKey extends string>(
  key: TKey,
  name: string,
  range: [number, number],
  tolerance: ProbeTolerance,
  template: string,
  generationSubject: string,
  themes: readonly string[],
): CanonicalKbfDomain<TKey> {
  return { key, name, range, tolerance, template, generationSubject, themes }
}

export const CANONICAL_KBF_DOMAINS = [
  domain('chemistry_bp', 'Chemistry (boiling points)', [-300, 600], { mode: 'absolute', value: 3 }, 'The boiling point of {name} at 1 atm is ___°C.', 'obscure chemical compounds with well-defined boiling points at 1 atm', ['organometallics and organosilicons', 'heterocyclic nitrogen compounds and azoles', 'halogenated specialty compounds', 'sulfur and phosphorus synthesis reagents']),
  domain('chemistry_mp', 'Chemistry (melting points)', [-300, 4000], { mode: 'absolute', value: 3 }, 'The melting point of {name} is ___°C.', 'obscure compounds or minerals with well-defined melting points', ['metal oxides and ceramics', 'organic crystals and intermediates', 'inorganic salts and coordination compounds', 'intermetallic compounds and alloys']),
  domain('physics', 'Physics (material properties)', [0, 1e15], { mode: 'relative', value: 0.02 }, 'The numerical value of {name} in SI units is ___.', 'obscure physical constants, material properties, or measured quantities expressed in SI units', ['thermal and acoustic properties', 'optical properties', 'nuclear and particle constants', 'electromagnetic material properties']),
  domain('astronomy', 'Astronomy (periods and distances)', [0, 1e15], { mode: 'relative', value: 0.05 }, 'The numerical value of {name} is ___.', 'obscure astronomical measurements with units stated in the fact name', ['irregular moon orbital periods', 'minor planet measurements', 'dim stellar systems', 'unusual galaxies and nebulae']),
  domain('biology', 'Biology (chromosome numbers)', [1, 2000], { mode: 'absolute', value: 0 }, 'The diploid chromosome number (2n) of {name} is ___.', 'obscure organisms with established diploid chromosome numbers', ['ferns and lycopods', 'deep-sea and cartilaginous fish', 'unusual insects and arachnids', 'rare plants and fungi']),
  domain('math', 'Mathematics (special values)', [-1e10, 1e10], { mode: 'absolute', value: 0 }, 'The numerical value of {name} is ___.', 'named mathematical constants, sequence terms, or exact finite counts', ['combinatorics and graph theory', 'number-theory constants', 'special functions', 'finite geometry and topology']),
  domain('programming', 'Programming (release years)', [1950, 2030], { mode: 'absolute', value: 0 }, 'The first public release year of {name} was ___.', 'obscure programming languages, runtimes, or systems with documented first public release years', ['scientific languages', 'historical operating systems', 'specialist runtimes', 'database and protocol implementations']),
  domain('medical', 'Medical (drug half-lives)', [0.01, 5000], { mode: 'relative', value: 0.1 }, 'The elimination half-life of {name} is approximately ___ hours.', 'specialist drugs with established elimination half-lives in hours', ['rare-disease therapies', 'oncology agents', 'specialist antimicrobials', 'metabolic and neurologic medicines']),
  domain('pop_culture', 'Pop culture (box office and ratings)', [1, 10000], { mode: 'absolute', value: 0 }, 'The numerical value associated with {name} is ___.', 'less-famous pop-culture facts with one exact integer answer and scale stated in the name', ['film production facts', 'television episode facts', 'music release facts', 'games and books']),
  domain('internet_culture', 'Internet culture (dates and numbers)', [1, 2030], { mode: 'absolute', value: 0 }, 'The numerical value associated with {name} is ___.', 'internet-history facts with one exact year or integer answer', ['early web services', 'community milestones', 'protocol history', 'open-source project history']),
  domain('chinese_history', 'Chinese history (specific dates)', [-3000, 2030], { mode: 'absolute', value: 0 }, '{name}发生在___年。', 'specific events, reigns, institutions, or works in Chinese history expressed as a year', ['regional dynastic events', 'administrative reforms', 'scientific and literary history', 'trade and diplomatic history']),
  domain('chinese_geography', 'Chinese geography (measurements)', [1, 1e9], { mode: 'relative', value: 0.05 }, '{name}的数值是___。', 'Chinese geographic measurements with units stated in the fact name', ['county and prefecture geography', 'rivers and lakes', 'mountains and basins', 'transport geography']),
  domain('chinese_internet', 'Chinese internet (platform dates)', [1990, 2030], { mode: 'absolute', value: 0 }, '{name}发生在___年。', 'Chinese internet-history events expressed as an exact year', ['early platforms', 'major product launches', 'industry events', 'games and livestreaming']),
  domain('chinese_literature', 'Chinese literature (publication years)', [-3000, 2030], { mode: 'absolute', value: 0 }, '{name}的数值是___。', 'Chinese literary facts expressed as an exact year or integer', ['modern publication years', 'classical works and authors', 'literary journals and movements', 'science fiction and online literature']),
  domain('crypto_params', 'Cryptography (parameters)', [0, 1e10], { mode: 'absolute', value: 0 }, 'The numerical value of {name} is ___.', 'documented cryptographic parameters with one exact integer answer', ['cipher rounds and block sizes', 'hash and MAC parameters', 'post-quantum parameter sets', 'standardization years']),
] as const satisfies readonly CanonicalKbfDomain[]

export type CanonicalKbfDomainKey = (typeof CANONICAL_KBF_DOMAINS)[number]['key']

const DOMAINS_BY_KEY = new Map<string, CanonicalKbfDomain>(
  CANONICAL_KBF_DOMAINS.map((entry) => [entry.key, entry]),
)

function slugifyDomain(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function computeCanonicalProbeId(domainKey: string, template: string): string {
  const digest = sha256Hex(canonicalJsonStringify(template)).slice(0, 12)
  return `llm:${slugifyDomain(domainKey)}:${digest}`
}

export function canonicalKbfDomain(key: string): CanonicalKbfDomain {
  const definition = DOMAINS_BY_KEY.get(key)
  if (!definition) throw new Error(`unknown canonical KBF domain ${key}`)
  return definition
}

export function canonicalKbfTolerance(domainKey: string): ProbeTolerance {
  return { ...canonicalKbfDomain(domainKey).tolerance }
}

export function createCanonicalKbfProbe(input: {
  domainKey: string
  name: string
  consensus: number
  generationRound: number
  generationTheme: string
}): KbfProbe {
  const definition = canonicalKbfDomain(input.domainKey)
  if (!Number.isFinite(input.consensus) || input.consensus < definition.range[0] || input.consensus > definition.range[1]) {
    throw new Error(`candidate consensus is outside ${input.domainKey} range`)
  }
  const template = definition.template.replace('{name}', input.name)
  return {
    id: computeCanonicalProbeId(input.domainKey, template),
    name: input.name,
    domain: input.domainKey,
    template,
    consensus: input.consensus,
    range: [...definition.range],
    tolerance: canonicalKbfTolerance(input.domainKey),
    canonicalDomainName: definition.name,
    generationRound: input.generationRound,
    generationTheme: input.generationTheme,
  }
}
