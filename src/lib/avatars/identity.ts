import { addressKey } from '@/lib/format/participants';

export function initialFor(label: string | null | undefined): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
}

export function domainFor(address: string | null | undefined): string | null {
  if (!address) return null;
  const key = addressKey(address);
  const at = key.lastIndexOf('@');
  if (at === -1 || at === key.length - 1) return null;
  return key.slice(at + 1);
}
