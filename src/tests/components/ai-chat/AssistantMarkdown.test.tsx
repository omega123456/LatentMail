import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssistantMarkdown } from '@/components/ai-chat/AssistantMarkdown';

describe('AssistantMarkdown', () => {
  it('renders the supported constructs as elements rather than injected HTML', () => {
    const { container } = render(
      <AssistantMarkdown
        text={
          'The deadline is **22 August**.\n\n- one `token`\n- two\n\n1. first\n\n```\ncode fence\n```'
        }
      />,
    );
    expect(screen.getByText('22 August').tagName).toBe('STRONG');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
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
});
