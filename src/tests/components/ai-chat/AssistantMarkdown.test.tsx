import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AssistantMarkdown } from '@/components/ai-chat/AssistantMarkdown';
import { ipc } from '@/tests/ipc-mock';

const LIST_ITEM_COUNT = 2;

it('renders the supported constructs as elements rather than injected HTML', () => {
  const { container } = render(
    <AssistantMarkdown
      text={
        'The deadline is **22 August**.\n\n- one `token`\n- two\n\n1. first\n\n```\ncode fence\n```'
      }
    />,
  );
  expect(screen.getByText('22 August').tagName).toBe('STRONG');
  expect(container.querySelectorAll('ul li')).toHaveLength(LIST_ITEM_COUNT);
  expect(container.querySelector('ol li')).toHaveTextContent('first');
  expect(screen.getByText('token').tagName).toBe('CODE');
  expect(container.querySelector('pre')).toHaveTextContent('code fence');
});

it('keeps a line break inside a paragraph on its own line', () => {
  const { container } = render(<AssistantMarkdown text={'line one\nline two'} />);
  const paragraph = container.querySelector('p');
  expect(paragraph).toHaveClass('whitespace-pre-line');
  expect(paragraph?.textContent).toBe('line one\nline two');
});

it('marks citation markers as distinct inline text', () => {
  const { container } = render(<AssistantMarkdown text="Priya owns it [2]." />);
  const citation = container.querySelector('cite');
  expect(citation).toHaveTextContent('[2]');
  expect(citation).toHaveClass('align-super', 'text-primary');
});

it('renders a script tag from the model as inert text, never as a script element', () => {
  const { container } = render(<AssistantMarkdown text={'<script>window.stolen = 1</script>'} />);
  expect(container.querySelector('script')).toBeNull();
});

it('survives an unterminated code fence arriving mid-stream', () => {
  const { container } = render(<AssistantMarkdown text={'Here is the start\n\n```\nhalf'} />);
  expect(container).toHaveTextContent('half');
});

it('never renders an image from the answer, showing its alt text instead', () => {
  const { container } = render(
    <AssistantMarkdown
      text={
        'Look ![tracking pixel](https://tracker.example/p.gif) and <img src="https://tracker.example/q.gif" alt="raw">'
      }
    />,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container).toHaveTextContent('tracking pixel');
});

it('renders raw HTML from the answer as inert text', () => {
  const { container } = render(
    <AssistantMarkdown
      text={'<b onclick="steal()">bold</b> <iframe src="https://x.example"></iframe>'}
    />,
  );
  expect(container.querySelector('b')).toBeNull();
  expect(container.querySelector('iframe')).toBeNull();
  expect(container).toHaveTextContent('<b onclick="steal()">bold</b>');
});

it('opens a link from the answer in the system browser instead of navigating the app', async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  ipc.override('open_external_url', opened);
  render(<AssistantMarkdown text={'See [the policy](https://example.com/policy).'} />);
  await user.click(screen.getByRole('link', { name: 'the policy' }));
  expect(opened).toHaveBeenCalledWith({ url: 'https://example.com/policy' });
});
