import { useState } from 'react';
import { useAccountsQuery, useAiConfigsQuery, useAiIndexStatusesQuery } from '@/lib/query/hooks';
import { SettingsSection } from './SettingsSection';
import { AiAccountCard } from './AiAccountCard';
export function AiSection() {
  const { data = [], isLoading, isError } = useAiConfigsQuery();
  const { data: statuses = [] } = useAiIndexStatusesQuery();
  const { data: accounts = [] } = useAccountsQuery();
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  const enabled = data.filter((config) => config.enabled);
  const defaultExpanded =
    enabled.length === 1
      ? enabled[0]?.accountId
      : enabled.find((config) => !config.baseUrl || !config.embeddingModel)?.accountId;
  const activeExpanded = expanded === undefined ? defaultExpanded : expanded;
  return (
    <SettingsSection title="AI" description="Configure AI independently for each Gmail account.">
      {isLoading && <p className="text-settings-desc">Loading AI accounts…</p>}
      {isError && (
        <p role="alert" className="text-settings-desc text-settings-error">
          Couldn&apos;t load AI accounts.
        </p>
      )}
      <div className="flex flex-col gap-3">
        {data.map((config) => (
          <AiAccountCard
            key={config.accountId}
            config={config}
            status={statuses.find((status) => status.accountId === config.accountId)}
            avatarUrl={
              accounts.find((account) => account.id === config.accountId)?.avatarUrl ?? null
            }
            expanded={activeExpanded === config.accountId}
            onToggle={() =>
              setExpanded(activeExpanded === config.accountId ? null : config.accountId)
            }
            onChanged={() => undefined}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
