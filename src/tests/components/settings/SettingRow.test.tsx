import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingRow } from '@/components/settings/SettingRow';

describe('SettingRow', () => {
  it('renders the label, description and control', () => {
    render(
      <SettingRow label="Theme" description="Follow the system or pick one.">
        <button type="button">Control</button>
      </SettingRow>,
    );

    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Follow the system or pick one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Control' })).toBeInTheDocument();
  });

  it('dims a disabled row while retaining its written reason', () => {
    render(
      <SettingRow label="Start minimized" description="Requires closing to the tray." disabled>
        <button type="button" disabled>
          Control
        </button>
      </SettingRow>,
    );

    expect(screen.getByText('Requires closing to the tray.')).toBeInTheDocument();
    expect(screen.getByText('Start minimized').closest('div')?.parentElement).toHaveClass(
      'opacity-45',
    );
    expect(screen.getByRole('button', { name: 'Control' })).toBeDisabled();
  });
});
