import Markdown, { RuleType, type MarkdownToJSX } from 'markdown-to-jsx';
import { Fragment, type MouseEvent, type ReactNode } from 'react';
import { invoke } from '@/lib/ipc/commands';

const CITATION_PATTERN = /(\[\d+\])/;

const citationClassName =
  'align-super font-mono text-label-sm not-italic text-primary dark:text-dark-primary';

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const openInBrowser = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void invoke('open_external_url', { url: href ?? '' });
  };
  return (
    <a
      href={href}
      onClick={openInBrowser}
      className="text-primary underline dark:text-dark-primary"
    >
      {children}
    </a>
  );
}

function ImageAltText({ alt }: { alt?: string }) {
  return <span>{alt}</span>;
}

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
  a: { component: ExternalLink },
  img: { component: ImageAltText },
};

function renderWithCitations(text: string, key: string | number | undefined): ReactNode {
  const segments = text.split(CITATION_PATTERN);
  return (
    <Fragment key={key}>
      {segments.map((segment, index) =>
        CITATION_PATTERN.test(segment) ? (
          <cite key={index} className={citationClassName}>
            {segment}
          </cite>
        ) : (
          segment
        ),
      )}
    </Fragment>
  );
}

const renderRule: MarkdownToJSX.Options['renderRule'] = (next, node, _renderChildren, state) => {
  if (node.type !== RuleType.text) return next();
  if (!CITATION_PATTERN.test(node.text)) return next();
  return renderWithCitations(node.text, state.key);
};

const options: MarkdownToJSX.Options = {
  overrides: overrides,
  forceBlock: true,
  disableParsingRawHTML: true,
  renderRule: renderRule,
};

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="text-body-sm text-on-surface dark:text-dark-on-surface">
      <Markdown options={options}>{text}</Markdown>
    </div>
  );
}
