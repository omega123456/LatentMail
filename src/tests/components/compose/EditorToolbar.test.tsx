import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditorToolbar } from '@/components/compose/EditorToolbar';

function fakeEditor(active: Set<string>) {
  const run = vi.fn();
  const chain = {
    focus: () => chain,
    toggleBold: () => chain,
    toggleItalic: () => chain,
    toggleUnderline: () => chain,
    toggleStrike: () => chain,
    toggleBulletList: () => chain,
    toggleOrderedList: () => chain,
    toggleCodeBlock: () => chain,
    deleteSelection: () => chain,
    insertContent: () => chain,
    run,
  };
  return {
    isActive: (name: string) => active.has(name),
    chain: () => chain,
    state: { selection: { from: 0, to: 0, empty: true }, doc: { textBetween: () => '' } },
  } as unknown as import('@tiptap/react').Editor;
}

describe('EditorToolbar', () => {
  const controls = [
    'Bold',
    'Italic',
    'Underline',
    'Strikethrough',
    'Bullet List',
    'Numbered List',
    'Code Block',
    'Link',
  ];

  it('renders every control as an icon button with both an accessible name and a title', () => {
    render(<EditorToolbar editor={fakeEditor(new Set())} onLink={() => {}} />);
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument();
    for (const label of controls) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toHaveAttribute('title', label);
      expect(button.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('reflects toggled state via aria-pressed, not colour alone', () => {
    render(
      <EditorToolbar editor={fakeEditor(new Set(['bold', 'bulletList']))} onLink={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Bullet List' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'false');
  });

  it.each([
    'Bold',
    'Italic',
    'Underline',
    'Strikethrough',
    'Bullet List',
    'Numbered List',
    'Code Block',
  ])(
    'runs the matching editor command for %s',
    async (label) => {
      const user = userEvent.setup();
      const editor = fakeEditor(new Set());
      render(<EditorToolbar editor={editor} onLink={() => {}} />);
      await user.click(screen.getByRole('button', { name: label }));
      expect(editor.chain().run).toHaveBeenCalled();
    },
  );

  it('invokes onLink for the Link control and is a no-op with no editor', async () => {
    const user = userEvent.setup();
    const onLink = vi.fn();
    render(<EditorToolbar editor={null} onLink={onLink} />);
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(onLink).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Bold' }));
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false');
  });
});
