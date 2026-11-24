export type KeyActionMap<Event extends { key: string; preventDefault: () => void }> = Record<
  string,
  (event: Event) => void
>;

export function dispatchKey<Event extends { key: string; preventDefault: () => void }>(
  event: Event,
  handlers: KeyActionMap<Event>,
): boolean {
  const handler = handlers[event.key];
  if (!handler) return false;
  event.preventDefault();
  handler(event);
  return true;
}
