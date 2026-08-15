import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TOASTS, useToastStore } from '@/stores/toast';

beforeEach(() => useToastStore.setState({ toasts: [] }));

describe('toast store', () => {
  it('queues notifications with their severity and dismisses one by id', () => {
    useToastStore.getState().showError('Failed');
    useToastStore.getState().showSuccess('Saved');
    const [failure, success] = useToastStore.getState().toasts;
    expect(failure).toMatchObject({ severity: 'error', message: 'Failed' });
    expect(success).toMatchObject({ severity: 'success', message: 'Saved' });
    expect(success!.id).not.toBe(failure!.id);

    useToastStore.getState().dismiss(failure!.id);
    expect(useToastStore.getState().toasts).toEqual([success]);
    useToastStore.getState().dismiss(success!.id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('drops the oldest toast once the visible cap is exceeded', () => {
    for (let index = 0; index <= MAX_VISIBLE_TOASTS; index += 1) {
      useToastStore.getState().showError(`Failure ${index}`);
    }
    expect(useToastStore.getState().toasts).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Failure 1',
      'Failure 2',
      'Failure 3',
    ]);
  });

  it('ignores a dismissal for a toast that is already gone', () => {
    useToastStore.getState().showSuccess('Saved');
    const [only] = useToastStore.getState().toasts;
    useToastStore.getState().dismiss(only!.id + 1);
    expect(useToastStore.getState().toasts).toEqual([only]);
  });
});
