'use strict';
(() => {
  const app = document.querySelector('#app');
  const documentID = crypto.randomUUID();
  const rpc = async (command, args = {}) => JSON.parse(await window.webkit.messageHandlers.asura.postMessage({ command, args, document: documentID }));
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const route = () => location.pathname.split('/').filter(Boolean);
  const identity = slug => slug.replace(/-[0-9a-f]{8}$/i, '');
  const chapterURL = (slug, chapter, resume = false) => `/reader/${encodeURIComponent(slug)}/${encodeURIComponent(chapter)}${resume ? '?resume=1' : ''}`;
  let touching = false, skipPositionSave = false, heldAnchor, anchorFrame;
  let state, home = route().length === 0, restoring = true, touched = false, currentManifest, saveChain = Promise.resolve();
  let pages = [], observer, nextLoading = false, loadedChapters = new Set();
  const imageRetry = new ReaderCore.ImageRetryRegistry();
  let activeImages = 0, imageQueue = [], imageGeneration = 0, lastScroll = 0, catalogSignature = "";
  const maxImages = 4;
  function queueImage(slot) {
    if (slot.dataset.loading || slot.querySelector('img')) return;
    slot.dataset.loading = 'queued'; imageQueue.push({ slot, generation: imageGeneration }); pumpImages();
  }
  function pumpImages() {
    while (activeImages < maxImages && imageQueue.length) {
      const { slot, generation } = imageQueue.shift();
      if (!slot.isConnected || slot.dataset.near !== '1' || generation !== imageGeneration) { delete slot.dataset.loading; continue; }
      activeImages++; slot.dataset.loading = 'active';
      const img = new Image(); img.className = 'hs-reader-img'; img.decoding = 'async'; img.alt = `Page ${Number(slot.dataset.index) + 1}`;
      let finished = false;
      const finish = () => { if (finished) return; finished = true; activeImages--; delete slot.dataset.loading; pumpImages(); };
      slot.release = () => { img.onload = img.onerror = null; img.removeAttribute('src'); img.remove(); finish(); };
      img.onload = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          slot.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
          slot.style.removeProperty('height');
          slot.dataset.measured = '1';
        }
        finish(); schedulePositionUpdate();
      };
      img.onerror = finish;
      slot.append(img); img.src = new URL(slot.dataset.src, location.href).href; imageRetry.register(img);
    }
  }
  function observePages() {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const slot = entry.target; slot.dataset.near = entry.isIntersecting ? '1' : '0';
        if (entry.isIntersecting) queueImage(slot);
        else { slot.release?.(); }
      }
    }, { rootMargin: '1000px 0px' });
  }
  function report(error, parent = app) {
    const message = el('div', 'message hs-status hs-error', error?.message || String(error)); parent.append(message); return message;
  }
  function position() {
    const nodes = home ? [...document.querySelectorAll('.card')] : pages;
    const at = home ? 0 : innerHeight / 2;
    // Binary search stable document-order slots; no scan of every image during scrolling.
    let lo = 0, hi = nodes.length - 1, found = nodes[nodes.length - 1];
    while (lo <= hi) { const mid = (lo + hi) >> 1, n = nodes[mid], r = n.getBoundingClientRect(); if (r.bottom > at) { found = n; hi = mid - 1; } else lo = mid + 1; }
    if (!found) return { path: location.pathname, anchor: null, fraction: 0, y: scrollY };
    if (!home) {
      let index = nodes.indexOf(found);
      while (index >= 0 && !(nodes[index].querySelector('img')?.naturalWidth > 0 && nodes[index].getBoundingClientRect().top <= at)) index--;
      found = nodes[index];
      if (!found) return { path: location.pathname, anchor: null, fraction: 0, y: scrollY };
    }
    const rect = found.getBoundingClientRect();
    return { path: location.pathname, anchor: found.id, fraction: -rect.top / rect.height, y: scrollY };
  }
  function save() {
    if (!state || restoring || touching || skipPositionSave) return saveChain;
    const view = position();
    let progress;
    if (!home && view.anchor) {
      const slot = document.getElementById(view.anchor);
      if (slot?.manifest) {
        const m = slot.manifest;
        progress = { slug: m.slug, chapter: m.chapter, page: Number(slot.dataset.index), fraction: Math.max(0, Math.min(1, view.fraction)), total: m.pages.length, updatedAt: Date.now() };
        state.progress[identity(m.slug)] = progress;
        view.path = chapterURL(m.slug, m.chapter);
        if (location.pathname !== view.path) history.replaceState(null, '', view.path);
      }
    }
    if (progress && currentManifest?.chapter === progress.chapter) {
      [...document.querySelectorAll('.hs-chapter')].at(-1)?.appendNext?.();
    }
    saveChain = saveChain.catch(() => {}).then(() => rpc('view-save', { view, progress }));
    return saveChain;
  }
  async function navigate(url) { await save().catch(() => {}); location.href = url; }
  // Gallery's held-anchor restoration: align now and after layout/image changes,
  // then hand scrolling entirely to the user on their first input.
  function alignAnchor() {
    if (!heldAnchor?.node.isConnected) return;
    const rect = heldAnchor.node.getBoundingClientRect();
    const y = scrollY + rect.top + rect.height * heldAnchor.fraction;
    if (Math.abs(y - scrollY) > .5) scrollTo(0, Math.max(0, y));
  }
  function restore(view) {
    if (!touched && view) {
      const node = view.anchor && document.getElementById(view.anchor);
      if (node) { heldAnchor = { node, fraction: view.fraction }; alignAnchor(); }
      else scrollTo(0, view.y || 0);
    }
    restoring = false;
    requestAnimationFrame(() => { alignAnchor(); schedulePositionUpdate(); });
  }
  const positionResize = new ResizeObserver(() => {
    if (!heldAnchor) return;
    cancelAnimationFrame(anchorFrame); anchorFrame = requestAnimationFrame(alignAnchor);
  });
  positionResize.observe(app);
  addEventListener('touchstart', () => { touching = true; }, { passive: true });
  ['touchend', 'touchcancel'].forEach(type => addEventListener(type, () => { touching = false; }, { passive: true }));
  ['touchstart', 'pointerdown', 'wheel', 'keydown'].forEach(type => addEventListener(type, () => { touched = true; restoring = false; heldAnchor = null; }, { passive: true }));
  addEventListener('scroll', () => { lastScroll = Date.now(); }, { passive: true });
  const schedulePositionUpdate = ReaderCore.onSettledScroll(() => { save().catch(() => {}); });
  addEventListener('pagehide', () => { save().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) save().catch(() => {}); });
  addEventListener('pageshow', async event => {
    if (!event.persisted) return;
    state = await rpc('init'); skipPositionSave = !!state.resumeReader; await rpc('ready', { home });
    if (home) { renderCatalog(); void probePC(); } else schedulePositionUpdate();
  });
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a');
    if (anchor && anchor.origin === location.origin) { event.preventDefault(); navigate(anchor.href); }
  });
  function uploadedAt(value) {
    if (!value) return '';
    const stamp = new Date(value).getTime(); if (!Number.isFinite(stamp)) return value;
    const minutes = Math.floor(Math.max(0, Date.now() - stamp) / 60000);
    if (minutes < 1) return 'Just now'; if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24); if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7); return weeks === 1 ? 'last week' : `${weeks} weeks ago`;
  }
  function lockIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('hs-home-lock'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-label', 'Unavailable chapter');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z'); svg.append(path); return svg;
  }
  function chapterLink(series, chapter) {
    const link = el('a', 'chapter hs-home-chapter'), label = el('span', 'hs-home-chapter-label');
    label.append(el('span', '', `Chapter ${chapter.number}`));
    const p = state.progress[series.identity];
    const read = state.history[series.identity]?.[chapter.number] >= 0 || (p && Number(chapter.number) < Number(p.chapter));
    link.href = chapterURL(series.slug, chapter.number, p?.chapter === chapter.number);
    if (read && p?.chapter !== chapter.number) link.href += '?end=1';
    if (read) link.classList.add('hs-home-chapter-read');
    if (p?.chapter === chapter.number) link.classList.add(p.page >= p.total - 1 ? 'hs-home-chapter-read' : 'hs-home-chapter-partial');
    const time = el('time', '', uploadedAt(chapter.published));
    if (chapter.locked) {
      link.classList.add('hs-home-chapter-locked'); label.append(lockIcon());
      time.className = 'hs-home-unlock';
      const remaining = chapter.unlockAt ? Math.max(0, new Date(chapter.unlockAt).getTime() - Date.now()) : null;
      const hours = Math.floor(remaining / 3600000), minutes = Math.floor((remaining % 3600000) / 60000);
      time.textContent = remaining === null ? 'Locked' : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      link.onclick = event => { event.preventDefault(); event.stopPropagation(); };
    }
    link.append(label, time); return link;
  }
  async function first(series) {
    const list = await rpc('chapters', { slug: series.slug });
    if (list.length) await navigate(chapterURL(series.slug, list[0].number));
  }
  function renderCatalog() {
    const catalog = document.querySelector('.catalog'); if (!catalog) return;
    const signature = JSON.stringify([state.catalog, state.progress, state.history]);
    if (signature === catalogSignature) return; catalogSignature = signature;
    const view = position(), fragment = document.createDocumentFragment();
    for (const series of state.catalog) {
      const card = el('article', 'card hs-home-card'); card.id = 'series-' + series.identity;
      const cover = el('a', 'cover hs-home-cover'); cover.setAttribute('aria-label', `Resume ${series.title}`);
      const p = state.progress[series.identity]; cover.href = p ? chapterURL(series.slug, p.chapter, true) : '#';
      if (!p) cover.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        if (cover.classList.contains('hs-home-cover-loading')) return;
        cover.classList.add('hs-home-cover-loading');
        first(series).catch(() => { cover.classList.remove('hs-home-cover-loading'); cover.classList.add('hs-home-link-failed'); cover.title = 'Failed to open series'; });
      };
      const img = new Image(); img.alt = series.title; img.loading = 'lazy'; img.decoding = 'async'; img.src = new URL('/cover/' + series.slug, location.href).href; imageRetry.register(img); cover.append(img);
      const detail = el('div', 'hs-home-details'), chapters = el('div', 'chapters hs-home-chapters');
      for (const chapter of series.chapters.slice(-5).reverse()) chapters.append(chapterLink(series, chapter));
      if (!series.chapters.length) chapters.append(el('p', 'hs-home-no-chapters', 'No chapters available'));
      const links = el('div', 'hs-home-chapter'), firstButton = el('button', 'native-link', 'First chapter');
      firstButton.onclick = () => first(series).catch(error => report(error));
      links.append(firstButton); chapters.append(links); detail.append(chapters); card.append(cover, detail); fragment.append(card);
    }
    catalog.replaceChildren(fragment);
    const status = document.querySelector('.hs-home-catalog-status');
    if (status) status.textContent = state.catalog.length ? `Loaded ${state.catalog.length} of ${state.catalog.length} series` : 'Loading latest updates…';
    if (!restoring && view.anchor) { const anchor = document.getElementById(view.anchor); if (anchor) scrollTo(0, anchor.offsetTop + anchor.offsetHeight * view.fraction); }
  }
  async function probePC() {
    const controls = document.querySelector('.hs-home-pc');
    if (controls) controls.hidden = !(await rpc('pc-available').catch(() => false));
  }
  function manualPC(parent) {
    const controls = el('p', 'hs-home-pc'); controls.hidden = true;
    const status = el('span'); status.setAttribute('role', 'status');
    const buttons = ['Load', 'Save'].map(label => {
      const button = el('button', '', label);
      button.title = label === 'Load' ? 'Replace local reading state with the PC save' : 'Replace the PC save with local reading state';
      button.onclick = async () => {
        buttons.forEach(b => b.disabled = true); status.textContent = '';
        try {
          const result = await rpc(label === 'Load' ? 'pc-load' : 'pc-save');
          if (label === 'Load') { state = result; renderCatalog(); }
          status.textContent = label === 'Load' ? 'Loaded' : 'Saved';
        } catch (error) {
          await probePC();
          if (!controls.hidden) status.textContent = error?.message || 'PC request failed';
        } finally { buttons.forEach(b => b.disabled = false); }
      };
      controls.append(button); return button;
    });
    controls.append(status); parent.append(controls); void probePC();
  }
  function renderHome() {
    app.className = 'home hs-home'; app.replaceChildren();
    const section = el('section', 'hs-home-section'), catalog = el('div', 'catalog hs-home-list'), status = el('p', 'hs-home-catalog-status');
    section.append(catalog, status); app.append(section); manualPC(section); renderCatalog(); restore(state.home);
  }
  function appendChapter(m) {
    if (loadedChapters.has(m.chapter)) return;
    loadedChapters.add(m.chapter); currentManifest = m; document.title = `${m.chapter} ${m.title}`;
    const section = el('div', 'hs-chapter'); section.dataset.chapter = m.chapter;
    m.pages.forEach((page, index) => {
      const slot = el('div', 'page'); slot.id = `page-${m.chapter}-${index}`;
      if (page.width > 0 && page.height > 0) { slot.style.aspectRatio = `${page.width} / ${page.height}`; slot.dataset.measured = '1'; }
      else slot.style.height = '1000px';
      slot.dataset.index = index; slot.dataset.src = `/page/${m.slug}/${m.chapter}/${index}`; slot.manifest = m;
      section.append(slot); pages.push(slot);
    });
    app.append(section); for (const slot of section.querySelectorAll('.page')) observer.observe(slot);
    const at = m.chapters.findIndex(c => c.number === m.chapter), next = m.chapters[at + 1];
    if (next && at >= 0) {
      const end = el('div', 'chapter-sentinel'); app.append(end);
      let succeeded = false;
      section.appendNext = async () => {
        if (nextLoading || succeeded) return;
        nextLoading = true; end.className = 'hs-status hs-loading'; end.textContent = 'Loading newer chapter...';
        if (next.locked) {
          end.className = 'hs-status hs-error'; end.textContent = 'Chapter unavailable';
          succeeded = true; nextLoading = false; return;
        }
        try { const chapter = await rpc('open', { slug: m.slug, chapter: next.number });
          succeeded = true; end.remove(); appendChapter(chapter);
        } catch { end.className = 'hs-status hs-error'; end.textContent = 'Failed to load chapter'; succeeded = true; }
        finally { nextLoading = false; }
      };
    }
  }
  async function renderReader() {
    app.className = 'reader hs-reader-body'; app.replaceChildren();
    const [, slug, chapter] = route();
    observePages();
    const resume = new URLSearchParams(location.search).has('resume');
    const m = await rpc('open', { slug, chapter, resume }); appendChapter(m);
    const saved = new URLSearchParams(location.search).has('end') ? { page: m.pages.length - 1, fraction: 0 } : m.position;
    const view = new URLSearchParams(location.search).has('view') ? state.view : saved ? { anchor: `page-${chapter}-${Math.min(saved.page, m.pages.length - 1)}`, fraction: saved.fraction, y: 0 } : null;
    if (view && !touched) {
      const target = document.getElementById(view.anchor), index = pages.indexOf(target);
      // The userscript loads preceding unknown-size images before restoring.
      // Native storage can obtain their dimensions without decoding hidden DOM images.
      const unknown = pages.slice(0, index + 1).filter(slot => slot.dataset.measured !== '1');
      for (let start = 0; start < unknown.length && !touched; start += 3) {
        const sizes = await Promise.all(unknown.slice(start, start + 3).map(async slot => ({ slot, size: await rpc('measure', { slug, chapter, index: Number(slot.dataset.index) }).catch(() => null) })));
        if (touched) break;
        for (const { slot, size } of sizes) if (size?.width > 0 && size?.height > 0) {
          slot.style.aspectRatio = `${size.width} / ${size.height}`; slot.style.removeProperty('height'); slot.dataset.measured = '1';
        }
      }
    }
    restore(view);
    schedulePositionUpdate();
  }
  window.readerState = { save, probePC, update(next) {
    if (!home) return; state = next;
    // Keep a gesture stable: apply catalog changes only once scrolling has settled.
    clearTimeout(window.catalogUpdate);
    const apply = () => {
      if (touching || Date.now() - lastScroll < 250) { window.catalogUpdate = setTimeout(apply, 250); return; }
      if (home) renderCatalog();
    };
    window.catalogUpdate = setTimeout(apply, 250);
  } };
  (async () => {
    try {
      state = await rpc('init');
      // Gallery's bootstrap document can render for back navigation, but must
      // never checkpoint Home over the reader being restored on cold launch.
      skipPositionSave = !!state.resumeReader;
      if (home) {
        renderHome();
        if (state.resumeReader) { location.href = state.resumeReader + '?resume=1&view=1'; return; }
      } else await renderReader();
      await rpc('ready', { home });
    } catch (error) {
      app.replaceChildren(); app.className = ''; report(error);
    }
  })();
})();
