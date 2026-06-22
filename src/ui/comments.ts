import type { MangaComment } from '../provider';

const DEPTH_LIMIT = 4;
const INDENT = 20;

function formatTime(iso: string): string {
    const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
    if (hours < 1) return 'just now';
    if (hours < 24) return `${Math.floor(hours)}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

function renderComment(comment: MangaComment, depth: number): HTMLElement {
    const visualDepth = Math.min(depth, DEPTH_LIMIT);
    const article = document.createElement('article');
    article.className = 'hs-comment';
    article.style.marginLeft = `${visualDepth * INDENT}px`;

    const main = document.createElement('div');
    main.className = 'hs-comment-main';

    const avatar = document.createElement('div');
    avatar.className = 'hs-comment-avatar';
    if (comment.avatar) {
        const img = document.createElement('img');
        img.src = comment.avatar;
        img.alt = '';
        img.loading = 'lazy';
        avatar.appendChild(img);
    } else {
        const span = document.createElement('span');
        span.textContent = comment.author.charAt(0).toUpperCase();
        avatar.appendChild(span);
    }
    main.appendChild(avatar);

    const body = document.createElement('div');
    body.className = 'hs-comment-body';

    const meta = document.createElement('div');
    meta.className = 'hs-comment-meta';

    const author = document.createElement('span');
    author.className = 'hs-comment-author';
    author.textContent = comment.author;
    meta.appendChild(author);

    const time = document.createElement('span');
    time.className = 'hs-comment-time';
    time.textContent = formatTime(comment.createdAt);
    meta.appendChild(time);

    body.appendChild(meta);

    const content = document.createElement('div');
    content.className = 'hs-comment-content';
    content.innerHTML = comment.content;
    body.appendChild(content);

    main.appendChild(body);
    article.appendChild(main);

    if (comment.replies.length > 0) {
        const replies = document.createElement('div');
        replies.className = 'hs-comment-replies';
        for (const reply of comment.replies) {
            replies.appendChild(renderComment(reply, depth + 1));
        }
        article.appendChild(replies);
    }

    return article;
}

export function renderComments(container: HTMLElement, comments: MangaComment[]): void {
    container.innerHTML = '';

    if (comments.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'hs-comments-error';
        msg.textContent = 'Comments unavailable';
        container.appendChild(msg);
        return;
    }

    const section = document.createElement('section');
    section.className = 'hs-comments-section';

    const heading = document.createElement('h2');
    heading.className = 'hs-comments-heading';
    heading.textContent = `Comments (${comments.length})`;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'hs-comments-list';
    for (const comment of comments) {
        list.appendChild(renderComment(comment, 0));
    }
    section.appendChild(list);

    container.appendChild(section);
}
