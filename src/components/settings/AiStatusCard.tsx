import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

export type AiStatusTone = 'neutral' | 'success' | 'error';
export type AiStatusPip = 'idle' | 'success' | 'warn' | 'error' | 'busy';

const toneClass: Record<AiStatusTone, string> = {
  neutral:
    'border-settings-outline-variant bg-settings-container-low text-settings-ink dark:border-dark-settings-outline-variant dark:bg-dark-settings-container-low dark:text-dark-settings-ink',
  success:
    'border-settings-primary-container bg-settings-primary-container text-settings-ink dark:border-dark-settings-primary-container dark:bg-dark-settings-primary-container dark:text-dark-settings-ink',
  error:
    'border-settings-error-container bg-settings-error-container text-settings-on-error-container dark:border-dark-settings-error-container dark:bg-dark-settings-error-container dark:text-dark-settings-on-error-container',
};

const subClass: Record<AiStatusTone, string> = {
  neutral: 'text-settings-ink-mute dark:text-dark-settings-ink-mute',
  success: 'text-settings-ink-mute dark:text-dark-settings-ink-mute',
  error: 'opacity-85',
};

const pipClass: Record<AiStatusPip, string> = {
  idle: 'bg-settings-outline dark:bg-dark-settings-outline',
  success: 'bg-success dark:bg-dark-success',
  warn: 'bg-settings-amber dark:bg-dark-settings-amber',
  error: 'bg-settings-error dark:bg-dark-settings-error',
  busy: 'bg-settings-primary dark:bg-dark-settings-primary',
};

export function AiStatusCard({
  tone = 'neutral',
  pip,
  spinner,
  title,
  detail,
  action,
}: {
  tone?: AiStatusTone;
  pip: AiStatusPip;
  spinner?: boolean;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-control border px-3.75 py-3.25 ${toneClass[tone]}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-settings-desc font-semibold">
          {spinner ? (
            <Loader2
              aria-hidden="true"
              size={13}
              className="shrink-0 text-settings-ink-mute motion-safe:animate-spin dark:text-dark-settings-ink-mute"
            />
          ) : (
            <span
              aria-hidden="true"
              className={`size-1.75 shrink-0 rounded-full ${pipClass[pip]}`}
            />
          )}
          {title}
        </span>
        {detail && (
          <span className={`text-settings-meta tabular-nums ${subClass[tone]}`}>{detail}</span>
        )}
      </div>
      {action}
    </div>
  );
}
