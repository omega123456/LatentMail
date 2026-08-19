import { File } from 'lucide-react';

export function UnsupportedPreview() {
  return (
    <div className="grid h-full place-items-center p-stack-gap-md text-center text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
      <div className="flex flex-col items-center gap-stack-gap-sm">
        <File size={26} aria-hidden="true" className="text-outline dark:text-dark-outline" />
        <p>
          Preview not available for this file type.
          <br />
          Use Download to save the file.
        </p>
      </div>
    </div>
  );
}
