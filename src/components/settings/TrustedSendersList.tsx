import { useState } from 'react';
import { ImageOff, Info, Mail, Search, Trash2 } from 'lucide-react';
import { Select } from '@/components/shared/Select';
import { useLayoutStore } from '@/stores/layout';
import { settingsDangerIconButton, settingsLinkPrimary, settingsTriggerClass } from './styles';

const rowsPerPageOptions = ['5', '10', '25'];

const cardLine = 'border-settings-card-line dark:border-dark-settings-card-line';

const blockedGlyphClass =
  'grid size-5.5 shrink-0 place-items-center rounded-chip bg-settings-tint-block text-settings-blocked dark:bg-dark-settings-tint-block dark:text-dark-settings-blocked';

const emptyStateClass = `flex flex-col items-center gap-1.5 border-b ${cardLine} px-6 py-8.5 text-center text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute`;

const emptyLeadClass = 'text-body-sm font-medium text-settings-ink dark:text-dark-settings-ink';

const pageButtonClass =
  'cursor-pointer rounded-chip px-1.75 py-1 text-settings-meta font-semibold tabular-nums text-settings-ink-mute hover:bg-settings-container-low hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary disabled:cursor-not-allowed disabled:opacity-35 aria-[current=true]:bg-settings-container aria-[current=true]:text-settings-on-primary-container dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container-low dark:hover:text-dark-settings-ink dark:aria-[current=true]:bg-dark-settings-container dark:aria-[current=true]:text-dark-settings-on-primary-container';

function HighlightedAddress({ address, needle }: { address: string; needle: string }) {
  const index = needle ? address.indexOf(needle) : -1;
  if (index < 0) return <>{address}</>;
  return (
    <>
      {address.slice(0, index)}
      <mark className="rounded-sm bg-settings-primary-container px-px text-settings-on-primary-container dark:bg-dark-settings-primary-container dark:text-dark-settings-on-primary-container">
        {address.slice(index, index + needle.length)}
      </mark>
      {address.slice(index + needle.length)}
    </>
  );
}

export function TrustedSendersList() {
  const alwaysLoad = useLayoutStore((state) => state.alwaysLoadRemoteImages);
  const senders = useLayoutStore((state) => state.allowedImageSenders);
  const untrustImageSender = useLayoutStore((state) => state.untrustImageSender);
  const [filter, setFilter] = useState('');
  const [rowsPerPage, setRowsPerPage] = useState('10');
  const [requestedPage, setRequestedPage] = useState(1);

  const needle = filter.trim().toLowerCase();
  const sorted = [...senders].sort();
  const matches = needle ? sorted.filter((address) => address.includes(needle)) : sorted;
  const perPage = Number(rowsPerPage);
  const pageCount = Math.max(1, Math.ceil(matches.length / perPage));
  const page = requestedPage > pageCount ? 1 : requestedPage;
  const start = (page - 1) * perPage;
  const visible = matches.slice(start, start + perPage);

  return (
    <div className="flex flex-col" data-testid="settings-trusted-senders">
      <div
        inert={alwaysLoad}
        aria-disabled={alwaysLoad}
        className={`flex flex-col gap-3 ${alwaysLoad ? 'opacity-42' : ''}`}
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body-sm font-medium text-settings-ink dark:text-dark-settings-ink">
              Trusted senders
            </span>
            <span className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
              Their images load automatically. Spam is always blocked.
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <label className="flex h-8.5 w-52.5 items-center gap-1.75 rounded-control border border-transparent bg-settings-container-low px-2.5 text-settings-ink-mute focus-within:border-settings-primary dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute dark:focus-within:border-dark-settings-primary">
              <Search aria-hidden="true" size={14} className="shrink-0" />
              <input
                type="search"
                value={filter}
                aria-label="Filter trusted senders"
                placeholder="Filter senders"
                onChange={(event) => {
                  setFilter(event.target.value);
                  setRequestedPage(1);
                }}
                className="w-full select-text bg-transparent text-settings-desc text-settings-ink outline-none placeholder:text-settings-ink-mute dark:text-dark-settings-ink dark:placeholder:text-dark-settings-ink-mute"
              />
            </label>
            <Select
              ariaLabel="Rows per page"
              value={rowsPerPage}
              onChange={(next) => {
                setRowsPerPage(next);
                setRequestedPage(1);
              }}
              options={rowsPerPageOptions.map((rows) => ({ value: rows, label: `${rows} rows` }))}
              className={settingsTriggerClass}
            />
          </div>
        </div>
        <div className={`flex flex-col border-t ${cardLine}`}>
          {senders.length === 0 ? (
            <div className={emptyStateClass}>
              <ImageOff
                aria-hidden="true"
                size={20}
                className="mb-0.5 text-settings-blocked dark:text-dark-settings-blocked"
              />
              <span className={emptyLeadClass}>No trusted senders yet</span>
              <span>Choose Always allow from sender on a blocked message to add one.</span>
            </div>
          ) : matches.length === 0 ? (
            <div className={emptyStateClass}>
              <span className={emptyLeadClass}>No senders match “{filter.trim()}”</span>
              <button
                type="button"
                onClick={() => {
                  setFilter('');
                  setRequestedPage(1);
                }}
                className={settingsLinkPrimary}
              >
                Clear filter
              </button>
            </div>
          ) : (
            visible.map((address) => (
              <div
                key={address}
                className={`group flex items-center gap-2.5 rounded-b border-b ${cardLine} py-2.25 pl-3 pr-2 hover:bg-settings-container-low dark:hover:bg-dark-settings-container-low`}
              >
                <span className={blockedGlyphClass}>
                  <Mail aria-hidden="true" size={12} />
                </span>
                <span className="min-w-0 flex-1 truncate text-body-sm text-settings-ink dark:text-dark-settings-ink">
                  <HighlightedAddress address={address} needle={needle} />
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${address}`}
                  onClick={() => untrustImageSender(address)}
                  className={`${settingsDangerIconButton} opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
                >
                  <Trash2 aria-hidden="true" size={13} />
                </button>
              </div>
            ))
          )}
        </div>
        {matches.length > 0 && (
          <div className="flex items-center justify-between gap-3 pt-2.5 text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
            <span>
              {start + 1}–{Math.min(start + perPage, matches.length)} of {matches.length}
            </span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                disabled={page === 1}
                onClick={() => setRequestedPage(page - 1)}
                className={pageButtonClass}
              >
                Prev
              </button>
              {Array.from({ length: pageCount }, (_unused, index) => (
                <button
                  key={index + 1}
                  type="button"
                  aria-current={page === index + 1}
                  onClick={() => setRequestedPage(index + 1)}
                  className={pageButtonClass}
                >
                  {index + 1}
                </button>
              ))}
              <button
                type="button"
                disabled={page === pageCount}
                onClick={() => setRequestedPage(page + 1)}
                className={pageButtonClass}
              >
                Next
              </button>
            </span>
          </div>
        )}
      </div>
      {alwaysLoad && (
        <p className="mt-3 flex items-start gap-2 rounded-control bg-settings-container-low px-3 py-2.5 text-settings-desc text-settings-ink-mute dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute">
          <Info
            aria-hidden="true"
            size={15}
            className="mt-0.5 shrink-0 text-settings-blocked dark:text-dark-settings-blocked"
          />
          <span>
            Every sender is trusted while Always load remote images is on. Your list is kept and
            applies again the moment you turn it off.
          </span>
        </p>
      )}
    </div>
  );
}
