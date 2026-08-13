import { Collapsible } from 'radix-ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { BodyFrame } from '@/components/reader/BodyFrame';

/** The collapsed-by-default quoted original. Renders through the existing
 * `BodyFrame` — the reader's dual-sanitized, script-free
 * `sandbox="allow-same-origin"` iframe — so untrusted HTML never enters the
 * editable compose document by any other path (D2). Genuinely non-editable
 * and announced as read-only quoted content, not merely styled inert. */
export function QuoteDisclosure({
  html,
  attribution,
  open,
  onOpenChange,
}: {
  html: string;
  attribution: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} data-testid="quote-disclosure">
      <Collapsible.Trigger
        type="button"
        aria-label={open ? 'Hide quoted text' : 'Show quoted text'}
        title={open ? 'Hide quoted text' : 'Show quoted text'}
        className="inline-flex items-center gap-1 rounded-full border border-outline-variant bg-surface-container-low px-3 py-1 text-label-md text-secondary hover:text-on-surface dark:border-dark-outline-variant dark:bg-dark-surface-container-low dark:text-dark-secondary dark:hover:text-dark-on-surface"
      >
        {open ? (
          <ChevronUp aria-hidden="true" size={14} />
        ) : (
          <ChevronDown aria-hidden="true" size={14} />
        )}
        {open ? 'Hide quoted text' : 'Show quoted text'}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div
          role="region"
          aria-label="Quoted content, read-only"
          className="mt-stack-gap-sm border-l-2 border-outline-variant pl-stack-gap-md dark:border-dark-outline-variant"
        >
          <p className="text-label-md text-outline dark:text-dark-outline">{attribution}</p>
          <BodyFrame html={html} text={null} />
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
