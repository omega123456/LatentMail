import { useId, useState } from 'react';
import { TextInput } from '@/components/shared/TextInput';
import { LABEL_COLOR_PALETTE, type LabelColorId } from '@/lib/labels/palette';

const RESERVED_LABEL_PREFIX = 'CATEGORY_';
const LABEL_NAME_MAX_LENGTH = 100;
const RESERVED_LABEL_NAMES = new Set([
  'INBOX',
  'SENT',
  'DRAFT',
  'TRASH',
  'SPAM',
  'STARRED',
  'UNREAD',
  'IMPORTANT',
  'CHAT',
]);

export function validateLabelName(
  name: string,
  existingNames: string[],
  excludeName?: string,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'label name cannot be empty';
  if (trimmed.length > LABEL_NAME_MAX_LENGTH) {
    return `label name must be ${LABEL_NAME_MAX_LENGTH} characters or fewer`;
  }
  if (/[\\*%]/.test(trimmed)) return 'label name cannot contain \\, *, or %';
  const upper = trimmed.toUpperCase();
  if (upper.startsWith(RESERVED_LABEL_PREFIX) || RESERVED_LABEL_NAMES.has(upper)) {
    return 'label name cannot start with a reserved system prefix';
  }
  const collides = existingNames.some(
    (existing) =>
      existing.toLowerCase() === trimmed.toLowerCase() &&
      existing.toLowerCase() !== (excludeName ?? '').toLowerCase(),
  );
  if (collides) return 'a label with this name already exists';
  return null;
}

function LabelColorRadioGroup({
  colorId,
  onChange,
}: {
  colorId: LabelColorId;
  onChange: (id: LabelColorId) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div role="radiogroup" aria-label="Label colour" className="flex flex-wrap gap-1">
        {LABEL_COLOR_PALETTE.map((swatch) => (
          <button
            key={swatch.id}
            type="button"
            role="radio"
            aria-checked={colorId === swatch.id}
            aria-label={swatch.name}
            onClick={() => onChange(swatch.id)}
            className={`size-6 cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-primary ${swatch.dotClass} ${colorId === swatch.id ? 'ring-2 ring-primary ring-offset-1 dark:ring-dark-primary' : ''}`}
          />
        ))}
      </div>
    </div>
  );
}

export type LabelFormProps = {
  mode: 'create' | 'rename';
  initialName?: string;
  initialColorId?: LabelColorId;
  existingNames: string[];
  onSubmit: (input: { name: string; colorId: LabelColorId }) => void;
  onCancel: () => void;
};

export function LabelForm(props: LabelFormProps) {
  const { initialName = '', initialColorId = LABEL_COLOR_PALETTE[0].id } = props;
  const [name, setName] = useState(initialName);
  const [colorId, setColorId] = useState<LabelColorId>(initialColorId);
  const [touched, setTouched] = useState(false);
  const excludeName = props.mode === 'rename' ? initialName : undefined;
  const error = touched ? validateLabelName(name, props.existingNames, excludeName) : null;
  const nameFieldId = useId();

  const submit = () => {
    setTouched(true);
    if (validateLabelName(name, props.existingNames, excludeName)) return;
    props.onSubmit({ name: name.trim(), colorId: colorId });
  };

  return (
    <form
      aria-label={props.mode === 'create' ? 'Create label' : 'Edit label'}
      className="flex flex-col gap-2 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-2 dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor={nameFieldId}>
        Label name
      </label>
      <TextInput
        id={nameFieldId}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => setTouched(true)}
        placeholder="Label name"
      />
      <LabelColorRadioGroup colorId={colorId} onChange={setColorId} />
      {error && (
        <p role="alert" className="text-label-sm text-error dark:text-dark-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="cursor-pointer rounded px-2 py-1 text-label-md text-secondary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="cursor-pointer rounded bg-primary px-3 py-1 text-label-md text-on-primary focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary"
        >
          {props.mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </form>
  );
}
