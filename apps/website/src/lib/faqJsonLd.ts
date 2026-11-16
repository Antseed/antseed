/** Builds the schema.org FAQPage object for a page's FAQ list. Answers are
    authored as HTML strings for the Faq component, so tags are stripped. */
export function faqJsonLd(items: {q: string; a: string}[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(({q, a}) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: a.replace(/<[^>]*>/g, '').trim(),
      },
    })),
  };
}
