// Deliberately thin (per the plan): reuses `src/lib/format/participants.ts`'s
// address parsing and lower-cased bare-address key rather than restating
// either. Everything here is a pure derivation from an already-resolved
// identity — Rust has already done every real address-list/RFC-5322 parse.
import { addressKey } from '@/lib/format/participants';

/** The avatar's letter fallback: the first character of the resolved label,
 * uppercased. `?` when there is no label at all (FR "Avatar states"). */
export function initialFor(label: string | null | undefined): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
}

/** The lower-cased domain a sender-avatar lookup is keyed by, extracted from
 * an already-resolved bare address. `null` when the address carries no `@`
 * (or nothing at all), in which case no lookup is possible. */
export function domainFor(address: string | null | undefined): string | null {
  if (!address) return null;
  const key = addressKey(address);
  const at = key.lastIndexOf('@');
  if (at === -1 || at === key.length - 1) return null;
  return key.slice(at + 1);
}
