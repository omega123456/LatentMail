import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

const COPIED_RESET_MS = 2000;

const baseClass =
  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-1 transition-opacity hover:bg-surface-container-low hover:text-on-surface focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-hover:opacity-100 dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface';

const restingClass = 'opacity-0 text-secondary dark:text-dark-secondary';

const copiedClass = 'opacity-100 text-primary dark:text-dark-primary';

export function CopyButton({
  value,
  label,
  confirmation,
}: {
  value: string;
  label: string;
  confirmation?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () =>
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={copy}
        className={`${baseClass} ${copied ? copiedClass : restingClass}`}
      >
        {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? (confirmation ?? `Copied ${value}`) : ''}
      </span>
    </>
  );
}
