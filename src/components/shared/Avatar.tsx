import { useState } from 'react';
import { initialFor } from '@/lib/avatars/identity';

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
  src?: string | null;
  label?: string | null;
  unread?: boolean;
  ariaLabel?: string;
  ring?: boolean;
  notchRingClassName?: string;
  className?: string;
};

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
            ? 'bg-surface-container-lowest ring-1 ring-outline-variant/40'
            : `bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary ${
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
