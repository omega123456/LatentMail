import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LabelForm, validateLabelName } from '@/components/sidebar/LabelForm';

describe('validateLabelName', () => {
  it('mirrors every rule LabelRepository::validate_name enforces on the Rust side', () => {
    expect(validateLabelName('  ', [])).toBe('label name cannot be empty');
    expect(validateLabelName('a'.repeat(101), [])).toBe(
      'label name must be 100 characters or fewer',
    );
    expect(validateLabelName('50% off', [])).toBe('label name cannot contain \\, *, or %');
    expect(validateLabelName('CATEGORY_Promo', [])).toBe(
      'label name cannot start with a reserved system prefix',
    );
    expect(validateLabelName('inbox', [])).toBe(
      'label name cannot start with a reserved system prefix',
    );
    expect(validateLabelName('Clients', ['Clients'])).toBe(
      'a label with this name already exists',
    );
    expect(validateLabelName('Clients', ['clients'])).toBe(
      'a label with this name already exists',
    );
    expect(validateLabelName('Clients', [])).toBeNull();
  });

  it('excludes the label being renamed from the uniqueness check', () => {
    expect(validateLabelName('Clients', ['Clients'], 'Clients')).toBeNull();
  });
});

describe('LabelForm', () => {
  it('shows a validation error and does not submit for a colliding name', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <LabelForm
        mode="create"
        existingNames={['Clients']}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await user.type(screen.getByPlaceholderText('Label name'), 'Clients');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'a label with this name already exists',
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the trimmed name with the selected colour', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <LabelForm mode="create" existingNames={[]} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    await user.type(screen.getByPlaceholderText('Label name'), '  Contracts  ');
    await user.click(screen.getByRole('radio', { name: 'Red' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Contracts', colorId: 'red' });
  });

  it('surfaces a submit-time error from the mutation itself', () => {
    render(
      <LabelForm
        mode="create"
        existingNames={[]}
        submitError="Network unavailable"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable');
  });
});
