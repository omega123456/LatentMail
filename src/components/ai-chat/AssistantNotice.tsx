export type AssistantUnavailableCause =
  'disabled' | 'noApiRoot' | 'noChatModel' | 'needsRebuild' | 'indexNotReady' | 'unreachable';

const actionLabel: Record<AssistantUnavailableCause, string> = {
  disabled: 'Open AI settings',
  noApiRoot: 'Open AI settings',
  noChatModel: 'Open AI settings',
  needsRebuild: 'Rebuild the index',
  indexNotReady: 'Open AI settings',
  unreachable: 'Test the connection',
};

const title: Record<AssistantUnavailableCause, string> = {
  disabled: 'AI is turned off for this account',
  noApiRoot: 'No API root saved',
  noChatModel: 'No chat model selected',
  needsRebuild: 'The index must be rebuilt',
  indexNotReady: 'The index is still building',
  unreachable: 'Cannot reach the provider',
};

function endpointHost(endpoint: string | null) {
  if (endpoint === null) return 'the provider';
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function description({
  cause,
  accountEmail,
  indexed,
  total,
  endpoint,
}: {
  cause: AssistantUnavailableCause;
  accountEmail: string;
  indexed: number;
  total: number;
  endpoint: string | null;
}) {
  switch (cause) {
    case 'disabled':
      return `Turn it on for ${accountEmail} to ask questions about this mailbox.`;
    case 'noApiRoot':
      return 'Save the address of an OpenAI-compatible endpoint for this account.';
    case 'noChatModel':
      return 'Choose a chat model for this account before asking a question.';
    case 'needsRebuild':
      return "This index was built with the previous distance measure. Rebuilding re-embeds this account's mail.";
    case 'indexNotReady':
      return `${indexed.toLocaleString()} of ${total.toLocaleString()} messages are indexed. You can ask once it reaches partial.`;
    case 'unreachable':
      return `The last check to ${endpointHost(endpoint)} failed. Answers are unavailable until it responds.`;
  }
}

export function AssistantNotice({
  cause,
  accountEmail,
  indexed,
  total,
  endpoint,
  onAction,
}: {
  cause: AssistantUnavailableCause;
  accountEmail: string;
  indexed: number;
  total: number;
  endpoint: string | null;
  onAction: (cause: AssistantUnavailableCause) => void;
}) {
  return (
    <div className="relative grid gap-1 overflow-hidden rounded-control border border-outline-variant bg-surface-container-low px-3 py-2.5 dark:border-dark-outline-variant dark:bg-dark-surface-container-low">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-accent-border ${
          cause === 'unreachable'
            ? 'bg-error dark:bg-dark-error'
            : 'bg-primary dark:bg-dark-primary'
        }`}
      />
      <span className="text-body-sm font-semibold">{title[cause]}</span>
      <span className="text-label-md font-normal text-on-surface-variant dark:text-dark-on-surface-variant">
        {description({ cause, accountEmail, indexed, total, endpoint })}
      </span>
      <button
        type="button"
        onClick={() => onAction(cause)}
        className="cursor-pointer justify-self-start text-label-md font-semibold text-primary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-primary"
      >
        {actionLabel[cause]}
      </button>
    </div>
  );
}
