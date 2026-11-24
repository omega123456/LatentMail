export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function wrapIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

export function toggleInSet<Item>(set: ReadonlySet<Item>, item: Item): Set<Item> {
  const next = new Set(set);
  if (next.has(item)) {
    next.delete(item);
    return next;
  }
  next.add(item);
  return next;
}

export function intersectAll<Item>(lists: ReadonlyArray<ReadonlyArray<Item>>): Item[] {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists;
  const restSets = rest.map((list) => new Set(list));
  return [...new Set(first)].filter((item) => restSets.every((set) => set.has(item)));
}
