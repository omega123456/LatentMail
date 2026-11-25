import { useState } from 'react';
import { initialFor } from '@/lib/avatars/identity';

export const AVATAR_SIZE = {
  xs: 24,
  sm: 30,
  md: 32,
  lg: 36,
  xl: 40,
  xxl: 48,
} as const;

export type AvatarSize = (typeof AVATAR_SIZE)[keyof typeof AVATAR_SIZE];

const DIMENSION_CLASS: Record<AvatarSize, string> = {
  24: 'size-6',
  30: 'size-7.5',
  32: 'size-8',
  36: 'size-9',
  40: 'size-10',
  48: 'size-12',
};

const TEXT_CLASS: Record<AvatarSize, string> = {
  24: 'text-label-sm',
  30: 'text-avatar-md',
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
  fallbackClassName?: string;
  className?: string;
};

function avatarCircleClassName({
  showImage,
  textSize,
  fallbackClassName,
  ring,
}: {
  showImage: boolean;
  textSize: string;
  fallbackClassName: string | undefined;
  ring: boolean;
}): string {
  const base =
    'flex size-full items-center justify-center overflow-hidden rounded-full font-semibold';
  if (showImage) {
    return `${base} ${textSize} bg-surface-container-lowest ring-1 ring-outline-variant/40`;
  }
  const fallback =
    fallbackClassName ??
    `${textSize} bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary`;
  const ringClass = ring ? 'ring-2 ring-surface-container dark:ring-dark-surface-container' : '';
  return `${base} ${fallback} ${ringClass}`;
}

function avatarAccessibilityProps(ariaLabel: string | undefined) {
  if (ariaLabel) return { role: 'img' as const, 'aria-label': ariaLabel };
  return { 'aria-hidden': true as const };
}

function resolveImageSrc(src: string | null | undefined, failed: boolean): string | null {
  if (failed || !src) return null;
  return src;
}

export function Avatar({
  size,
  src,
  label,
  unread = false,
  ariaLabel,
  ring = false,
  notchRingClassName = 'ring-surface dark:ring-dark-surface',
  fallbackClassName,
  className = '',
}: AvatarProps) {
  const dimension = DIMENSION_CLASS[size];
  const textSize = TEXT_CLASS[size];
  const [failed, setFailed] = useState(false);
  const [trackedSrc, setTrackedSrc] = useState(src);
  if (src !== trackedSrc) {
    setTrackedSrc(src);
    setFailed(false);
  }
  const imageSrc = resolveImageSrc(src, failed);
  const circleClassName = avatarCircleClassName({
    showImage: imageSrc !== null,
    textSize: textSize,
    fallbackClassName: fallbackClassName,
    ring: ring,
  });

  return (
    <span
      className={`relative inline-flex shrink-0 ${dimension} ${className}`}
      {...avatarAccessibilityProps(ariaLabel)}
    >
      <span className={circleClassName}>
        {imageSrc ? (
          <AvatarImage key={imageSrc} src={imageSrc} onError={() => setFailed(true)} />
        ) : (
          initialFor(label)
        )}
      </span>
      {unread && (
        <span
          aria-hidden="true"
          className={`absolute bottom-0 right-0 size-2 rounded-full bg-primary ring-2 dark:bg-dark-primary ${notchRingClassName}`}
        />
      )}
    </span>
  );
}
