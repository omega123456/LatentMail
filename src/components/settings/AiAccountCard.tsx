import { ChevronDown } from 'lucide-react';
import { Avatar } from '@/components/shared/Avatar';
import type { AiConfig, AiIndexStatus } from '@/lib/types/ipc';
import { invoke } from '@/lib/ipc/commands';
import { SettingSwitch } from './GeneralSection';
import { AiConnectionSection } from './AiConnectionSection';
import { AiModelsSection } from './AiModelsSection';
import { AiIndexSection } from './AiIndexSection';

export function AiAccountCard({
  config,
  status,
  avatarUrl = null,
  expanded,
  onToggle,
  onChanged,
}: {
  config: AiConfig;
  status?: AiIndexStatus;
  avatarUrl?: string | null;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const state = config.enabled ? (config.embeddingModel ? 'Ready' : 'Setup') : 'Off';
  const pipClass = config.enabled
    ? config.embeddingModel
      ? 'bg-success dark:bg-dark-success'
      : 'bg-settings-amber dark:bg-dark-settings-amber'
    : 'bg-settings-outline dark:bg-dark-settings-outline';
  return (
    <article className="rounded-card border border-settings-card-line bg-settings-card px-4.5 py-4 dark:border-dark-settings-card-line dark:bg-dark-settings-card">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.75 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary"
        >
          <ChevronDown
            aria-hidden="true"
            size={16}
            className={`shrink-0 text-settings-ink-mute dark:text-dark-settings-ink-mute ${expanded ? '' : '-rotate-90'}`}
          />
          <Avatar size={30} src={avatarUrl} label={config.displayName} />
          <span className="min-w-0">
            <span className="block truncate text-body-sm font-semibold text-settings-ink dark:text-dark-settings-ink">
              {config.displayName}
            </span>
            <span className="block truncate text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
              {config.email}
            </span>
          </span>
        </button>
        <span className="inline-flex items-center gap-1.75 text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
          <span aria-hidden="true" className={`size-1.75 shrink-0 rounded-full ${pipClass}`} />
          {state}
        </span>
        <SettingSwitch
          checked={config.enabled}
          onChange={(enabled) => {
            void invoke('set_ai_enabled', { accountId: config.accountId, enabled }).then(onChanged);
          }}
          label={`Enable AI for ${config.email}`}
        />
      </div>
      {expanded && !config.enabled && (
        <p className="mt-3.5 text-settings-meta italic text-settings-ink-mute dark:text-dark-settings-ink-mute">
          Connection, models and index appear once this is on.
        </p>
      )}
      {expanded && config.enabled && (
        <div className="mt-4 flex flex-col gap-6 border-t border-settings-outline-variant pt-4.5 dark:border-dark-settings-outline-variant">
          <AiConnectionSection
            accountId={config.accountId}
            baseUrl={config.baseUrl}
            hasApiKey={config.hasApiKey}
            onChanged={onChanged}
          />
          <AiModelsSection
            accountId={config.accountId}
            accountEmail={config.email}
            chatModel={config.chatModel}
            embeddingModel={config.embeddingModel}
            embeddingDimensions={config.embeddingDimensions}
            indexStatus={status}
            onChanged={onChanged}
          />
          {config.embeddingModel && <AiIndexSection accountId={config.accountId} status={status} />}
        </div>
      )}
    </article>
  );
}
