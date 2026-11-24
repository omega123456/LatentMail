import { playwrightAvatarFixtureMark } from './avatars';
import { playwrightAttachmentImageSrc } from './attachments';

export type PlaywrightFileSources = {
  byPathMarker: { marker: string; src: string }[];
  placeholder: string;
};

export const playwrightFileSources: PlaywrightFileSources = {
  byPathMarker: [
    { marker: 'avatar-cache', src: playwrightAvatarFixtureMark },
    { marker: 'attachment-cache', src: playwrightAttachmentImageSrc },
  ],
  placeholder:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23c1c6d7'/%3E%3C/svg%3E",
};
