import './styles.css';

type Chapter = {
  id: string;
  number: number;
  pages: number[];
  color: string;
};

const currentChapter: Chapter = {
  id: 'chapter-46',
  number: 46,
  color: '#334155',
  pages: Array.from({ length: 120 }, (_, index) => 285 + ((index * 37) % 110)),
};

const previousChapter: Chapter = {
  id: 'chapter-45',
  number: 45,
  color: '#4a1d1f',
  pages: Array.from({ length: 120 }, (_, index) => 290 + ((index * 41) % 115)),
};

const chaptersEl = document.querySelector<HTMLDivElement>('#chapters');
const readerEl = document.querySelector<HTMLElement>('#reader');
const detailsEl = document.querySelector<HTMLElement>('#details');
const chapterListEl = document.querySelector<HTMLDivElement>('#chapter-list');
const logEl = document.querySelector<HTMLPreElement>('#log');
const statusEl = document.querySelector<HTMLElement>('#status');
const resetButton = document.querySelector<HTMLButtonElement>('#reset');

if (!chaptersEl || !readerEl || !detailsEl || !chapterListEl || !logEl || !statusEl || !resetButton) {
  throw new Error('missing app nodes');
}

let prepended = false;
let scheduled = false;
let startTime = performance.now();
let activeView: 'details' | 'reader' = 'details';
let reservedSlot: HTMLElement | null = null;

function elapsed() {
  return Math.round(performance.now() - startTime);
}

function log(message: string) {
  const line = `${elapsed()}ms scrollTop=${Math.round(readerEl.scrollTop)} ${message}`;
  logEl.textContent = `${line}\n${logEl.textContent ?? ''}`.slice(0, 5000);
  console.log(`[prepend-test] ${line}`);
}

function renderChapter(chapter: Chapter) {
  const chapterEl = document.createElement('section');
  chapterEl.className = 'chapter';
  chapterEl.dataset.chapterId = chapter.id;

  const separator = document.createElement('div');
  separator.className = 'chapter-separator';
  separator.textContent = `Chapter ${chapter.number}`;
  chapterEl.append(separator);

  chapter.pages.forEach((height, index) => {
    const page = document.createElement('div');
    page.className = 'page';
    page.style.height = `${height}px`;
    page.style.background = index % 2 === 0 ? chapter.color : `hsl(${(index * 19) % 360} 34% 28%)`;
    page.textContent = `Ch ${chapter.number} Page ${index + 1} - ${height}px`;
    chapterEl.append(page);
  });

  return chapterEl;
}

function currentAnchor() {
  return chaptersEl.querySelector<HTMLElement>('[data-chapter-id="chapter-46"] .chapter-separator');
}

function logAnchor(phase: string) {
  const anchor = currentAnchor();
  const anchorRect = anchor?.getBoundingClientRect();
  const readerRect = readerEl.getBoundingClientRect();
  log(`${phase} anchorTop=${anchorRect ? Math.round(anchorRect.top - readerRect.top) : 'missing'}`);
}

function prependPreviousChapter() {
  if (prepended || activeView !== 'reader') return;
  prepended = true;
  statusEl.textContent = 'Prepending previous chapter';
  logAnchor('before-prepend');
  const realChapter = renderChapter(previousChapter);
  if (reservedSlot?.isConnected) {
    reservedSlot.replaceWith(realChapter);
    reservedSlot = null;
  } else {
    chaptersEl.prepend(realChapter);
  }
  logAnchor('after-prepend');
  statusEl.textContent = 'Prepended';
}

function estimatedChapterHeight(chapter: Chapter) {
  return 52 + chapter.pages.reduce((sum, height) => sum + height + 4, 0);
}

function reservePreviousChapterSpace() {
  if (reservedSlot?.isConnected || prepended || activeView !== 'reader') return;
  const slot = document.createElement('section');
  slot.className = 'reserved-chapter';
  slot.style.height = `${estimatedChapterHeight(previousChapter)}px`;
  slot.textContent = `Reserved Chapter ${previousChapter.number}`;
  reservedSlot = slot;
  logAnchor('before-reserve');
  chaptersEl.prepend(slot);
  logAnchor('after-reserve');
}

function schedulePrepend() {
  if (scheduled || prepended) return;
  scheduled = true;
  statusEl.textContent = 'Prepend scheduled';
  reservePreviousChapterSpace();
  log('first-scroll schedule prepend in 1000ms');
  window.setTimeout(prependPreviousChapter, 1000);
}

function reset() {
  startTime = performance.now();
  prepended = false;
  scheduled = false;
  reservedSlot = null;
  chaptersEl.replaceChildren(renderChapter(currentChapter));
  readerEl.scrollTop = 0;
  detailsEl.scrollTop = 0;
  activeView = 'details';
  detailsEl.classList.remove('hidden');
  readerEl.classList.add('hidden');
  logEl.textContent = '';
  statusEl.textContent = 'Manga details';
  log('reset details view');
}

readerEl.addEventListener(
  'scroll',
  () => {
    if (readerEl.scrollTop > 80) schedulePrepend();
  },
  { passive: true },
);

resetButton.addEventListener('click', reset);

function openReader(chapterNumber: number) {
  activeView = 'reader';
  prepended = false;
  scheduled = false;
  reservedSlot = null;
  chaptersEl.replaceChildren(renderChapter(currentChapter));
  readerEl.scrollTop = 0;
  detailsEl.classList.add('hidden');
  readerEl.classList.remove('hidden');
  statusEl.textContent = `Reader chapter ${chapterNumber}`;
  log(`open-reader chapter=${chapterNumber} detailsScrollTop=${Math.round(detailsEl.scrollTop)}`);
  requestAnimationFrame(() => logAnchor('reader-open-anchor'));
}

function renderChapterList() {
  const fragment = document.createDocumentFragment();
  for (let number = 46; number >= 35; number -= 1) {
    const button = document.createElement('button');
    button.className = 'chapter-button';
    button.type = 'button';
    button.textContent = `Chapter ${number}`;
    button.addEventListener('click', () => openReader(number));
    fragment.append(button);
  }
  chapterListEl.replaceChildren(fragment);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    log(`sw-error ${String(error)}`);
  });
}

renderChapterList();
reset();
