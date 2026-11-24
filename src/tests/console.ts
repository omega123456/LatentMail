import { onTestFinished, vi } from 'vitest';

type CapturedLevel = 'error' | 'info';

export function captureConsole(level: CapturedLevel) {
  const output = vi.spyOn(console, level).mockImplementation(() => undefined);
  onTestFinished(() => output.mockRestore());
  return output;
}
