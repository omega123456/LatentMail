export function closestOrThrow(element: Element, selector: string): Element {
  const ancestor = element.closest(selector);
  if (!ancestor) throw new Error(`expected an ancestor matching ${selector}`);
  return ancestor;
}
