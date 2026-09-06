import { isExternalHttpUrl, openExternalUrl } from '@/lib/url';
import { FILE_LINK_ATTR, FILE_LINK_SELECTOR } from '../fileReferenceDecorate';
import {
  openFileReferenceFromElement,
  type OpenFileReferenceOptions,
} from '../fileReferenceActions';
import type { ToolPopupContent } from '../message/types';

const MARKDOWN_IMAGE_SELECTOR = 'img:not([data-md-link-favicon="true"])';

type MarkstreamPointerOptions = {
  onShowPopup?: (content: ToolPopupContent) => void;
  fileReference?: OpenFileReferenceOptions;
};

const getMarkdownImageSource = (image: HTMLImageElement): string => (
  image.getAttribute('data-md-image-source') ?? image.getAttribute('src') ?? ''
);

export const handleMarkstreamPointerEvent = (
  event: MouseEvent,
  options: MarkstreamPointerOptions,
): void => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return;
  }

  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const image = target.closest(MARKDOWN_IMAGE_SELECTOR);
  if (image instanceof HTMLImageElement && options.onShowPopup) {
    const container = event.currentTarget;
    if (!(container instanceof HTMLElement)) {
      return;
    }
    const images = Array.from(container.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR));
    const gallery = images.map((item) => ({
      url: getMarkdownImageSource(item),
      filename: item.alt || getMarkdownImageSource(item) || undefined,
    })).filter((item) => item.url);
    const selectedSource = getMarkdownImageSource(image);
    const galleryIndex = gallery.findIndex((item) => item.url === selectedSource);
    if (!selectedSource) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    options.onShowPopup({
      open: true,
      title: image.alt || selectedSource,
      content: '',
      image: {
        url: selectedSource,
        filename: image.alt || selectedSource,
        gallery,
        index: galleryIndex >= 0 ? galleryIndex : 0,
      },
    });
    return;
  }

  if (options.fileReference) {
    const fileRefElement = target.closest(FILE_LINK_SELECTOR);
    if (fileRefElement instanceof HTMLElement) {
      event.preventDefault();
      event.stopPropagation();
      void openFileReferenceFromElement(fileRefElement, options.fileReference);
      return;
    }
  }

  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }
  const href = anchor.getAttribute('href') ?? '';
  if (!isExternalHttpUrl(href)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void openExternalUrl(href);
};

export const handleMarkstreamFileReferenceKeyDown = (
  event: KeyboardEvent,
  options: MarkstreamPointerOptions,
): void => {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  if (!options.fileReference) {
    return;
  }

  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const fileRefElement = target.closest(FILE_LINK_SELECTOR);
  if (!(fileRefElement instanceof HTMLElement) || fileRefElement.getAttribute(FILE_LINK_ATTR) !== 'true') {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void openFileReferenceFromElement(fileRefElement, options.fileReference);
};
