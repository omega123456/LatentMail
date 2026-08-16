import { useState } from 'react';
import { initialFor } from '@/lib/avatars/identity';

/** Every size a consumer actually needs (FR "Presentation" / wireframes):
 * 24 switcher menu rows (initials-only by policy, never passed `src`), 32
 * comfortable row, 36 collapsed rail, 40 spacious row / switcher trigger, 48
 * reader header. All five are stock Tailwind sizes — no `@theme` token. */
export type AvatarSize = 24 | 32 | 36 | 40 | 48;

const DIMENSION_CLASS: Record<AvatarSize, string> = {
  24: 'size-6',
  32: 'size-8',
  36: 'size-9',
  40: 'size-10',
  48: 'size-12',
};

const TEXT_CLASS: Record<AvatarSize, string> = {
  24: 'text-label-sm',
  32: 'text-label-md',
  36: 'text-body-sm',
  40: 'text-body-sm',
  48: 'text-title-lg',
};

/** Owns the fade-in's `loaded` bit itself, keyed by `src` in the parent —
 * remounting on a new `src` is what resets `loaded` to `false` (a fresh
 * `useState` initializer), rather than a `useEffect` syncing it back down,
 * which `react-hooks/set-state-in-effect` flags as a cascading-render smell.
 * On load failure (404, decode failure, asset-protocol scope mismatch, cache
 * file deleted), silently reports it via `onError` so the parent can fall
 * back to the letter initial instead of a permanently blank plate. */
function AvatarImage({ src, onError }: { src: string; onError: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt=""
      onLoad={() => setLoaded(true)}
      onError={onError}
      className={`size-full rounded-full object-cover transition-opacity duration-150 ${
        loaded ? 'opacity-100' : 'opacity-0'
      }`}
    />
  );
}

export type AvatarProps = {
  size: AvatarSize;
  /** A resolved, already-asset-URL-converted image source, or `null`/
   * `undefined` for "no image" — covers both "not yet looked up" and
   * "looked up, nothing there" identically, per the plan's caching model.
   * Avatar never fetches; it only ever renders what it's given. */
  src?: string | null;
  /** The resolved display label the initial is derived from. `null`/
   * `undefined` renders `?`. */
  label?: string | null;
  /** Hosts the inset unread notch (D9/D16) — decoration only, never the
   * row's sole accessible read-state signal. Only rendered when there is
   * also an image or initial to notch, i.e. whenever Avatar renders at all. */
  unread?: boolean;
  /** When supplied, the avatar carries its own accessible name (`role="img"`)
   * instead of being hidden from assistive technology — the collapsed
   * rail's sole exception, where the avatar is the only identity cue.
   * Omitted everywhere else, where a visible name already carries identity
   * and the avatar stays `aria-hidden`. */
  ariaLabel?: string;
  /** Adds a ring around the initial-only (no-image) state. Defaults to
   * `false` — most consumers (switcher, rail) never had a ring around their
   * pre-slice initial circle, so this stays opt-in per consumer instead of
   * universal. The reader message header is the one consumer that already
   * had a ring on its inline initial circle before this slice and must keep
   * it (plan: "the existing 48px circle and its ring are retained"). The
   * image state already always has a ring (D7's plate ring) regardless of
   * this prop. */
  ring?: boolean;
  /** Ring color classes for the unread notch, matching the row's *current*
   * background (resting/hover/selected) so the notch's separating ring never
   * mismatches the ground it sits on. Defaults to the plain-surface ring,
   * which is correct for every consumer without hover/selected row states. */
  notchRingClassName?: string;
  className?: string;
};

/** The one avatar component every surface (row, reader header, switcher,
 * collapsed rail) renders through — image-with-plate-and-ring, or a letter
 * initial, at any of the sizes above, with an optional inset unread notch.
 * Renders the initial synchronously; an image (once `src` resolves) replaces
 * it with a short opacity transition — no skeleton (FR "Presentation"). */
export function Avatar({
  size,
  src,
  label,
  unread = false,
  ariaLabel,
  ring = false,
  notchRingClassName = 'ring-surface dark:ring-dark-surface',
  className = '',
}: AvatarProps) {
  const dimension = DIMENSION_CLASS[size];
  const textSize = TEXT_CLASS[size];
  const showNotch = unread;
  // Any image failure (404, decode failure, asset-protocol scope mismatch,
  // cache file deleted) is silent and falls back to the letter initial, per
  // the avatars plan. Reset during render (not a `useEffect`, which
  // `react-hooks/set-state-in-effect` flags as a cascading-render smell)
  // whenever `src` itself changes, so a new candidate always gets a fresh
  // chance instead of inheriting the previous candidate's failure.
  const [failed, setFailed] = useState(false);
  const [trackedSrc, setTrackedSrc] = useState(src);
  if (src !== trackedSrc) {
    setTrackedSrc(src);
    setFailed(false);
  }
  const showImage = Boolean(src) && !failed;

  return (
    <span
      className={`relative inline-flex shrink-0 ${dimension} ${className}`}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : { 'aria-hidden': true })}
    >
      <span
        className={`flex size-full items-center justify-center overflow-hidden rounded-full font-semibold ${textSize} ${
          showImage
            ? // D7: the light plate is unconditional in both themes — it's
              // what keeps a dark-ink-on-transparent brand mark visible
              // against the dark theme's near-black surfaces. Deliberately
              // no `dark:` counterpart here: the plate must render
              // identically (light/white) in both themes, not invert.
              'bg-surface-container-lowest ring-1 ring-outline-variant/40'
            : // D10: the reader's existing fixed-brand pair, unified across
              // every surface (this is what gives the switcher/rail their
              // first dark-theme variant). `ring` restores the reader
              // header's pre-slice ring on this state only — the
              // switcher/rail's pre-slice initials never had one.
              `bg-primary-fixed text-on-primary-fixed dark:bg-dark-primary-fixed dark:text-dark-on-primary-fixed ${
                ring ? 'ring-2 ring-surface-container dark:ring-dark-surface-container' : ''
              }`
        }`}
      >
        {showImage ? (
          <AvatarImage key={src} src={src as string} onError={() => setFailed(true)} />
        ) : (
          initialFor(label)
        )}
      </span>
      {showNotch && (
        <span
          aria-hidden="true"
          className={`absolute bottom-0 right-0 size-2 rounded-full bg-primary ring-2 dark:bg-dark-primary ${notchRingClassName}`}
        />
      )}
    </span>
  );
}
