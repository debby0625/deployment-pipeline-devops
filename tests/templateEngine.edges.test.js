import { describe, expect, test } from 'vitest';
import { extractEventData, getEventAction, applyTemplate } from '../src/utils/templateEngine.js';

function event(type, payload = {}, extra = {}) {
  return { type, payload, public: true, repo: { name: 'fixture/activity' }, created_at: '2026-10-15T00:00:00Z', ...extra };
}

describe('event links, fallback branches and privacy', () => {
  test.each([
    ['CommitCommentEvent', { comment: { commit_id: 'abc', id: 9 } }, '/commit/abc#commitcomment-9'],
    ['PullRequestReviewEvent', { review: { html_url: 'https://example.test/review' } }, 'https://example.test/review'],
    ['PullRequestReviewEvent', { pull_request: { number: 3 } }, '/pull/3'],
    ['PullRequestReviewEvent', {}, ''],
    ['PullRequestReviewCommentEvent', { comment: { id: 8 }, pull_request: { number: 3 } }, '/pull/3#pullrequestreviewcomment-8'],
    ['PullRequestReviewThreadEvent', { thread: { id: 7 }, pull_request: { number: 3 } }, '/pull/3#discussion_r_7'],
    ['CreateEvent', { ref_type: 'branch', ref: 'feature' }, '/tree/feature'],
    ['CreateEvent', { ref_type: 'branch' }, ''],
    ['CreateEvent', { ref_type: 'tag' }, ''],
    ['CreateEvent', { ref_type: 'repository' }, ''],
    ['CreateEvent', {}, ''],
    ['ReleaseEvent', { release: { draft: true } }, ''],
    ['ReleaseEvent', { release: { tag_name: 'v1' } }, '/releases/tag/v1'],
    ['ReleaseEvent', { release: {} }, ''],
  ])('%s chooses its event URL (%j)', (type, payload, suffix) => {
    const expected = suffix.startsWith('https:') ? suffix : `https://github.com/fixture/activity${suffix}`;
    expect(extractEventData(event(type, payload), {}).url).toBe(expected);
  });

  test.each([
    ['GollumEvent', { pages: [{ action: 'created' }, { action: 'edited' }] }, '2 pages (+1 new page)'],
    ['GollumEvent', { pages: [{ action: 'edited' }] }, '1 page'],
    ['GollumEvent', { pages: [{ action: 'created' }, { action: 'created' }] }, '2 pages (+2 new pages)'],
    ['GollumEvent', { pages: [{ action: 'deleted' }] }, 'wiki pages'],
    ['GollumEvent', {}, 'wiki pages'],
    ['DeleteEvent', {}, 'a ref'],
    ['IssueCommentEvent', { issue: { pull_request: {}, number: 5 } }, 'on PR'],
    ['IssueCommentEvent', { issue: { pull_request: {} } }, 'on a PR'],
    ['PullRequestReviewCommentEvent', {}, 'on a review of a PR'],
  ])('%s produces a readable subject (%j)', (type, payload, subject) => {
    expect(extractEventData(event(type, payload), {}).subject).toBe(subject);
  });

  test('normalizes unknown action names and ignores an unmapped emoji action', () => {
    expect(extractEventData(event('CustomEvent', { action: 'did_something', ref: 'custom' }), { CustomEvent: { another: '?' } }))
      .toMatchObject({ action: 'Did something', ref: 'custom', emoji: '' });
  });
  test('uses generic comment wording', () => {
    expect(extractEventData(event('CommitCommentEvent', { action: 'custom_action' }), {}).action).toBe('Commented');
    expect(extractEventData(event('PullRequestReviewCommentEvent', { action: 'custom_action' }), {}).action).toBe('Commented');
  });
  test('falls back to an empty emoji for an invalid emoji mapping', () => {
    expect(extractEventData(event('PushEvent'), { PushEvent: 4 }).emoji).toBe('');
  });
  test('resolves every default event action', () => {
    for (const type of ['PublicEvent', 'CommitCommentEvent', 'IssueCommentEvent', 'PullRequestReviewEvent', 'PullRequestReviewCommentEvent', 'PullRequestReviewThreadEvent', 'RepositoryEvent', 'GollumEvent']) {
      expect(getEventAction(type, {})).not.toBe('performed action');
    }
  });
  test('renders every supported placeholder without modifying literals', () => {
    expect(applyTemplate('{event_type} {verb} {repo_url} {date} {ref_type}', {
      event_type: 'PushEvent', verb: 'in', repo_url: 'https://example.test', date: 'today', ref_type: 'branch',
    })).toBe('PushEvent in https://example.test today branch');
  });
});
