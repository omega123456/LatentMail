import { useId, useRef, type KeyboardEvent } from 'react';
import { Popover } from 'radix-ui';
import { X } from 'lucide-react';
import { ContactSuggestions } from './ContactSuggestions';
import { TextInput } from '@/components/shared/TextInput';
import { type RecipientRole, useComposeStore } from '@/stores/compose';
import type { ContactSuggestion } from '@/lib/types/ipc';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { POPOVER_SIDE_OFFSET_PX } from '@/components/shared/floating-offsets';
import { formatCount } from '@/lib/format/strings';
import { chipLabel, useRecipientFieldController, useRecipientOverflow } from './useRecipientField';

function HiddenRecipientsButton({
  hiddenCount,
  onExpand,
}: {
  hiddenCount: number;
  onExpand: () => void;
}) {
  if (hiddenCount <= 0) return null;
  const label = `${formatCount(hiddenCount, 'more recipient')} hidden`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onExpand}
      className="cursor-pointer rounded-sm px-1.5 py-0.5 text-label-md text-primary hover:bg-surface-container-high dark:text-dark-primary dark:hover:bg-dark-surface-container-high"
    >
      +{hiddenCount} more
    </button>
  );
}

function RecipientChips({
  chips,
  visibleCount,
  hiddenCount,
  onRemove,
  onExpand,
}: {
  chips: string[];
  visibleCount: number;
  hiddenCount: number;
  onRemove: (index: number) => void;
  onExpand: () => void;
}) {
  return (
    <>
      {chips.slice(0, visibleCount).map((chip, index) => (
        <span
          key={`${chip}-${index}`}
          className="inline-flex items-center gap-1 rounded-full bg-surface-container-high py-0.5 pl-2 pr-1 text-snippet text-on-surface dark:bg-dark-surface-container-high dark:text-dark-on-surface"
        >
          {chipLabel(chip)}
          <button
            type="button"
            aria-label={`Remove ${chipLabel(chip)}`}
            title={`Remove ${chipLabel(chip)}`}
            onClick={() => onRemove(index)}
            className="cursor-pointer rounded-full text-secondary hover:bg-surface-container-highest hover:text-on-surface dark:text-dark-secondary dark:hover:bg-dark-surface-container-highest dark:hover:text-dark-on-surface"
          >
            <X aria-hidden="true" size={ICON_SIZE.xxs} />
          </button>
        </span>
      ))}
      <HiddenRecipientsButton hiddenCount={hiddenCount} onExpand={onExpand} />
    </>
  );
}

function RecipientSuggestionsPopover({
  listboxId,
  suggestions,
  activeIndex,
  onSelect,
}: {
  listboxId: string;
  suggestions: ContactSuggestion[];
  activeIndex: number;
  onSelect: (item: ContactSuggestion) => void;
}) {
  return (
    <Popover.Portal>
      <Popover.Content
        align="start"
        sideOffset={POPOVER_SIDE_OFFSET_PX}
        onOpenAutoFocus={(event) => event.preventDefault()}
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        className="z-50 max-h-64 overflow-auto rounded-md border border-outline-variant bg-surface-container-lowest p-1 shadow-lg dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
      >
        <ContactSuggestions
          id={listboxId}
          items={suggestions}
          activeIndex={activeIndex}
          onSelect={onSelect}
        />
      </Popover.Content>
    </Popover.Portal>
  );
}

function RecipientComboboxInput({
  inputRef,
  value,
  placeholder,
  open,
  listboxId,
  activeOptionId,
  onChange,
  onKeyDown,
  onBlur,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  value: string;
  placeholder?: string;
  open: boolean;
  listboxId: string;
  activeOptionId?: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}) {
  return (
    <TextInput
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={activeOptionId}
      aria-labelledby={`${listboxId}-label`}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      variant="bare"
      className="min-w-24 flex-1 text-body-md text-on-surface placeholder:text-outline dark:text-dark-on-surface dark:placeholder:text-dark-outline"
    />
  );
}

type RecipientFieldProps = {
  fieldRole: RecipientRole;
  label: string;
  accountId: string | null;
  placeholder: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

export function RecipientField(props: RecipientFieldProps) {
  const { fieldRole, label, accountId, placeholder, inputRef } = props;
  const session = useComposeStore((compose) => compose.session);
  const removeRecipient = useComposeStore((compose) => compose.removeRecipient);
  const chips = session?.recipients[fieldRole] ?? [];
  const chipListRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const overflow = useRecipientOverflow(chipListRef, fieldRole, chips.length);
  const controller = useRecipientFieldController(fieldRole, accountId);
  const activeOptionId =
    controller.open && controller.activeIndex >= 0
      ? `${listboxId}-option-${controller.activeIndex}`
      : undefined;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span
        id={`${listboxId}-label`}
        className="w-13 shrink-0 text-label-md text-secondary dark:text-dark-secondary"
      >
        {label}
      </span>
      <Popover.Root open={controller.open}>
        <Popover.Anchor asChild>
          <div className="flex min-w-0 flex-1 flex-col">
            <div ref={chipListRef} className="flex flex-wrap items-center gap-1">
              <RecipientChips
                chips={chips}
                visibleCount={overflow.visibleCount}
                hiddenCount={overflow.hiddenCount}
                onRemove={(index) => removeRecipient(fieldRole, index)}
                onExpand={overflow.expandAll}
              />
              <RecipientComboboxInput
                inputRef={inputRef}
                value={controller.inputValue}
                placeholder={chips.length === 0 ? placeholder : undefined}
                open={controller.open}
                listboxId={listboxId}
                activeOptionId={activeOptionId}
                onChange={controller.handleInputChange}
                onKeyDown={controller.handleKeyDown}
                onBlur={controller.commit}
              />
            </div>
          </div>
        </Popover.Anchor>
        <RecipientSuggestionsPopover
          listboxId={listboxId}
          suggestions={controller.suggestions}
          activeIndex={controller.activeIndex}
          onSelect={controller.selectSuggestion}
        />
      </Popover.Root>
    </div>
  );
}
