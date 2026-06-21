import { thumbUrl, readerUrl, type GalleryFile } from '../provider';
import {isFav, toggleFav} from '../storage/db';
import {show as showInfo} from './info-modal';

const SKELETON_HEIGHT = 300;

export function createSkeletonRow(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'hs-row-wrap';
    wrap.style.height = SKELETON_HEIGHT + 'px';
    return wrap;
}

export function populateRow(
    container: HTMLDivElement,
    gid: number,
    files: GalleryFile[],
): void {
    container.innerHTML = '';
    container.style.height = '';

    const strip = document.createElement('div');
    strip.className = 'hs-row';

    for (let i = 0; i < files.length; i++) {
        const img = document.createElement('img');
        img.className = 'hs-thumb';
        img.loading = 'lazy';
        img.src = thumbUrl(files[i]);
        img.onclick = () => {
            window.location.href = readerUrl(gid, i);
        };
        strip.appendChild(img);
    }
    container.appendChild(strip);

    const overlay = document.createElement('div');
    overlay.className = 'row-title-overlay';
    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const infoBtn = document.createElement('button');
    infoBtn.className = 'row-action-btn info-btn';
    infoBtn.textContent = 'i';
    infoBtn.onclick = (e) => {
        e.stopPropagation();
        void showInfo(gid);
    };
    actions.appendChild(infoBtn);

    const favBtn = document.createElement('button');
    favBtn.className = 'row-action-btn';
    favBtn.textContent = '...';
    void isFav(gid).then(f => {
        favBtn.textContent = f ? '\u2764\uFE0F' : '\uD83E\uDD0D';
    });
    favBtn.onclick = (e) => {
        e.stopPropagation();
        void toggleFav(gid).then(f => {
            favBtn.textContent = f ? '\u2764\uFE0F' : '\uD83E\uDD0D';
        });
    };
    actions.appendChild(favBtn);

    overlay.appendChild(actions);
    container.appendChild(overlay);
}
