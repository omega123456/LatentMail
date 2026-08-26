export const ASSISTANT_EXAMPLES = [
  "Summarize last week's important emails",
  'Find emails about budget or finance',
  'Who emailed me most recently?',
];

const exampleClass =
  'cursor-pointer rounded-control border border-outline-variant bg-surface-container-low px-2.5 py-2 text-left text-body-sm hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:bg-dark-surface-container-low dark:hover:bg-dark-surface-container';

export function AssistantEmptyState({ onSelect }: { onSelect: (question: string) => void }) {
  return (
    <div className="grid gap-2">
      <span className="text-title-lg">Ask about your inbox</span>
      <span className="text-label-md font-normal text-on-surface-variant dark:text-dark-on-surface-variant">
        Answers come from the mail already indexed on this device.
      </span>
      <div className="mt-1 grid gap-1.5">
        {ASSISTANT_EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onSelect(example)}
            className={exampleClass}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
