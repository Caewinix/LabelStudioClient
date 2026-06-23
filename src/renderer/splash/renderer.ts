{
interface LaunchStage {
  title: string;
  detail: string;
  progress: number;
  showsDownloadProgress?: boolean;
  downloadProgress?: number;
  downloadStatus?: string;
}

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const card = document.querySelector('.splash-card') as HTMLElement;
const contentRow = document.querySelector('.content-row') as HTMLElement;
const textColumn = document.querySelector('.text-column') as HTMLElement;
const columnPaddingView = document.querySelector('.column-padding-view') as HTMLElement;
const artworkColumn = document.querySelector('.artwork-column') as HTMLElement;
const artworkLayer = document.querySelector('.artwork-layer') as HTMLElement;
const logo = document.querySelector('.logo') as HTMLElement;
const logoMark = document.querySelector('.logo .brand-mark') as HTMLImageElement;
const eyebrow = document.querySelector('.eyebrow') as HTMLElement;
const accentMark = document.querySelector('.accent-mark') as HTMLElement;
const title = document.getElementById('title') as HTMLHeadingElement;
const detail = document.getElementById('detail') as HTMLParagraphElement;
const mainProgress = document.querySelector('.main-progress') as HTMLElement;
const fill = document.getElementById('fill') as HTMLDivElement;
const progressValue = document.getElementById('progressValue') as HTMLDivElement;
const downloadProgress = document.querySelector('.download-progress') as HTMLElement;
const downloadFill = document.getElementById('downloadFill') as HTMLDivElement;
const downloadProgressValue = document.getElementById('downloadProgressValue') as HTMLDivElement;
const download = document.getElementById('download') as HTMLDivElement;
const opossumBackground = document.querySelector('.opossum-background') as HTMLImageElement;
const opossumLooking = document.querySelector('.opossum-looking') as HTMLImageElement;
const downloadPauseButton = document.getElementById('downloadPause') as HTMLButtonElement;
const downloadCancelButton = document.getElementById('downloadCancel') as HTMLButtonElement;

// //**Test Start**
// const textTestBounds = document.createElement('div');
// const artworkTestBounds = document.createElement('div');

// function setupTestBoundsRect(el: HTMLElement, color: string): void {
//   el.style.position = 'fixed';
//   el.style.left = '0';
//   el.style.top = '0';
//   el.style.width = '0';
//   el.style.height = '0';
//   el.style.border = `2px solid ${color}`;
//   el.style.boxSizing = 'border-box';
//   el.style.pointerEvents = 'none';
//   el.style.zIndex = '2147483647';
//   el.style.background = 'transparent';
//   document.body.appendChild(el);
// }

// function visibleElementBounds(elements: HTMLElement[]): Frame | undefined {
//   const rects = elements
//     .filter(el => !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
//     .map(el => el.getBoundingClientRect())
//     .filter(rect => rect.width > 0 && rect.height > 0);
//   if (rects.length === 0) return undefined;
//   const left = Math.min(...rects.map(rect => rect.left));
//   const top = Math.min(...rects.map(rect => rect.top));
//   const right = Math.max(...rects.map(rect => rect.right));
//   const bottom = Math.max(...rects.map(rect => rect.bottom));
//   return { x: left, y: top, width: right - left, height: bottom - top };
// }

// function setViewportTestBounds(el: HTMLElement, frame: Frame | undefined): void {
//   if (!frame) {
//     el.style.display = 'none';
//     return;
//   }
//   el.style.display = 'block';
//   el.style.left = px(frame.x);
//   el.style.top = px(frame.y);
//   el.style.width = px(frame.width);
//   el.style.height = px(frame.height);
// }

// function updateTestBoundsRects(): void {
//   const textBounds = visibleElementBounds([
//     logo,
//     eyebrow,
//     accentMark,
//     title,
//     mainProgress,
//     progressValue,
//     detail,
//     download,
//     downloadProgress,
//     downloadProgressValue,
//     downloadPauseButton,
//     downloadCancelButton
//   ]);
//   const artworkBounds = visibleElementBounds([opossumBackground, opossumLooking]);
//   setViewportTestBounds(textTestBounds, textBounds);
//   setViewportTestBounds(artworkTestBounds, artworkBounds);
// }

// setupTestBoundsRect(textTestBounds, 'rgba(0, 220, 255, 0.95)');
// setupTestBoundsRect(artworkTestBounds, 'rgba(255, 80, 220, 0.95)');
// //**Test End**

const splashPlatform = window.splashAPI?.platform ?? 'unknown';
document.documentElement.dataset.platform = splashPlatform;

const T = {
  referenceCardWidth: 1552,
  referenceCardHeight: 790,
  cardHorizontalGapDiagonalRatio: 0.06,
  cardVerticalGapDiagonalRatio: 0.06,
  cardCornerRadius: 0,
  contentLeft: 100,
  contentTop: 0,
  textColumnWidth: 700,
  downloadControlSize: 36,
  downloadControlGap: 10
};

const OpossumBackgroundHeightRatio = 27446.92 / 33496.32;

let isDownloadPaused = false;
let currentDownloadStatus: string | undefined;
let currentProgress = 0;
let currentDownloadProgress: number | undefined;
let showsDownloadProgress = false;

let currentStage: LaunchStage = {
  title: 'Preparing Runtime',
  detail: 'Verifying the bundled Python runtime and packaged resources.',
  progress: 0,
  showsDownloadProgress: false
};

function clamp01(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function percentText(value: number): string { return `${Math.round(clamp01(value) * 100)}%`; }
function px(value: number): string { return `${value}px`; }
function setTopLeftFrame(el: HTMLElement, x: number, top: number, width: number, height: number, boundsHeight: number): void {
  el.style.left = px(x);
  el.style.top = px(top);
  el.style.width = px(width);
  el.style.height = px(height);
}

function unionFrames(frames: Frame[]): Frame {
  const left = Math.min(...frames.map(frame => frame.x));
  const top = Math.min(...frames.map(frame => frame.y));
  const right = Math.max(...frames.map(frame => frame.x + frame.width));
  const bottom = Math.max(...frames.map(frame => frame.y + frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const measureCanvas = document.createElement('canvas');
const measureContext = measureCanvas.getContext('2d');
function labelFont(fontSize: number, weight = 700): string {
  return `${weight} ${fontSize}px \"Avenir Next\", AvenirNext, -apple-system, BlinkMacSystemFont, \"Helvetica Neue\", Arial, sans-serif`;
}
function labelWidth(text: string, fontSize: number, minimum: number, weight = 700): number {
  if (!measureContext) return Math.max(minimum, text.length * fontSize * 0.62 + 8);
  measureContext.font = labelFont(fontSize, weight);
  return Math.max(minimum, Math.ceil(measureContext.measureText(text).width) + 8);
}
function labelHeight(fontSize: number, scale: number, weight = 700): number {
  if (!measureContext) return Math.max(fontSize * 1.18, 30 * scale);
  measureContext.font = labelFont(fontSize, weight);
  const metrics = measureContext.measureText('100%');
  const actual = (metrics.actualBoundingBoxAscent || fontSize * 0.82) + (metrics.actualBoundingBoxDescent || fontSize * 0.22);
  return Math.max(Math.ceil(actual + 18 * scale), 30 * scale);
}
function setHidden(el: HTMLElement, hidden: boolean): void {
  el.classList.toggle('hidden', hidden);
  el.setAttribute('aria-hidden', hidden ? 'true' : 'false');
}

function setDownloadUiHidden(hidden: boolean): void {
  for (const el of [download, downloadProgress, downloadProgressValue, downloadPauseButton, downloadCancelButton]) {
    setHidden(el, hidden);
  }
}

let rendererReadyReported = false;
function reportRendererReadyAfterLayout(): void {
  if (rendererReadyReported) return;
  layout();
  void document.body.getBoundingClientRect();
  rendererReadyReported = true;
  window.splashAPI?.rendererReady();
}

function layout(): void {
  const boundsWidth = window.innerWidth;
  const boundsHeight = window.innerHeight;
  const windowDiagonal = Math.hypot(boundsWidth, boundsHeight);
  const cardHorizontalGap = windowDiagonal * T.cardHorizontalGapDiagonalRatio;
  const cardVerticalGap = windowDiagonal * T.cardVerticalGapDiagonalRatio;
  const cardWidth = boundsWidth - cardHorizontalGap * 2;
  const cardHeight = boundsHeight - cardVerticalGap * 2;
  const scale = Math.min(cardWidth / T.referenceCardWidth, cardHeight / T.referenceCardHeight);
  const cardBorderWidth = 1;
  const cardContentWidth = cardWidth - cardBorderWidth * 2;
  const cardContentHeight = cardHeight - cardBorderWidth * 2;

  setTopLeftFrame(card, cardHorizontalGap, cardVerticalGap, cardWidth, cardHeight, boundsHeight);
  setTopLeftFrame(contentRow, 0, 0, cardContentWidth, cardContentHeight, cardContentHeight);
  card.style.borderRadius = px(T.cardCornerRadius * scale);
  card.style.boxShadow = `0 ${36 * scale}px ${68 * scale}px rgba(46,38,30,0.24), 0 ${14 * scale}px ${24 * scale}px rgba(46,38,30,0.16)`;

  const cardBoundsHeight = cardContentHeight;
  const contentLeft = T.contentLeft * scale - cardBorderWidth;
  const contentTopBase = T.contentTop * scale;
  const textColumnWidth = T.textColumnWidth * scale;
  const artworkBaseWidth = 720 * scale;
  const artworkBaseHeight = artworkBaseWidth * OpossumBackgroundHeightRatio;
  const lookingFrame: Frame = {
    x: 109.39997440119146 * scale,
    y: 45 * scale,
    width: 651.2000511976171 * scale,
    height: 471.9750085979594 * scale
  };
  const backgroundScale = 0.95;
  const backgroundWidth = artworkBaseWidth * backgroundScale;
  const backgroundHeight = artworkBaseHeight * backgroundScale;
  const backgroundX = (artworkBaseWidth - backgroundWidth) / 2;
  const backgroundBottom = (artworkBaseHeight - backgroundHeight) / 2 + 50 * scale;
  const backgroundFrame: Frame = {
    x: backgroundX,
    y: artworkBaseHeight - backgroundBottom - backgroundHeight,
    width: backgroundWidth,
    height: backgroundHeight
  };
  const artworkBounds = unionFrames([lookingFrame, backgroundFrame]);
  const artworkBaseTop = (cardBoundsHeight - artworkBounds.height) / 2 - artworkBounds.y;
  const textRight = contentLeft + textColumnWidth;
  const artworkRight = cardContentWidth - contentLeft;
  const artworkLeft = artworkRight - artworkBounds.width;
  const artworkGap = artworkLeft - textRight;

  setTopLeftFrame(textColumn, contentLeft, 0, textColumnWidth, cardBoundsHeight, cardBoundsHeight);
  setTopLeftFrame(columnPaddingView, textRight, 0, Math.max(0, artworkGap), cardBoundsHeight, cardBoundsHeight);
  setTopLeftFrame(artworkColumn, artworkLeft, 0, artworkBounds.width, cardBoundsHeight, cardBoundsHeight);

  const logoWidth = 660 * scale;
  const logoHeight = logoWidth * 0.201;
  const logoTopBase = contentTopBase + 138 * scale;
  const eyebrowTopBase = logoTopBase + logoHeight + 24 * scale;
  const accentTopBase = contentTopBase + 382 * scale;
  const titleTopBase = contentTopBase + 414 * scale;
  const progressTopBase = contentTopBase + 504 * scale;
  const normalDetailTopBase = contentTopBase + 574 * scale;
  const downloadDetailTopBase = contentTopBase + 668 * scale;
  const detailTopBase = showsDownloadProgress ? downloadDetailTopBase : normalDetailTopBase;
  const progressHeight = 18 * scale;
  const progressWidth = 520 * scale;
  const progressValueGap = 26 * scale;
  const progressValueX = progressWidth + progressValueGap;
  const controlSize = T.downloadControlSize * scale;
  const controlGap = T.downloadControlGap * scale;
  const progressValueFontSize = 47.25 * scale;
  const progressValueHeight = labelHeight(progressValueFontSize, scale, 700);
  const progressValueWidth = labelWidth(progressValue.textContent || '100%', progressValueFontSize, 90 * scale, 700);
  const progressValueTopBase = progressTopBase + progressHeight / 2 - progressValueHeight / 2;
  const textFrames: Frame[] = [
    { x: 0, y: logoTopBase, width: logoWidth, height: logoHeight },
    { x: 0, y: eyebrowTopBase, width: 520 * scale, height: 30 * scale },
    { x: 0, y: accentTopBase, width: 28 * scale, height: 6 * scale },
    { x: 0, y: titleTopBase, width: 700 * scale, height: 72 * scale },
    { x: 0, y: progressTopBase, width: progressWidth, height: progressHeight },
    { x: progressValueX, y: progressValueTopBase, width: progressValueWidth, height: progressValueHeight },
    { x: 0, y: downloadDetailTopBase, width: 700 * scale, height: 96 * scale }
  ];
  const downloadLabelHeight = 30 * scale;
  const downloadVerticalGap = 12 * scale;
  const downloadProgressTopBase = contentTopBase + 632 * scale;
  const downloadTopBase = downloadProgressTopBase - downloadLabelHeight - downloadVerticalGap;
  const controlTopBase = downloadTopBase - controlSize - downloadVerticalGap;
  const downloadPercentFontSize = 47.25 * scale;
  const downloadPercentWidth = labelWidth(downloadProgressValue.textContent || '100%', downloadPercentFontSize, 90 * scale, 700);
  const downloadPercentHeight = labelHeight(downloadPercentFontSize, scale, 700);

  textFrames.push(
    { x: 0, y: downloadTopBase, width: textColumnWidth, height: downloadLabelHeight },
    { x: 0, y: downloadProgressTopBase, width: progressWidth, height: progressHeight },
    { x: progressValueX, y: downloadProgressTopBase + progressHeight / 2 - downloadPercentHeight / 2, width: downloadPercentWidth, height: downloadPercentHeight },
    { x: 0, y: controlTopBase, width: controlSize * 2 + controlGap, height: controlSize }
  );

  const textBounds = unionFrames(textFrames);
  const contentTop = (cardBoundsHeight - textBounds.height) / 2 - textBounds.y;
  const logoTop = contentTop + logoTopBase;
  setTopLeftFrame(logo, 0, logoTop, logoWidth, logoHeight, cardBoundsHeight);
  logo.style.setProperty('--brand-mark-size', px(102 * scale));
  logo.style.setProperty('--brand-logo-gap', px(27 * scale));
  logo.style.setProperty('--brand-wordmark-font-size', px(92 * scale));

  setTopLeftFrame(eyebrow, 0, contentTop + eyebrowTopBase, 520 * scale, 30 * scale, cardBoundsHeight);
  eyebrow.style.fontSize = px(18 * scale);

  setTopLeftFrame(accentMark, 0, contentTop + accentTopBase, 28 * scale, 6 * scale, cardBoundsHeight);
  accentMark.style.borderRadius = px(3 * scale);

  setTopLeftFrame(title, 0, contentTop + titleTopBase, 700 * scale, 72 * scale, cardBoundsHeight);
  title.style.fontSize = px(48 * scale);

  const progressTop = contentTop + progressTopBase;

  setTopLeftFrame(mainProgress, 0, progressTop, progressWidth, progressHeight, cardBoundsHeight);
  const progressRowCenterTop = progressTop + progressHeight / 2;
  setTopLeftFrame(progressValue, progressValueX, progressRowCenterTop - progressValueHeight / 2, progressValueWidth, progressValueHeight, cardBoundsHeight);
  progressValue.style.fontSize = px(progressValueFontSize);

  setTopLeftFrame(detail, 0, contentTop + detailTopBase, 700 * scale, 96 * scale, cardBoundsHeight);
  detail.style.fontSize = px(31.5 * scale);

  const downloadProgressTop = contentTop + downloadProgressTopBase;
  const downloadTop = contentTop + downloadTopBase;
  const pauseButtonX = 0;
  const cancelButtonX = pauseButtonX + controlSize + controlGap;

  setTopLeftFrame(download, 0, downloadTop, textColumnWidth, downloadLabelHeight, cardBoundsHeight);
  download.style.fontSize = px(26 * scale);

  setTopLeftFrame(downloadProgress, 0, downloadProgressTop, progressWidth, progressHeight, cardBoundsHeight);
  const downloadRowCenterTop = downloadProgressTop + progressHeight / 2;
  setTopLeftFrame(downloadProgressValue, progressValueX, downloadRowCenterTop - downloadPercentHeight / 2, downloadPercentWidth, downloadPercentHeight, cardBoundsHeight);
  downloadProgressValue.style.fontSize = px(downloadPercentFontSize);

  const controlTop = contentTop + controlTopBase;
  setTopLeftFrame(downloadPauseButton, pauseButtonX, controlTop, controlSize, controlSize, cardBoundsHeight);
  setTopLeftFrame(downloadCancelButton, cancelButtonX, controlTop, controlSize, controlSize, cardBoundsHeight);
  downloadPauseButton.style.fontSize = px(Math.max(8, controlSize * 0.58));
  downloadCancelButton.style.fontSize = px(Math.max(8, controlSize * 0.58));
  downloadPauseButton.style.pointerEvents = showsDownloadProgress ? 'auto' : 'none';
  downloadCancelButton.style.pointerEvents = showsDownloadProgress ? 'auto' : 'none';
  downloadPauseButton.disabled = !showsDownloadProgress;
  downloadCancelButton.disabled = !showsDownloadProgress;

  setTopLeftFrame(artworkLayer, 0, artworkBaseTop + artworkBounds.y, artworkBounds.width, artworkBounds.height, cardBoundsHeight);
  setTopLeftFrame(opossumLooking, lookingFrame.x - artworkBounds.x, lookingFrame.y - artworkBounds.y, lookingFrame.width, lookingFrame.height, artworkBounds.height);
  setTopLeftFrame(opossumBackground, backgroundFrame.x - artworkBounds.x, backgroundFrame.y - artworkBounds.y, backgroundFrame.width, backgroundFrame.height, artworkBounds.height);
//   //**Test Start**
//   updateTestBoundsRects();
//   //**Test End**
}

function displayDownloadStatus(status: string | undefined): string {
  const value = status ?? 'Preparing download';
  if (!isDownloadPaused) return value;
  const sizePart = value.split('    ')[0]?.trim();
  if (sizePart && sizePart.includes('/')) return `${sizePart}    Paused`;
  return 'Paused';
}

function pauseIconSVG(paused: boolean): string {
  if (paused) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/></svg>';
}

function cancelIconSVG(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 4.8 12 10.6l5.8-5.8 1.4 1.4-5.8 5.8 5.8 5.8-1.4 1.4-5.8-5.8-5.8 5.8-1.4-1.4 5.8-5.8-5.8-5.8z" fill="currentColor"/></svg>';
}

function updateDownloadControlImages(): void {
  downloadPauseButton.innerHTML = pauseIconSVG(isDownloadPaused);
  downloadPauseButton.title = isDownloadPaused ? 'Continue download' : 'Pause download';
  downloadCancelButton.innerHTML = cancelIconSVG();
  downloadCancelButton.title = 'Cancel download';
  download.textContent = displayDownloadStatus(currentDownloadStatus);
}

function stageShouldKeepDownloadUI(stage: LaunchStage): boolean {
  if (stage.showsDownloadProgress) return true;
  if (stage.downloadProgress !== undefined || stage.downloadStatus !== undefined) return true;
  return false;
}

function applyStage(stage: LaunchStage): void {
  currentStage = stage;
  const requestedProgress = clamp01(stage.progress);
  const progress = Math.max(currentProgress, requestedProgress);
  currentProgress = progress;

  const wasShowingDownloadProgress = showsDownloadProgress;
  const nextShowsDownloadProgress = stageShouldKeepDownloadUI(stage);
  showsDownloadProgress = nextShowsDownloadProgress;

  if (nextShowsDownloadProgress) {
    currentDownloadProgress = stage.downloadProgress ?? currentDownloadProgress ?? 0;
    currentDownloadStatus = stage.downloadStatus ?? currentDownloadStatus ?? stage.detail ?? stage.title;
  } else {
    isDownloadPaused = false;
  }

  title.textContent = stage.title;
  detail.textContent = stage.detail;
  fill.style.width = percentText(progress);
  progressValue.textContent = percentText(progress);

  if (showsDownloadProgress) {
    const downloadProgressNumber = clamp01(currentDownloadProgress ?? 0);
    downloadFill.style.width = percentText(downloadProgressNumber);
    downloadProgressValue.textContent = percentText(downloadProgressNumber);
    download.textContent = displayDownloadStatus(currentDownloadStatus);
  } else {
    setDownloadUiHidden(true);
  }
  updateDownloadControlImages();
  layout();

  if (showsDownloadProgress) {
    if (wasShowingDownloadProgress) {
      setDownloadUiHidden(false);
    } else {
      setDownloadUiHidden(true);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setDownloadUiHidden(false));
      });
    }
  } else {
    window.setTimeout(() => {
      if (showsDownloadProgress) return;
      currentDownloadProgress = undefined;
      currentDownloadStatus = undefined;
      downloadFill.style.width = '0%';
      downloadProgressValue.textContent = '0%';
      download.textContent = '';
    }, 280);
  }
}

let lastPauseActionAt = 0;
let lastCancelActionAt = 0;
let cancelInFlight = false;

function guardRepeatedAction(last: number, windowMs = 90): boolean {
  return Date.now() - last < windowMs;
}

function flashButton(button: HTMLButtonElement): void {
  button.classList.add('pressed');
  window.setTimeout(() => button.classList.remove('pressed'), 120);
}

function downloadButtonIsInteractive(button: HTMLButtonElement): boolean {
  return showsDownloadProgress && !button.classList.contains('hidden') && !button.disabled;
}

function triggerPauseToggle(event?: Event): void {
  event?.preventDefault();
  event?.stopPropagation();
  if (!downloadButtonIsInteractive(downloadPauseButton)) return;
  if (cancelInFlight || guardRepeatedAction(lastPauseActionAt, 140)) return;
  lastPauseActionAt = Date.now();
  flashButton(downloadPauseButton);

  isDownloadPaused = !isDownloadPaused;
  updateDownloadControlImages();
  layout();

  if (typeof window.splashAPI?.setPaused === 'function') {
    window.splashAPI.setPaused(isDownloadPaused);
  } else {
    void window.splashAPI?.togglePause().then((paused) => {
      if (typeof paused === 'boolean') {
        isDownloadPaused = paused;
        updateDownloadControlImages();
        layout();
      }
    }).catch((error) => {
      currentDownloadStatus = error instanceof Error ? error.message : String(error);
      updateDownloadControlImages();
      layout();
    });
  }
}

async function triggerCancelDownload(event?: Event): Promise<void> {
  event?.preventDefault();
  event?.stopPropagation();
  if (!downloadButtonIsInteractive(downloadCancelButton)) return;
  if (cancelInFlight || guardRepeatedAction(lastCancelActionAt, 220)) return;
  lastCancelActionAt = Date.now();
  cancelInFlight = true;
  flashButton(downloadCancelButton);

  // Swift pauses the active download before presenting the cancel alert. Mirror
  // that immediately in the renderer so the control acknowledges the press even
  // while main is checking runtime usability or opening the dialog.
  isDownloadPaused = true;
  updateDownloadControlImages();
  layout();
  window.splashAPI?.setPaused?.(true);

  try {
    const cancelled = await window.splashAPI?.cancelDownload();
    if (cancelled === false) {
      // Swift returns to the exact same download state after Continue Download:
      // resume the stream, clear the paused visual state, and keep the last real
      // downloadStatus text instead of replacing it with a synthetic message.
      isDownloadPaused = false;
      updateDownloadControlImages();
      layout();
    }
  } catch (error) {
    currentDownloadStatus = error instanceof Error ? error.message : String(error);
    updateDownloadControlImages();
    layout();
  } finally {
    cancelInFlight = false;
  }
}

function bindExactDownloadButton(button: HTMLButtonElement, handler: (event: Event) => void | Promise<void>): void {
  let activePointerId: number | undefined;
  let ignoreNextClick = false;

  const pointerIsInside = (event: PointerEvent): boolean => {
    const bounds = button.getBoundingClientRect();
    return event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom;
  };

  const clearPointerState = (event?: PointerEvent): void => {
    const pointerId = event?.pointerId ?? activePointerId;
    if (pointerId !== undefined && typeof button.releasePointerCapture === 'function') {
      try { button.releasePointerCapture(pointerId); } catch { /* pointer may not be captured */ }
    }
    activePointerId = undefined;
    button.classList.remove('pressed');
  };

  const abandonPointerState = (event?: PointerEvent): void => {
    if (activePointerId === undefined) return;
    clearPointerState(event);
    ignoreNextClick = true;
    window.setTimeout(() => { ignoreNextClick = false; }, 0);
  };

  button.addEventListener('pointerdown', (event) => {
    if (!downloadButtonIsInteractive(button) || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    activePointerId = event.pointerId;
    button.classList.add('pressed');
    if (typeof button.setPointerCapture === 'function') {
      try { button.setPointerCapture(event.pointerId); } catch { /* pointer capture is best effort */ }
    }
  }, { passive: false });

  button.addEventListener('pointerup', (event) => {
    if (activePointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const shouldRun = pointerIsInside(event) && downloadButtonIsInteractive(button);
    clearPointerState(event);
    ignoreNextClick = true;
    window.setTimeout(() => { ignoreNextClick = false; }, 0);
    if (shouldRun) void handler(event);
  }, { passive: false });

  button.addEventListener('pointercancel', (event) => {
    if (activePointerId !== event.pointerId) return;
    abandonPointerState(event);
  });

  button.addEventListener('lostpointercapture', (event) => {
    if (activePointerId !== event.pointerId) return;
    abandonPointerState(event);
  });

  button.addEventListener('click', (event) => {
    if (ignoreNextClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (downloadButtonIsInteractive(button)) void handler(event);
  }, { passive: false });

  document.addEventListener('pointerup', (event) => {
    if (activePointerId !== event.pointerId) return;
    const shouldRun = pointerIsInside(event) && downloadButtonIsInteractive(button);
    clearPointerState(event);
    ignoreNextClick = true;
    window.setTimeout(() => { ignoreNextClick = false; }, 0);
    if (shouldRun) void handler(event);
  }, { capture: true, passive: false });

  document.addEventListener('pointercancel', (event) => {
    if (activePointerId !== event.pointerId) return;
    abandonPointerState(event);
  }, { capture: true });

  document.addEventListener('mouseleave', () => {
    abandonPointerState();
  });

  window.addEventListener('mouseout', (event) => {
    if (event.relatedTarget === null) abandonPointerState();
  });

  window.addEventListener('blur', () => {
    abandonPointerState();
  });
}

function bindDownloadButtonEvents(): void {
  bindExactDownloadButton(downloadPauseButton, triggerPauseToggle);
  bindExactDownloadButton(downloadCancelButton, triggerCancelDownload);

  downloadPauseButton.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') triggerPauseToggle(event);
  });
  downloadCancelButton.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') void triggerCancelDownload(event);
  });
}

bindDownloadButtonEvents();

window.addEventListener('resize', layout);
opossumBackground.addEventListener('load', layout);
opossumLooking.addEventListener('load', layout);
logoMark.addEventListener('load', layout);
window.splashAPI?.onStage(applyStage);
window.splashAPI?.onDownloadPaused((paused: boolean) => {
  isDownloadPaused = paused;
  updateDownloadControlImages();
  layout();
});
applyStage(currentStage);
reportRendererReadyAfterLayout();

}
