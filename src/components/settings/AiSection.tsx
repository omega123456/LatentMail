import { useState } from 'react';
import { useAccountsQuery, useAiConfigsQuery, useAiIndexStatusesQuery } from '@/lib/query/hooks';
import type { AiConfig } from '@/lib/types/ipc';
import { SettingsSection } from './SettingsSection';
import { AiAccountCard } from './AiAccountCard';

type ExpansionState =
  { kind: 'auto' } | { kind: 'collapsed' } | { kind: 'account'; accountId: string };

const AUTO_EXPANSION: ExpansionState = { kind: 'auto' };
const COLLAPSED_EXPANSION: ExpansionState = { kind: 'collapsed' };

function defaultExpandedAccountId(configs: AiConfig[]): string | null {
  const enabled = configs.filter((config) => config.enabled);
  if (enabled.length === 1) return enabled[0]?.accountId ?? null;
  return enabled.find((config) => !config.baseUrl || !config.embeddingModel)?.accountId ?? null;
}

function resolveExpandedAccountId(expansion: ExpansionState, configs: AiConfig[]): string | null {
  if (expansion.kind === 'collapsed') return null;
  if (expansion.kind === 'account') return expansion.accountId;
  return defaultExpandedAccountId(configs);
}

function toggleExpansion(activeExpanded: string | null, accountId: string): ExpansionState {
  if (activeExpanded === accountId) return COLLAPSED_EXPANSION;
  return { kind: 'account', accountId: accountId };
}

export function AiSection() {
  const { data = [], isLoading, isError } = useAiConfigsQuery();
  const { data: statuses = [] } = useAiIndexStatusesQuery();
  const { data: accounts = [] } = useAccountsQuery();
  const [expansion, setExpansion] = useState<ExpansionState>(AUTO_EXPANSION);
  const activeExpanded = resolveExpandedAccountId(expansion, data);
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
            onToggle={() => setExpansion(toggleExpansion(activeExpanded, config.accountId))}
            onChanged={() => undefined}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
