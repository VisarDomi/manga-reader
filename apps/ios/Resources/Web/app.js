'use strict';
(() => {
  const app = document.querySelector('#app');
  const documentID = crypto.randomUUID();
  const rpc = async (command, args = {}) => JSON.parse(await window.webkit.messageHandlers.asura.postMessage({ command, args, document: documentID }));
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const route = () => location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const identity = slug => state?.provider !== 'asurascans' ? slug : slug.replace(/-[0-9a-f]{8}$/i, '');
  const chapterID = chapter => chapter.id ?? chapter.number;
  const chapterURL = (slug, chapter, resume = false) => `/reader/${encodeURIComponent(slug)}/${encodeURIComponent(chapter)}${resume ? '?resume=1' : ''}`;
  let touching = false, skipPositionSave = false, heldAnchor, anchorFrame, trackingFailed = false;
  let lastSavedCheckpoint = '';
  let state, home = route().length === 0, restoring = true, touched = false, currentManifest, saveChain = Promise.resolve();
  let chapterList = [], pages = [], observer, nextLoading = false, loadedChapters = new Set();
  const imageRetry = new ReaderCore.ImageRetryRegistry();
  let activeImages = 0, imageQueue = [], imageGeneration = 0, catalogSignature = "";
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
      while (index >= 0) {
        const image = nodes[index].querySelector('img');
        if (image?.complete && image.naturalWidth > 0 && nodes[index].getBoundingClientRect().top <= at) break;
        index--;
      }
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
        document.title = `${m.chapter} ${m.title}`;
      }
    }
    if (progress && currentManifest?.chapter === progress.chapter) {
      [...document.querySelectorAll('.hs-chapter')].at(-1)?.appendNext?.();
    }
    const checkpoint = JSON.stringify([view, progress && [progress.slug, progress.chapter, progress.page, progress.fraction, progress.total]]);
    saveChain = saveChain.catch(() => {}).then(async () => {
      if (lastSavedCheckpoint === checkpoint) return;
      await rpc('view-save', { view, progress });
      lastSavedCheckpoint = checkpoint;
    }).catch(error => {
      if (progress) trackingError();
      throw error;
    });
    return saveChain;
  }
  function trackingError() {
    if (!trackingFailed) { trackingFailed = true; report(new Error('Progress sync failed')); }
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
  const schedulePositionUpdate = ReaderCore.onSettledScroll(() => { save().catch(() => {}); });
  addEventListener('pagehide', () => { save().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) save().catch(() => {}); });
  addEventListener('pageshow', async event => {
    if (!event.persisted) return;
    lastSavedCheckpoint = '';
    state = await rpc('init'); skipPositionSave = !!state.resumeReader; await rpc('ready', { home });
    if (home) {
      for (const cover of app.querySelectorAll('.hs-home-cover-loading')) cover.classList.remove('hs-home-cover-loading');
      renderCatalog(); void probePC();
    } else schedulePositionUpdate();
  });
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a');
    if (anchor && anchor.origin === location.origin) { event.preventDefault(); navigate(anchor.href); }
  });
  function lockIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('hs-home-lock'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-label', 'Unavailable chapter');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z'); svg.append(path); return svg;
  }
  function chapterLink(series, chapter, resolved) {
    const link = el('a', 'chapter hs-home-chapter'), label = el('span', 'hs-home-chapter-label');
    label.append(el('span', '', chapter.label ?? `Chapter ${chapter.number}`));
    const resume = resolved.localImageIndex !== undefined;
    link.href = chapterURL(series.slug, chapterID(chapter), resume);
    if (resolved.read && !resume) link.href += '?end=1';
    if (resolved.read) link.classList.add('hs-home-chapter-read');
    if (resolved.partial) link.classList.add('hs-home-chapter-partial');
    const time = el('time', '', ReaderCore.formatUploadedAt(chapter.published ?? null));
    if (chapter.locked) {
      link.classList.add('hs-home-chapter-locked'); label.append(lockIcon());
      time.className = 'hs-home-unlock';
      if (chapter.unlockAt) time.dataset.unlockAt = chapter.unlockAt;
      time.textContent = chapter.unlockAt ? ReaderCore.unlockCountdown(chapter.unlockAt) : 'Locked';
      link.onclick = event => { event.preventDefault(); event.stopPropagation(); };
    }
    link.append(label, time); return link;
  }
  async function first(series) {
    const list = await rpc('chapters', { slug: series.slug });
    if (list.length) await navigate(chapterURL(series.slug, chapterID(list[0])));
  }
  function renderCatalog() {
    const catalog = document.querySelector('.catalog'); if (!catalog) return;
    const status = document.querySelector('.hs-home-catalog-status');
    if (status) {
      status.classList.toggle('hs-error', !!state.catalogError);
      status.textContent = state.catalogError || (state.catalog.length || state.catalogLoaded !== undefined
        ? ReaderCore.statusText(state.catalogLoaded ?? state.catalog.length, state.catalogTotal, !!state.catalogLoading)
        : 'Loading latest updates…');
    }
    const signature = JSON.stringify([state.catalog, state.progress]);
    if (signature === catalogSignature) return; catalogSignature = signature;
    const cards = [];
    for (const series of state.catalog) {
      const p = state.progress[series.identity], key = 'series-' + series.identity;
      const visible = series.chapters.slice(-5).reverse();
      const [resolved] = ReaderCore.resolveHistory({
        cards: [{ seriesSlug: series.slug, historyId: series.identity, chapterIds: visible.map(chapterID) }],
        progress: p ? [{ seriesSlug: series.identity, chapterId: p.chapter, imageIndex: p.page, totalImages: p.total }] : [],
      });
      // Compare rendered values, not snapshot key order or progress timestamps.
      const chapterSignature = JSON.stringify([series.slug, visible.map((chapter, index) => [
        chapterID(chapter), chapter.label ?? `Chapter ${chapter.number}`, chapter.published ?? null,
        !!chapter.locked, chapter.unlockAt ?? null, resolved.chapters[index].read,
        resolved.chapters[index].partial, resolved.chapters[index].localImageIndex !== undefined,
      ])]);
      const coverChapter = p?.chapter;
      const cardSignature = JSON.stringify([series.slug, series.title, series.cover, coverChapter ?? null, chapterSignature]);
      let card = document.getElementById(key);
      if (card?.dataset.signature === cardSignature) { cards.push(card); continue; }
      if (!card) {
        card = el('article', 'card hs-home-card'); card.id = key;
        const cover = el('a', 'cover hs-home-cover'), img = new Image();
        img.loading = 'lazy'; img.decoding = 'async'; cover.append(img);
        const detail = el('div', 'hs-home-details'); detail.append(el('div', 'chapters hs-home-chapters'));
        card.append(cover, detail);
      }
      card.dataset.signature = cardSignature;
      const cover = card.querySelector('.cover'), img = cover.querySelector('img');
      cover.setAttribute('aria-label', `Resume ${series.title}`);
      cover.href = coverChapter ? chapterURL(series.slug, coverChapter, true) : '#';
      cover.onclick = coverChapter ? null : event => {
        event.preventDefault(); event.stopPropagation();
        if (cover.classList.contains('hs-home-cover-loading')) return;
        cover.classList.add('hs-home-cover-loading');
        first(series).catch(() => { cover.classList.remove('hs-home-cover-loading'); cover.classList.add('hs-home-link-failed'); cover.title = 'Failed to open series'; });
      };
      if (coverChapter) { cover.classList.remove('hs-home-cover-loading', 'hs-home-link-failed'); cover.removeAttribute('title'); }
      img.alt = series.title;
      const coverSource = JSON.stringify([series.slug, series.cover]);
      if (img.dataset.source !== coverSource) {
        img.dataset.source = coverSource;
        img.src = new URL('/cover/' + encodeURIComponent(series.slug) + '?v=' + encodeURIComponent(series.cover ?? ''), location.href).href;
        imageRetry.register(img);
      }
      const chapters = card.querySelector('.chapters');
      if (chapters.dataset.signature !== chapterSignature) {
        chapters.dataset.signature = chapterSignature;
        chapters.replaceChildren(...visible.map((chapter, index) => chapterLink(series, chapter, resolved.chapters[index])));
        if (!visible.length) chapters.append(el('p', 'hs-home-no-chapters', 'No chapters available'));
        const links = el('div', 'hs-home-chapter'), firstButton = el('button', 'native-link', 'First chapter');
        firstButton.onclick = () => first(series).catch(error => report(error));
        links.append(firstButton); chapters.append(links);
      }
      cards.push(card);
    }
    const keep = new Set(cards);
    for (const child of [...catalog.children]) if (!keep.has(child)) child.remove();
    cards.forEach((card, index) => { if (catalog.children[index] !== card) catalog.insertBefore(card, catalog.children[index] ?? null); });
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
          if (label === 'Load') { lastSavedCheckpoint = ''; state = result; renderCatalog(); }
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
    setInterval(() => {
      for (const time of section.querySelectorAll('time[data-unlock-at]')) time.textContent = ReaderCore.unlockCountdown(time.dataset.unlockAt);
    }, 60000);
  }
  function appendChapter(m) {
    if (loadedChapters.has(m.chapter)) return;
    loadedChapters.add(m.chapter); currentManifest = m;
    if (loadedChapters.size === 1) document.title = `${m.chapter} ${m.title}`;
    const section = el('div', 'hs-chapter'); section.dataset.chapter = m.chapter;
    m.pages.forEach((page, index) => {
      const slot = el('div', 'page'); slot.id = `page-${m.chapter}-${index}`;
      if (page.width > 0 && page.height > 0) { slot.style.aspectRatio = `${page.width} / ${page.height}`; slot.dataset.measured = '1'; }
      else slot.style.height = '1000px';
      slot.dataset.index = index; slot.dataset.src = `/page/${encodeURIComponent(m.slug)}/${encodeURIComponent(m.chapter)}/${index}`; slot.manifest = m;
      section.append(slot); pages.push(slot);
    });
    app.append(section); for (const slot of section.querySelectorAll('.page')) observer.observe(slot);
    section.manifest = m;
    attachNext(section);
  }
  function attachNext(section) {
    const m = section.manifest;
    const at = chapterList.findIndex(c => chapterID(c) === m.chapter), next = chapterList[at + 1];
    if (next && at >= 0) {
      const end = el('div', 'chapter-sentinel'); app.append(end);
      let succeeded = false;
      section.appendNext = async () => {
        if (nextLoading || succeeded) return;
        nextLoading = true; end.className = 'hs-status hs-loading'; end.textContent = 'Loading newer chapter...';
        try { const chapter = await rpc('open', { slug: m.slug, chapter: chapterID(next), append: true });
          if (chapter.unavailable) { end.className = 'hs-status hs-error'; end.textContent = 'Chapter unavailable'; succeeded = true; return; }
          if (chapter.chapter !== chapterID(next) || chapter.slug !== m.slug) throw new Error('Unexpected chapter');
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
    const listStatus = el('div', 'hs-status hs-loading', 'Loading chapters...'); app.append(listStatus);
    void rpc('chapters', { slug }).then(list => {
      const ids = list.map(chapterID);
      if (new Set(ids).size !== ids.length || !ids.includes(chapter)) throw new Error('Invalid chapter list');
      chapterList = list; listStatus.remove();
      for (const section of document.querySelectorAll('.hs-chapter')) attachNext(section);
      schedulePositionUpdate();
    }).catch(() => { listStatus.className = 'hs-status hs-error'; listStatus.textContent = 'Failed to load chapter list'; });
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
    renderCatalog();
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
