export function createDebouncedFlush<Item>(
  delayMs: number,
  onFlush: (items: ReadonlySet<Item>) => void,
) {
  const pending = new Set<Item>();
  let timer: number | undefined;

  const add = (item: Item) => {
    pending.add(item);
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      const batch = new Set(pending);
      pending.clear();
      timer = undefined;
      onFlush(batch);
    }, delayMs);
  };

  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    pending.clear();
  };

  return { add: add, cancel: cancel };
}

export function createDebouncedTrigger(delayMs: number, onTrigger: () => void) {
  let timer: number | undefined;

  const trigger = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      onTrigger();
    }, delayMs);
  };

  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };

  return { trigger: trigger, cancel: cancel };
}
