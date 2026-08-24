import { Check } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { RadioGroup } from 'radix-ui';
import { TextInput } from '@/components/shared/TextInput';
import type { AiModel } from '@/lib/types/ipc';
import { settingsLinkPrimary } from './styles';

const COLLAPSE_ABOVE = 30;

export function ModelCardList({
  accountEmail,
  label,
  models,
  selectedId,
  selectedDimension,
  confirmAfterId,
  confirm,
  onChange,
}: {
  accountEmail: string;
  label: string;
  models: AiModel[];
  selectedId: string | null;
  selectedDimension?: number | null;
  confirmAfterId?: string | null;
  confirm?: ReactNode;
  onChange: (id: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(models.length <= COLLAPSE_ABOVE);
  const visible = useMemo(
    () => models.filter((model) => model.id.toLowerCase().includes(filter.toLowerCase())),
    [filter, models],
  );
  const selected = models.find((model) => model.id === selectedId) ?? null;
  const collapsed = !expanded && !filter;
  const listed = collapsed ? (selected ? [selected] : []) : visible;
  const confirmIndex = confirm ? listed.findIndex((model) => model.id === confirmAfterId) : -1;

  return (
    <div className="flex flex-col gap-2.25">
      <div className="flex items-center gap-2.5">
        <TextInput
          aria-label={`Filter ${label} models for ${accountEmail}`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={
            collapsed ? `Filter ${models.length.toLocaleString()} models…` : 'Filter models…'
          }
          className="min-w-0 flex-1"
        />
        {collapsed && models.length > COLLAPSE_ABOVE ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={`shrink-0 ${settingsLinkPrimary}`}
          >
            Show all
          </button>
        ) : (
          <span className="shrink-0 text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
            {filter
              ? `${visible.length.toLocaleString()} of ${models.length.toLocaleString()}`
              : `${models.length.toLocaleString()} ${models.length === 1 ? 'model' : 'models'}`}
          </span>
        )}
      </div>
      <RadioGroup.Root
        aria-label={`${label} model for ${accountEmail}`}
        value={selectedId ?? ''}
        onValueChange={onChange}
        className="grid max-h-52 gap-1.75 overflow-y-auto pr-0.75"
      >
        {listed.map((model, index) => {
          const selectedModel = model.id === selectedId;
          const detail =
            selectedModel && collapsed
              ? 'Currently selected'
              : selectedModel && selectedDimension
                ? `${model.ownedBy ?? 'Unknown owner'} · ${selectedDimension.toLocaleString()} dimensions`
                : (model.ownedBy ?? 'Unknown owner');
          return (
            <Fragment key={model.id}>
              <RadioGroup.Item
                value={model.id}
                className={`cursor-pointer rounded-control border px-3.25 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary ${
                  selectedModel
                    ? 'border-settings-primary bg-settings-primary-container text-settings-on-primary-container dark:border-dark-settings-primary dark:bg-dark-settings-primary-container dark:text-dark-settings-on-primary-container'
                    : 'border-settings-outline-variant bg-settings-card text-settings-ink dark:border-dark-settings-outline-variant dark:bg-dark-settings-card dark:text-dark-settings-ink'
                }`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-settings-desc font-semibold">
                    {model.id}
                  </span>
                  {selectedModel && (
                    <Check
                      aria-label="Selected"
                      size={15}
                      className="shrink-0 text-settings-primary dark:text-dark-settings-primary"
                    />
                  )}
                </span>
                <span
                  className={`mt-0.25 block truncate text-settings-meta ${
                    selectedModel
                      ? 'opacity-80'
                      : 'text-settings-ink-mute dark:text-dark-settings-ink-mute'
                  }`}
                >
                  {detail}
                </span>
              </RadioGroup.Item>
              {index === confirmIndex && confirm}
            </Fragment>
          );
        })}
        {confirm && confirmIndex === -1 && confirm}
      </RadioGroup.Root>
      {collapsed && models.length > COLLAPSE_ABOVE && (
        <p className="text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
          {models.length.toLocaleString()} models available. Type to narrow the list.
        </p>
      )}
    </div>
  );
}
