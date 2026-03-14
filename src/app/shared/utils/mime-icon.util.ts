/**
 * Maps MIME types to Material Symbol icon names.
 * Used by the message-attachments component to display appropriate file-type icons.
 */
export function getMimeIcon(mimeType: string | null | undefined): string {
  if (!mimeType) {
    return 'attach_file';
  }

  const lower = mimeType.toLowerCase();

  if (lower.startsWith('image/')) {
    return 'image';
  }

  if (lower === 'application/pdf') {
    return 'picture_as_pdf';
  }

  if (lower.startsWith('video/')) {
    return 'movie';
  }

  if (lower.startsWith('audio/')) {
    return 'audiotrack';
  }

  if (
    lower === 'application/zip' ||
    lower === 'application/x-zip-compressed' ||
    lower === 'application/x-rar-compressed' ||
    lower === 'application/x-rar' ||
    lower === 'application/gzip' ||
    lower === 'application/x-gzip' ||
    lower === 'application/x-7z-compressed' ||
    lower === 'application/x-tar'
  ) {
    return 'folder_zip';
  }

  if (
    lower === 'application/msword' ||
    lower === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lower === 'application/vnd.oasis.opendocument.text' ||
    lower.startsWith('text/')
  ) {
    return 'description';
  }

  if (
    lower === 'application/vnd.ms-excel' ||
    lower === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    lower === 'application/vnd.oasis.opendocument.spreadsheet' ||
    lower.includes('spreadsheet')
  ) {
    return 'table_chart';
  }

  if (
    lower === 'application/vnd.ms-powerpoint' ||
    lower === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    lower === 'application/vnd.oasis.opendocument.presentation' ||
    lower.includes('presentation')
  ) {
    return 'slideshow';
  }

  return 'attach_file';
}

/**
 * Returns true if the MIME type represents an image that can be displayed as a thumbnail.
 */
export function isImageMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) {
    return false;
  }
  return mimeType.toLowerCase().startsWith('image/');
}
