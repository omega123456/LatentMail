import { useState, type ReactNode } from 'react';
import { ContextMenu } from 'radix-ui';
import { Copy, Link2 } from 'lucide-react';
import { itemClass, menuContentClass } from '@/components/actions/RowContextMenu';

type ReaderTarget = { href: string; selection: string };

function readTarget(node: EventTarget | null): ReaderTarget {
  const element = node instanceof Element ? node : null;
  const frame = element?.closest('iframe') ?? null;
  const source = frame?.contentDocument ?? document;
  return {
    href: frame?.dataset.contextHref || element?.closest('a[href]')?.getAttribute('href') || '',
    selection: (source.getSelection()?.toString() ?? '').trim(),
  };
}

export function ReaderContextMenu({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ReaderTarget | null>(null);
  const copy = (value: string) => void navigator.clipboard.writeText(value);
  return (
    <ContextMenu.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      <ContextMenu.Trigger
        asChild
        onContextMenu={(event) => {
          const next = readTarget(event.target);
          if (next.href || next.selection) setTarget(next);
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass} collisionPadding={8}>
          {target?.selection ? (
            <ContextMenu.Item className={itemClass} onSelect={() => copy(target.selection)}>
              <Copy aria-hidden="true" size={16} />
              Copy
            </ContextMenu.Item>
          ) : null}
          {target?.href ? (
            <ContextMenu.Item className={itemClass} onSelect={() => copy(target.href)}>
              <Link2 aria-hidden="true" size={16} />
              Copy link address
            </ContextMenu.Item>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
