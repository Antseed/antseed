import type { ProviderField } from "../field.js";

/** [count:1|2] then [serviceLen:1][service:N][categoryCount:1][categoryLen:1][category:N]... */
export const serviceCategoriesField: ProviderField = {
  key: "serviceCategories",
  encode(writer, provider, ctx) {
    const entries = Object.entries(provider.serviceCategories ?? {})
      .map(([service, categories]) => [
        service,
        Array.from(new Set(
          categories.map((category) => category.trim().toLowerCase()).filter((category) => category.length > 0),
        )).sort(),
      ] as const)
      .filter(([, categories]) => categories.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    writer.serviceEntryCount(entries.length, ctx.wideServiceCounts);
    for (const [service, categories] of entries) {
      writer.utf8Wrapping(service);
      writer.u8(categories.length);
      for (const category of categories) writer.utf8Wrapping(category);
    }
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    if (count === 0) return;
    const serviceCategories: Record<string, string[]> = {};
    for (let i = 0; i < count; i += 1) {
      const service = reader.utf8();
      const categoryCount = reader.u8();
      const categories: string[] = [];
      for (let j = 0; j < categoryCount; j += 1) categories.push(reader.utf8());
      serviceCategories[service] = categories;
    }
    provider.serviceCategories = serviceCategories;
  },
};
