import Markdown from 'markdown-to-jsx';

const CITATION_PATTERN = /\[(\d+)\]/g;

const overrides = {
  p: { props: { className: 'mb-1.5 whitespace-pre-line last:mb-0' } },
  strong: { props: { className: 'font-semibold' } },
  ul: { props: { className: 'mb-1.5 list-disc pl-4 last:mb-0' } },
  ol: { props: { className: 'mb-1.5 list-decimal pl-4 last:mb-0' } },
  li: { props: { className: 'mb-0.5' } },
  code: {
    props: {
      className:
        'rounded-sm bg-surface-container px-1 font-mono text-label-sm dark:bg-dark-surface-container',
    },
  },
  pre: {
    props: {
      className:
        'mb-1.5 overflow-x-auto rounded-sm bg-surface-container p-2 last:mb-0 dark:bg-dark-surface-container',
    },
  },
  cite: {
    props: {
      className:
        'align-super font-mono text-label-sm not-italic text-primary dark:text-dark-primary',
    },
  },
};

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="text-body-sm text-on-surface dark:text-dark-on-surface">
      <Markdown options={{ overrides, forceBlock: true }}>
        {text.replace(CITATION_PATTERN, '<cite>[$1]</cite>')}
      </Markdown>
    </div>
  );
}
