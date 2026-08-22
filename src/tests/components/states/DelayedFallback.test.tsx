import { act, render, screen } from '@testing-library/react';
import { Suspense, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelayedFallback, lazyWithDelayedFallback } from '@/components/states/DelayedFallback';

afterEach(() => {
  vi.useRealTimers();
});

describe('DelayedFallback', () => {
  it('does not show a fallback before its delay', async () => {
    vi.useFakeTimers();
    render(<DelayedFallback>Loading</DelayedFallback>);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('keeps a visible fallback up for its minimum duration', async () => {
    vi.useFakeTimers();
    let resolve: (() => void) | undefined;
    const Feature = lazyWithDelayedFallback(
      () =>
        new Promise<{ default: () => ReactElement }>((done) => {
          resolve = () => done({ default: () => <span>Ready</span> });
        }),
    );
    render(
      <Suspense fallback={<DelayedFallback>Loading</DelayedFallback>}>
        <Feature />
      </Suspense>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('Loading')).toBeInTheDocument();

    await act(async () => {
      resolve?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(screen.getByText('Loading')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });
});
