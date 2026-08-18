import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsSection } from '@/components/settings/SettingsSection';

describe('SettingsSection', () => {
  it('renders the heading, description, actions and content', () => {
    render(
      <SettingsSection
        title="General"
        description="Changes apply immediately."
        actions={<button type="button">Retry all failed</button>}
      >
        <p>Section content</p>
      </SettingsSection>,
    );

    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByText('Changes apply immediately.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry all failed' })).toBeInTheDocument();
    expect(screen.getByText('Section content')).toBeInTheDocument();
  });

  it('renders without a description', () => {
    render(
      <SettingsSection title="Accounts">
        <p>Empty state</p>
      </SettingsSection>,
    );

    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument();
    expect(screen.getByText('Empty state')).toBeInTheDocument();
  });
});
