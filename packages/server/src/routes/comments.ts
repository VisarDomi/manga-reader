import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { CacheDataUnavailableError, type CommentsService } from '../services/CommentsService.js';

function jsonApiStatus(data: unknown): string {
    if (!data || typeof data !== 'object') return 'none';
    const status = (data as Record<string, unknown>).status;
    return status == null ? 'none' : String(status);
}

function commentsSummary(data: unknown): string {
    if (!data || typeof data !== 'object') return `type=${typeof data}`;
    const result = (data as Record<string, unknown>).result;
    if (!result || typeof result !== 'object') return `result=${result === null ? 'null' : typeof result}`;
    const r = result as Record<string, unknown>;
    const comments = Array.isArray(r.comments) ? r.comments.length : 0;
    const count = Number(r.count ?? comments);
    const upstreamCount = Number(r.upstreamCount ?? count);
    const thread = r.thread && typeof r.thread === 'object' ? (r.thread as Record<string, unknown>).id : null;
    const stats = r.stats && typeof r.stats === 'object' ? r.stats as Record<string, unknown> : {};
    const rootPages = Number(stats.rootPages ?? r.pages ?? 1);
    const replyPages = Number(stats.replyPages ?? 0);
    const treeFills = Number(stats.treeFills ?? 0);
    const unavailable = Number(stats.unavailable ?? 0);
    const unavailableRoots = Number(stats.unavailableRoots ?? 0);
    const total = Number(stats.total ?? comments);
    const maxDepth = Number(stats.maxDepth ?? 0);
    const missingReplies = Number(stats.missingReplies ?? 0);
    return `thread=${thread == null ? 'none' : thread} rootPages=${Number.isFinite(rootPages) ? rootPages : 1} replyPages=${Number.isFinite(replyPages) ? replyPages : 0} treeFills=${Number.isFinite(treeFills) ? treeFills : 0} top=${comments} total=${Number.isFinite(total) ? total : comments} maxDepth=${Number.isFinite(maxDepth) ? maxDepth : 0} missingReplies=${Number.isFinite(missingReplies) ? missingReplies : 0} unavailable=${Number.isFinite(unavailable) ? unavailable : 0} unavailableRoots=${Number.isFinite(unavailableRoots) ? unavailableRoots : 0} count=${Number.isFinite(count) ? count : comments} upstreamCount=${Number.isFinite(upstreamCount) ? upstreamCount : comments}`;
}

export function createCommentsRouter(commentsService: CommentsService | null): Router {
    const router = Router();

    router.get('/manga-comments/:mangaId', asyncHandler(async (req, res) => {
        const rawMangaId = req.params.mangaId;
        const mangaId = typeof rawMangaId === 'string' ? rawMangaId : undefined;
        if (!mangaId) {
            res.status(400).json({ error: 'Missing mangaId' });
            return;
        }

        if (!commentsService) {
            res.status(503).json({ error: 'Comments service unavailable' });
            return;
        }

        res.set('Cache-Control', 'no-store');
        let result;
        try {
            result = await commentsService.fetchMangaComments(mangaId);
        } catch (error) {
            if (error instanceof CacheDataUnavailableError) {
                res.status(503).json({ error: error.message });
                return;
            }
            throw error;
        }
        console.log(`[comments] manga ${mangaId} api=${jsonApiStatus(result.data)} ${commentsSummary(result.data)} ${result.durationMs}ms`);
        res.json(result.data);
    }));

    router.get('/chapter-comments/:mangaId/:chapterId', asyncHandler(async (req, res) => {
        const rawMangaId = req.params.mangaId;
        const rawChapterId = req.params.chapterId;
        const mangaId = typeof rawMangaId === 'string' ? rawMangaId : undefined;
        const chapterId = typeof rawChapterId === 'string' ? rawChapterId : undefined;
        const chapterNumber = Number(req.query.number);
        const chapterUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
        if (!mangaId || !chapterId || !Number.isFinite(chapterNumber)) {
            res.status(400).json({ error: 'Missing mangaId, chapterId, or number' });
            return;
        }

        if (!commentsService) {
            res.status(503).json({ error: 'Comments service unavailable' });
            return;
        }

        res.set('Cache-Control', 'no-store');
        let result;
        try {
            result = await commentsService.fetchChapterComments(mangaId, chapterId, chapterNumber, chapterUrl);
        } catch (error) {
            if (error instanceof CacheDataUnavailableError) {
                res.status(503).json({ error: error.message });
                return;
            }
            throw error;
        }
        console.log(`[comments] chapter ${mangaId}/${chapterId} number=${chapterNumber} api=${jsonApiStatus(result.data)} ${commentsSummary(result.data)} ${result.durationMs}ms`);
        res.json(result.data);
    }));

    return router;
}
