import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { TextArea } from '@/components/shared/TextArea';

describe('TextArea', () => {
  it('keeps the browser-default policy of the shared text input', () => {
    render(<TextArea aria-label="Notes" />);
    const field = screen.getByLabelText('Notes');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('autocorrect', 'off');
    expect(field).toHaveAttribute('autocapitalize', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).toHaveClass('rounded-control');
  });

  it('lets a caller override the defaults because its props spread last', () => {
    render(<TextArea aria-label="Notes" spellCheck rows={4} />);
    const field = screen.getByLabelText('Notes');
    expect(field).toHaveAttribute('spellcheck', 'true');
    expect(field).toHaveAttribute('rows', '4');
  });

  it('appends a caller class to the variant class and forwards its ref', async () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <TextArea aria-label="Notes" variant="bare" className="min-h-ai-prompt-min" ref={ref} />,
    );
    const field = screen.getByLabelText('Notes');
    expect(field).toHaveClass('bg-transparent', 'min-h-ai-prompt-min');
    expect(ref.current).toBe(field);
    await userEvent.type(field, 'typed');
    expect(field).toHaveValue('typed');
  });
});
