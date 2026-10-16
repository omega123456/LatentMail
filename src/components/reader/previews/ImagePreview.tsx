import { useMemo, useRef, useState } from 'react';
import { useZoom } from '@/lib/attachments/useZoom';
import { PREVIEW_PADDING, type Size } from '@/lib/attachments/zoom';
import { ZoomToolbar } from './ZoomToolbar';

const IMAGE_FIT_CAP = 1;

export function ImagePreview({ src, filename }: { src: string; filename: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const content = useMemo(
    () =>
      natural && {
        width: natural.width + PREVIEW_PADDING * 2,
        height: natural.height + PREVIEW_PADDING * 2,
      },
    [natural],
  );
  const { zoom, mode, zoomIn, zoomOut, selectPreset } = useZoom({
    scrollRef,
    content,
    defaultMode: 'fit-page',
    fitCap: IMAGE_FIT_CAP,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        role="region"
        aria-label="Image"
        className="min-h-0 flex-1 overflow-auto"
      >
        <div className="grid min-h-full w-max min-w-full place-items-center">
          <div
            className={natural ? 'shrink-0' : 'invisible absolute'}
            style={
              content
                ? {
                    width: content.width * zoom,
                    height: content.height * zoom,
                    padding: PREVIEW_PADDING * zoom,
                  }
                : undefined
            }
          >
            <img
              src={src}
              alt={filename}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              className="block size-full"
            />
          </div>
        </div>
      </div>
      {natural && (
        <ZoomToolbar
          zoom={zoom}
          mode={mode}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onSelectPreset={selectPreset}
        />
      )}
    </div>
  );
}
