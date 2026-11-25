import { ChevronDown } from 'lucide-react';
import { Avatar, AVATAR_SIZE } from '@/components/shared/Avatar';
import type { AiConfig, AiIndexStatus } from '@/lib/types/ipc';
import { invoke } from '@/lib/ipc/commands';
import { SettingSwitch } from './GeneralSection';
import { AiConnectionSection } from './AiConnectionSection';
import { AiModelsSection } from './AiModelsSection';
import { AiIndexSection } from './AiIndexSection';
import { ICON_SIZE } from '@/components/shared/icon-size';

type AccountAiState = 'off' | 'setup' | 'ready';

const ACCOUNT_AI_BADGE: Record<AccountAiState, { label: string; pipClass: string }> = {
  off: { label: 'Off', pipClass: 'bg-settings-outline dark:bg-dark-settings-outline' },
  setup: { label: 'Setup', pipClass: 'bg-settings-amber dark:bg-dark-settings-amber' },
  ready: { label: 'Ready', pipClass: 'bg-success dark:bg-dark-success' },
};

function accountAiState(config: AiConfig): AccountAiState {
  if (!config.enabled) return 'off';
  return config.embeddingModel ? 'ready' : 'setup';
}

function ExpandedAccountBody({
  config,
  status,
  onChanged,
}: {
  config: AiConfig;
  status?: AiIndexStatus;
  onChanged: () => void;
}) {
  if (!config.enabled) {
    return (
      <p className="mt-3.5 text-settings-meta italic text-settings-ink-mute dark:text-dark-settings-ink-mute">
        Connection, models and index appear once this is on.
      </p>
    );
  }
  return (
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
  );
}

type AiAccountCardProps = {
  config: AiConfig;
  status?: AiIndexStatus;
  avatarUrl?: string | null;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
};

export function AiAccountCard({
  config,
  status,
  avatarUrl = null,
  expanded,
  onToggle,
  onChanged,
}: AiAccountCardProps) {
  const badge = ACCOUNT_AI_BADGE[accountAiState(config)];
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
            size={ICON_SIZE.base}
            className={`shrink-0 text-settings-ink-mute dark:text-dark-settings-ink-mute ${expanded ? '' : '-rotate-90'}`}
          />
          <Avatar size={AVATAR_SIZE.sm} src={avatarUrl} label={config.displayName} />
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
          <span
            aria-hidden="true"
            className={`size-1.75 shrink-0 rounded-full ${badge.pipClass}`}
          />
          {badge.label}
        </span>
        <SettingSwitch
          checked={config.enabled}
          onChange={(enabled) => {
            void invoke('set_ai_enabled', { accountId: config.accountId, enabled: enabled }).then(
              onChanged,
            );
          }}
          label={`Enable AI for ${config.email}`}
        />
      </div>
      {expanded && <ExpandedAccountBody config={config} status={status} onChanged={onChanged} />}
    </article>
  );
}
