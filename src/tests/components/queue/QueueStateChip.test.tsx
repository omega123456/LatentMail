import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueueStateChip } from '@/components/queue/QueueStateChip';

describe('QueueStateChip', () => {
  it('renders the pip and the label together so state never relies on colour alone', () => {
    render(<QueueStateChip pipClassName="bg-queue-failed" label="Failed" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
