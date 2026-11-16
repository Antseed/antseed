/** Replace bigints with decimal strings so a view can be serialized or printed. */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)) as T;
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
