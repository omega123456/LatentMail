import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, type AvatarSize } from '@/components/shared/Avatar';

describe('Avatar', () => {
  it('renders the initial when given no image', () => {
    render(<Avatar size={32} label="Elena Rodriguez" />);
    expect(screen.getByText('E')).toBeInTheDocument();
  });

  it('renders "?" when given no identity at all', () => {
    render(<Avatar size={32} label={null} />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('renders the image on a plate with a ring when given a src, and hides the initial', () => {
    const { container } = render(
      <Avatar size={32} src="asset://localhost/logo.png" label="Northwind" />,
    );
    // `alt=""` gives the `<img>` a presentation role, not `img` — queried
    // directly rather than via `getByRole`.
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.src).toContain('logo.png');
    expect(screen.queryByText('N')).not.toBeInTheDocument();
    // The plate/ring classes are unconditional in both themes (D7) — no
    // `dark:` counterpart, so the plate stays light/white in dark theme too
    // (a dark-ink brand mark must stay legible against the near-black
    // dark-theme surfaces).
    expect(img.parentElement).toHaveClass('bg-surface-container-lowest');
    expect(img.parentElement).toHaveClass('ring-1', 'ring-outline-variant/40');
    expect(img.parentElement).not.toHaveClass('dark:bg-dark-surface-container-lowest');
    expect(img.parentElement).not.toHaveClass('dark:ring-dark-outline-variant/40');
  });

  it('falls back to the letter initial when the image fails to load', () => {
    const { container } = render(
      <Avatar size={32} src="asset://localhost/broken.png" label="Northwind" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(screen.queryByText('N')).not.toBeInTheDocument();
    fireEvent.error(img);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('N')).toBeInTheDocument();
  });

  it('carries the inset unread notch only when unread', () => {
    const { container, rerender } = render(<Avatar size={32} label="E" unread={false} />);
    expect(container.querySelector('.bg-primary.ring-2')).not.toBeInTheDocument();
    rerender(<Avatar size={32} label="E" unread />);
    expect(container.querySelector('.bg-primary.ring-2')).toBeInTheDocument();
  });

  it('is aria-hidden (decorative) by default, since a visible name usually sits beside it', () => {
    const { container } = render(<Avatar size={40} label="Elena" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('carries a real accessible name when given one, for the one surface where it is not decorative', () => {
    render(<Avatar size={36} label="A" ariaLabel="a@example.com" />);
    expect(screen.getByRole('img', { name: 'a@example.com' })).toBeInTheDocument();
  });

  it('adds no ring around the initial by default, but adds one when `ring` is set', () => {
    const { container: withoutRing } = render(<Avatar size={48} label="Elena" />);
    const initialWithoutRing = withoutRing.querySelector('span > span');
    expect(initialWithoutRing).not.toHaveClass('ring-2');

    const { container: withRing } = render(<Avatar size={48} label="Elena" ring />);
    const initialWithRing = withRing.querySelector('span > span');
    expect(initialWithRing).toHaveClass('ring-2');
    expect(initialWithRing).toHaveClass('ring-surface-container');
    expect(initialWithRing).toHaveClass('dark:ring-dark-surface-container');
  });

  it('defaults the unread notch ring to the plain surface color, and accepts an override for the row ground it actually sits on', () => {
    const { container: defaultNotch } = render(<Avatar size={32} label="E" unread />);
    expect(defaultNotch.querySelector('.bg-primary.ring-2')).toHaveClass('ring-surface');
    expect(defaultNotch.querySelector('.bg-primary.ring-2')).toHaveClass('dark:ring-dark-surface');

    const { container: overriddenNotch } = render(
      <Avatar
        size={32}
        label="E"
        unread
        notchRingClassName="ring-primary/10 dark:ring-dark-primary/10"
      />,
    );
    const notch = overriddenNotch.querySelector('.bg-primary.ring-2');
    expect(notch).toHaveClass('ring-primary/10');
    expect(notch).toHaveClass('dark:ring-dark-primary/10');
    expect(notch).not.toHaveClass('ring-surface');
  });

  it('applies the correct stock Tailwind size utility for every size', () => {
    const sizes = { 24: 'size-6', 32: 'size-8', 36: 'size-9', 40: 'size-10', 48: 'size-12' } as const;
    for (const [size, className] of Object.entries(sizes)) {
      const { container, unmount } = render(
        <Avatar size={Number(size) as AvatarSize} label="X" />,
      );
      expect(container.firstElementChild).toHaveClass(className);
      unmount();
    }
  });
});
