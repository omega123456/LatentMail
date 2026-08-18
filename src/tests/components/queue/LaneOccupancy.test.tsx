import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LaneOccupancy } from '@/components/queue/LaneOccupancy';

describe('LaneOccupancy', () => {
  it('renders one dot per capacity slot', () => {
    render(<LaneOccupancy capacity={4} active={2} muted={false} />);
    expect(screen.getAllByTestId('lane-slot')).toHaveLength(4);
  });

  it('fills exactly the active count of dots', () => {
    render(<LaneOccupancy capacity={2} active={1} muted={false} />);
    const dots = screen.getAllByTestId('lane-slot');
    expect(dots[0].className).toContain('bg-settings-primary');
    expect(dots[1].className).toContain('bg-settings-outline-variant');
  });

  it('mutes the empty slots for an idle lane', () => {
    render(<LaneOccupancy capacity={2} active={1} muted />);
    const dots = screen.getAllByTestId('lane-slot');
    expect(dots[0].className).toContain('bg-settings-primary');
    expect(dots[1].className).toContain('bg-settings-card-line');
  });
});
