/**
 * POST /topics - Claude suggests new conversation topics for the daily video.
 *
 * Called by the daily workflow once 90% of topics/pool.json has been used. It
 * only suggests: the workflow's Merge Topics node filters duplicates and odd
 * lengths again before anything reaches the pool, so a bad answer costs a retry
 * on the next run, never a broken pool.
 */
const TIMEOUT_MS = 150000;
const MAX_COUNT = 100;

const SCHEMA = {
  type: 'object',
  properties: { topics: { type: 'array', items: { type: 'string' } } },
  required: ['topics'],
};

const SYSTEM_PROMPT = `You write topics for a daily English-shadowing video aimed at
Vietnamese learners of spoken English. Each video is a short two-person
conversation about one topic, illustrated with stock photos.

Every topic you write must be:
- ONE concrete everyday situation between two people - a customer and a clerk,
  a patient and a receptionist, two colleagues, a guest and a host.
- English, lowercase, 3 to 10 words, in the same style as the existing list,
  e.g. "asking about a warranty", "ordering breakfast at a small cafe".
- set somewhere a stock photo can show: a cafe, a clinic, an airport, an office,
  a shop counter, a hotel lobby, a bank, a gym. Avoid situations with no visible
  place (phone calls about abstract matters, online chats, feelings).
- useful: something a learner will actually face at work, while travelling, or
  in daily life.

Spread the list across areas - food and drink, travel and transport, work and
office, health, shopping, housing, banking and money, leisure, services and
repairs, school - and lean towards areas the recent topics have not covered.

Never repeat or merely rephrase a topic from the existing list: "returning a
shirt" and "returning a jacket that does not fit" are the same situation.
Return exactly the number of topics asked for, all different from each other.`;

/** Null when the body is usable, otherwise why not. */
function badRequest(body) {
  if (!Array.isArray(body?.existing) || body.existing.some((t) => typeof t !== 'string')) {
    return 'existing must be an array of strings';
  }
  if (body.recent !== undefined && (!Array.isArray(body.recent) || body.recent.some((t) => typeof t !== 'string'))) {
    return 'recent must be an array of strings';
  }
  if (!Number.isInteger(body.count) || body.count < 1 || body.count > MAX_COUNT) {
    return `count must be a whole number from 1 to ${MAX_COUNT}`;
  }
  return null;
}

/** The user turn: what exists, what ran lately, how many to write. */
function message(body) {
  const text = [
    `Existing topics (${body.existing.length}) - do not repeat or rephrase any of these:`,
    ...body.existing.map((t) => `- ${t}`),
    '',
    'Most recent topics, newest first (favour other areas):',
    ...(body.recent ?? []).map((t) => `- ${t}`),
    '',
    `Write ${body.count} new topics.`,
  ].join('\n');
  return [{ type: 'text', text }];
}

module.exports = { SCHEMA, SYSTEM_PROMPT, TIMEOUT_MS, badRequest, message };
