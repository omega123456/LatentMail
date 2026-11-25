function selectionExtendsStart(range: Range, before: Range | null): boolean {
  if (before === null) return false;
  return (
    range.compareBoundaryPoints(Range.END_TO_END, before) === 0 ||
    range.compareBoundaryPoints(Range.START_TO_END, before) === 0
  );
}

function positionSelectionEnd({
  container,
  end,
  range,
  before,
}: {
  container: HTMLElement;
  end: HTMLDivElement;
  range: Range;
  before: Range | null;
}) {
  end.toggleAttribute('data-selecting', true);
  const extendsStart = selectionExtendsStart(range, before);
  const boundary = extendsStart ? range.startContainer : range.endContainer;
  const anchor = boundary.nodeType === Node.TEXT_NODE ? boundary.parentElement : boundary;
  if (anchor?.parentElement !== container) return;
  container.insertBefore(end, extendsStart ? anchor : anchor.nextSibling);
}

export function followSelection(container: HTMLElement): () => void {
  const end = document.createElement('div');
  end.className = 'absolute inset-x-0 top-full bottom-0 -z-1 select-none data-selecting:top-0';
  container.append(end);
  const controller = new AbortController();
  const { signal } = controller;
  let pointerDown = false;
  let previous: Range | null = null;
  const reset = () => {
    container.append(end);
    end.toggleAttribute('data-selecting', false);
  };
  const release = () => {
    pointerDown = false;
    reset();
  };
  container.addEventListener('mousedown', () => end.toggleAttribute('data-selecting', true), {
    signal,
  });
  document.addEventListener('pointerdown', () => (pointerDown = true), { signal });
  document.addEventListener('pointerup', release, { signal });
  window.addEventListener('blur', release, { signal });
  document.addEventListener('keyup', () => !pointerDown && reset(), { signal });
  document.addEventListener(
    'selectionchange',
    () => {
      const selection = document.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const before = previous;
      previous = range?.cloneRange() ?? null;
      if (!range?.intersectsNode(container)) return reset();
      positionSelectionEnd({ container, end, range, before });
    },
    { signal },
  );
  return () => controller.abort();
}
