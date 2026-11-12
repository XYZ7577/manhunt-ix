import type { Account, Submission } from '../../shared/types';
import { privateError as fail, privateJson as json } from '../http/responses';
import { loadAdminSubmission, loadAdminSubmissionPage, type AdminSubmissionEnv } from './adminDashboard';

type SubmissionShaper = (row: any, includeMetadata?: boolean) => Promise<Submission>;

async function getSubmission(db: D1Database, submissionId: string) {
    return db.prepare('SELECT * FROM submissions WHERE id=?').bind(submissionId).first<any>();
}

export async function handleAdminSubQueries(
    request: Request,
    env: AdminSubmissionEnv,
    account: Account,
    shapeSubmission: SubmissionShaper,
): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (pathname === '/api/admin/submissions' && method === 'GET') {
        if (account.role !== 'admin') return fail('Admin access required.', 403);

        const page = await loadAdminSubmissionPage(request, env);
        if (!page) return fail('Invalid review queue filters or page.', 400);
        return json(page);
    }

    const subMatch = pathname.match(/^\/api\/admin\/submissions\/([^/]+)$/);
    if (subMatch && method === 'GET') {
        if (account.role !== 'admin') return fail('Admin access required.', 403);

        const submission = await loadAdminSubmission(subMatch[1], env, shapeSubmission);
        if (!submission) return fail('Submission not found.', 404);
        return json({ submission });
    }

    return null;
}

export async function handleSubReviews(
    request: Request,
    env: AdminSubmissionEnv,
    account: Account,
    shapeSubmission: SubmissionShaper,
    dispatchReviewAlerts: () => Promise<void>,
): Promise<Response | null> {
    const pathname = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    const reviewRoute = pathname.match(/^\/api\/submissions\/([^/]+)\/(review|decision|feedback)$/);
    if (!reviewRoute) return null;

    const [, submissionId, action] = reviewRoute;
    const isReview = action === 'review' && method === 'POST';
    const isDecisionChange = action === 'decision' && method === 'PATCH';
    const isFeedbackEdit = action === 'feedback' && method === 'PATCH';
    if (!isReview && !isDecisionChange && !isFeedbackEdit) return null;
    if (account.role !== 'admin') return fail('Admin access required.', 403);

    if (isReview) {
        const body = await request.json<any>().catch(() => null);
        const decision = body?.decision;
        const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : '';
        if (decision !== 'approved' && decision !== 'changes_requested')
            return fail('Choose approved or changes_requested.');
        if (decision === 'changes_requested' && !note)
            return fail('Give the group a reason and what to replace.');

        const submission = await getSubmission(env.DB, submissionId);
        if (!submission || submission.status !== 'pending') return fail('Pending submission not found.', 404);

        const result = await env.DB.prepare(
            "UPDATE submissions SET status=?,review_note=?,reviewed_at=?,reviewed_by=? WHERE id=? AND status='pending'",
        )
            .bind(decision, note || null, new Date().toISOString(), account.id, submission.id)
            .run();
        if (!result.meta.changes) return fail('Another admin already reviewed this submission.', 409);

        await dispatchReviewAlerts();
        return json({
            submission: await shapeSubmission(await getSubmission(env.DB, submission.id), true),
        });
    }

    if (isDecisionChange) {
        const body = await request.json<any>().catch(() => null);
        const prevStatus = body?.previousStatus;
        if (prevStatus !== 'approved' && prevStatus !== 'changes_requested')
            return fail('Include the current Approved or Denied decision.');

        const submission = await getSubmission(env.DB, submissionId);
        if (!submission) return fail('Submission not found.', 404);
        if (submission.status !== prevStatus)
            return fail('The decision has changed. Refresh to see the latest review.', 409);

        const decision = prevStatus === 'approved' ? 'changes_requested' : 'approved';
        const result = await env.DB.prepare(
            'UPDATE submissions SET status=?,reviewed_at=?,reviewed_by=? WHERE id=? AND status=? AND NOT EXISTS (SELECT 1 FROM submissions newer WHERE newer.group_id=submissions.group_id AND newer.task_id=submissions.task_id AND newer.attempt>submissions.attempt)',
        )
            .bind(decision, new Date().toISOString(), account.id, submission.id, prevStatus)
            .run();
        if (!result.meta.changes)
            return fail('A newer attempt or decision exists. Refresh and review the latest attempt.', 409);

        await dispatchReviewAlerts();
        return json({
            submission: await shapeSubmission(await getSubmission(env.DB, submission.id), true),
        });
    }

    const body = await request.json<any>().catch(() => null);
    if (
        typeof body?.note !== 'string' ||
        body.note.length > 2000 ||
        (body.previousNote !== null && typeof body.previousNote !== 'string')
    ) {
        return fail('Enter feedback of up to 2,000 characters and include the previous feedback.');
    }

    const submission = await getSubmission(env.DB, submissionId);
    if (!submission) return fail('Submission not found.', 404);
    if (submission.status !== 'approved' && submission.status !== 'changes_requested')
        return fail('Review this submission before editing its feedback.', 409);

    const note = body.note.trim();
    if (submission.status === 'changes_requested' && !note)
        return fail('Keep a reason explaining what the group needs to replace.');

    const result = await env.DB.prepare(
        "UPDATE submissions SET review_note=? WHERE id=? AND status IN ('approved','changes_requested') AND review_note IS ?",
    )
        .bind(note || null, submission.id, body.previousNote)
        .run();
    if (!result.meta.changes) {
        return fail(
            'The feedback was updated by another admin. Cancel and reopen the editor to use the latest feedback.',
            409,
        );
    }

    await dispatchReviewAlerts();
    return json({
        submission: await shapeSubmission(await getSubmission(env.DB, submission.id), true),
    });
}
