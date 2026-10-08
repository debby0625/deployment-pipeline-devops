import { describe, expect, test } from 'bun:test';
import {
    applyTemplate,
    extractEventData,
    getEventAction,
} from '../src/utils/templateEngine.js';

const repoName = 'debby0625/deployment-pipeline-devops';
const repoUrl = `https://github.com/${repoName}`;
const emojiMap = {
    PushEvent: '🚀',
    PullRequestEvent: { opened: '🆕', merged: '🔀', closed: '❌' },
    ReleaseEvent: { draft: '📝', published: '📦' },
};

function makeEvent(type, payload = {}, overrides = {}) {
    return {
        type,
        public: true,
        repo: { name: repoName },
        created_at: '2026-10-08T23:30:00Z',
        payload,
        ...overrides,
    };
}

describe('applyTemplate', () => {
    test('renders a public activity with a Markdown link', () => {
        expect(applyTemplate('{emoji} {action} [{repo}]({url})', {
            emoji: '🚀', action: 'Committed to', repo: repoName, url: repoUrl,
        })).toBe(`🚀 Committed to [${repoName}](${repoUrl})`);
    });

    test('replaces every occurrence of a placeholder', () => {
        expect(applyTemplate('{ref} → {ref}', { ref: 'main' })).toBe('main → main');
    });

    test('preserves literal dollar replacement characters', () => {
        expect(applyTemplate('{repo}', { repo: '$& $$ $1' })).toBe('$& $$ $1');
    });

    test.each(['', null, undefined, 42, {}])('rejects invalid template %p', (template) => {
        expect(applyTemplate(template, {})).toBeNull();
    });

    test('removes missing optional values and empty parentheses', () => {
        expect(applyTemplate('{emoji} {action} ({ref}) {number} in {repo}', {
            action: 'Updated', repo: repoName,
        })).toBe(`Updated in ${repoName}`);
    });

    test('renders missing URLs as text instead of a broken Markdown link', () => {
        expect(applyTemplate('[{repo}]({url})', {
            repo: 'a private repository', url: '',
        })).toBe('a private repository');
    });

    test('preserves unrelated literal spacing and unknown placeholders', () => {
        expect(applyTemplate('  Keep  two spaces {unknown} {action}  ', {
            action: 'Updated',
        })).toBe('Keep  two spaces {unknown} Updated');
    });
});

describe('getEventAction', () => {
    test.each([
        ['PushEvent', {}, 'committed'],
        ['CreateEvent', {}, 'created'],
        ['DeleteEvent', {}, 'deleted'],
        ['ForkEvent', {}, 'forked'],
        ['WatchEvent', { action: 'started' }, 'watched'],
        ['StarEvent', { action: 'created' }, 'starred'],
        ['ReleaseEvent', { release: { draft: true } }, 'draft'],
        ['ReleaseEvent', { release: { draft: false } }, 'published'],
        ['IssuesEvent', { action: 'reopened' }, 'reopened'],
        ['UnknownEvent', {}, 'performed action'],
    ])('%s resolves the expected action', (type, payload, expected) => {
        expect(getEventAction(type, payload)).toBe(expected);
    });

    test('identifies a merged PR even when its raw action is closed', () => {
        expect(getEventAction('PullRequestEvent', {
            action: 'closed', pull_request: { merged: true },
        })).toBe('merged');
    });

    test('distinguishes an unmerged closed PR', () => {
        expect(getEventAction('PullRequestEvent', {
            action: 'closed', pull_request: { merged: false },
        })).toBe('closed');
    });
});

describe('extractEventData', () => {
    test('extracts push data, strips the branch prefix, and formats the date in UTC', () => {
        expect(extractEventData(makeEvent('PushEvent', {
            head: 'abc123', ref: 'refs/heads/main',
        }), emojiMap)).toEqual({
            emoji: '🚀', event_type: 'PushEvent', action: 'Committed to',
            verb: 'in', subject: '', repo: repoName, repo_url: repoUrl,
            date: 'Oct 8, 2026', number: '', url: `${repoUrl}/commit/abc123`,
            ref: 'main', ref_type: '',
        });
    });

    test('extracts merged PR number, URL, subject, and emoji', () => {
        expect(extractEventData(makeEvent('PullRequestEvent', {
            action: 'closed', pull_request: { merged: true, number: 7 },
        }), emojiMap)).toMatchObject({
            action: 'Merged', subject: 'PR', number: '#7',
            emoji: '🔀', url: `${repoUrl}/pull/7`,
        });
    });

    test('hides private repository names, links, and issue numbers', () => {
        const data = extractEventData(makeEvent('IssuesEvent', {
            action: 'opened', issue: { number: 42 },
        }, { public: false, repo: { name: 'owner/confidential-project' } }), emojiMap);
        expect(data).toMatchObject({
            repo: 'a private repository', repo_url: '', number: '', url: '',
        });
        expect(applyTemplate('{action} {subject} {number} in [{repo}]({url})', data))
            .toBe('Opened issue in a private repository');
    });

    test('hides private branch names when the privacy option is enabled', () => {
        const event = makeEvent('PushEvent', {
            ref: 'refs/heads/confidential-feature', head: 'secret-sha',
        }, { public: false });
        const data = extractEventData(event, emojiMap, true);
        expect(data.ref).toBe('');
        const rendered = applyTemplate('{action} {ref} in [{repo}]({url})', data);
        expect(rendered).toBe('Committed to in a private repository');
        expect(rendered).not.toContain('confidential-feature');
        expect(rendered).not.toContain('secret-sha');
    });

    test('retains private branch details when the privacy option is disabled', () => {
        const event = makeEvent('PushEvent', {
            ref: 'refs/heads/feature',
        }, { public: false });
        expect(extractEventData(event, emojiMap).ref).toBe('feature');
        expect(extractEventData(event, emojiMap, false).ref).toBe('feature');
    });

    test('creates a tag URL and normalizes the tag reference', () => {
        expect(extractEventData(makeEvent('CreateEvent', {
            ref_type: 'tag', ref: 'v1.2.3',
        }), emojiMap)).toMatchObject({
            action: 'Created', subject: 'a new tag', ref: 'v1.2.3',
            ref_type: 'tag', url: `${repoUrl}/releases/tag/v1.2.3`,
        });
        expect(extractEventData(makeEvent('DeleteEvent', {
            ref_type: 'tag', ref: 'refs/tags/v1.2.3',
        }), emojiMap).ref).toBe('v1.2.3');
    });

    test('uses a supplied release URL and the published emoji fallback', () => {
        const releaseUrl = `${repoUrl}/releases/tag/v2.0.0`;
        expect(extractEventData(makeEvent('ReleaseEvent', {
            action: 'edited', release: { draft: false, tag_name: 'v2.0.0', html_url: releaseUrl },
        }), emojiMap)).toMatchObject({
            action: 'Edited', emoji: '📦', ref: 'v2.0.0', url: releaseUrl,
        });
    });

    test('uses an issue comment anchor URL', () => {
        expect(extractEventData(makeEvent('IssueCommentEvent', {
            action: 'created', issue: { number: 8 }, comment: { id: 99 },
        }), emojiMap)).toMatchObject({
            action: 'Commented', subject: 'on issue', number: '#8',
            url: `${repoUrl}/issues/8#issuecomment-99`,
        });
    });

    test('falls back to the repository URL when a push has no head', () => {
        expect(extractEventData(makeEvent('PushEvent'), {}).url).toBe(repoUrl);
        expect(extractEventData(makeEvent('PushEvent'), {}).emoji).toBe('');
    });
});
