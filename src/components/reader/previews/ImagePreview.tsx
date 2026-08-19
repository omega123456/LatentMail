export function ImagePreview({ src, filename }: { src: string; filename: string }) {
  return (
    <div className="grid h-full grid-rows-1 place-items-center p-stack-gap-md">
      <img src={src} alt={filename} className="max-h-full max-w-full object-contain" />
    </div>
  );
}
