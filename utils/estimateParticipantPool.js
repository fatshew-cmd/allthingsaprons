const mongoose = require('mongoose');
const User     = require('../models/User');
const Follow   = require('../models/Follow');
const Entry    = require('../models/Entry');
const { CRITERIA_FIELDS, CRITERIA_OPERATORS, SEX_VALUES } = require('./tournamentCriteria');

const MS_PER_DAY  = 1000 * 60 * 60 * 24;
const YEAR_DAYS   = 365.25;
const OP_EXPR     = { gte: '$gte', lte: '$lte', eq: '$eq' };
const PER_ENTRY_FIELDS = ['ratingAvg', 'ratingCount'];
const SEX_MAP = { M: ['male'], F: ['female'], NB: ['other', 'prefer-not-to-say'] };

function isValidCriterion(c) {
  if (!c || !CRITERIA_FIELDS.includes(c.field) || !CRITERIA_OPERATORS.includes(c.operator)) return false;
  if (c.field === 'sex') return c.operator === 'eq' && SEX_VALUES.includes(c.value);
  if (c.field === 'isFollower') return c.operator === 'eq' && c.value === true;
  return typeof c.value === 'number';
}

// Merges an operator onto a field's clause instead of overwriting it, so e.g. two
// "age" criteria (gte 18, lte 30) both survive in the same $match object.
function mergeOp(target, field, operator, value) {
  target[field] = Object.assign({}, target[field], { [OP_EXPR[operator]]: value });
}

// age/accountAgeDays are stored as "at least/at most N", but the underlying fields
// (birthdate, createdAt) run the other way in time — flip the operator so the
// comparison can run directly against the indexable date field.
function flip(operator) {
  if (operator === 'gte') return 'lte';
  if (operator === 'lte') return 'gte';
  return 'eq';
}

// Estimates how many currently-registered users would satisfy a tournament's eligibility
// criteria if applied today. ratingAvg/ratingCount are per-entry criteria (evaluated against
// whichever entry a candidate eventually submits) — a user counts as qualifying if at least
// one of their visible entries currently satisfies all such criteria together.
//
// Cost note: only the joins a given criteria set actually needs are added to the pipeline —
// e.g. plain age/sex/accountAgeDays/isFollower criteria resolve with zero $lookups at all.
async function estimateParticipantPool(organizerId, criteria) {
  const now = new Date();
  const organizerObjectId = new mongoose.Types.ObjectId(organizerId);
  const valid = (criteria || []).filter(isValidCriterion);

  const perEntryCriteria   = valid.filter(c => PER_ENTRY_FIELDS.includes(c.field));
  const needsFollowerCount = valid.some(c => c.field === 'followerCount');
  const needsIsFollower    = valid.some(c => c.field === 'isFollower');
  const needsEntryCount    = valid.some(c => c.field === 'entryCount');
  const needsEntries       = perEntryCriteria.length > 0 || needsEntryCount;

  const match = {
    idVerified:    true,
    accountStatus: { $ne: 'banned' },
    _id:           { $ne: organizerObjectId },
  };

  for (const c of valid) {
    if (c.field === 'sex') {
      match['sex.value'] = { $in: SEX_MAP[c.value] || [] };
    } else if (c.field === 'age') {
      mergeOp(match, 'birthdate.value', flip(c.operator), new Date(now.getTime() - c.value * YEAR_DAYS * MS_PER_DAY));
      match['birthdate.value'].$ne = null; // exclude users with no birthdate on file
    } else if (c.field === 'accountAgeDays') {
      mergeOp(match, 'createdAt', flip(c.operator), new Date(now.getTime() - c.value * MS_PER_DAY));
    }
    // followerCount / isFollower / ratingAvg / ratingCount / entryCount need joined data
    // and are resolved in the stages below.
  }

  // Rather than a per-document correlated $lookup, fetch the organizer's follower-id set
  // once (indexed on `followingId`) and filter the candidate pool directly by _id.
  if (needsIsFollower) {
    const followerIds = await Follow.distinct('followerId', { followingId: organizerObjectId });
    match._id = { $ne: organizerObjectId, $in: followerIds };
  }

  const pipeline = [{ $match: match }];

  if (needsFollowerCount) {
    pipeline.push(
      { $lookup: {
          from: 'follows', localField: '_id', foreignField: 'followingId', as: 'followerDocs',
          pipeline: [{ $project: { _id: 1 } }],
        } },
      { $addFields: { followerCount: { $size: '$followerDocs' } } },
      { $project: { followerDocs: 0 } },
    );
  }

  if (needsEntries) {
    pipeline.push({ $lookup: {
      from: 'entries', localField: '_id', foreignField: 'userId', as: 'entries',
      pipeline: [{ $match: { hidden: { $ne: true } } }, { $project: { ratingAvg: 1, ratingCount: 1 } }],
    } });
    if (needsEntryCount) pipeline.push({ $addFields: { entryCount: { $size: '$entries' } } });
    if (perEntryCriteria.length) {
      pipeline.push({ $addFields: {
        hasQualifyingEntry: { $gt: [{ $size: { $filter: {
          input: '$entries',
          as:    'e',
          cond:  { $and: perEntryCriteria.map(c => ({ [OP_EXPR[c.operator]]: ['$$e.' + c.field, c.value] })) },
        } } }, 0] },
      } });
    }
    pipeline.push({ $project: { entries: 0 } });
  }

  const finalMatch = {};
  for (const c of valid) {
    if (c.field === 'followerCount' || c.field === 'entryCount') mergeOp(finalMatch, c.field, c.operator, c.value);
  }
  if (perEntryCriteria.length) finalMatch.hasQualifyingEntry = true;

  if (Object.keys(finalMatch).length) pipeline.push({ $match: finalMatch });
  pipeline.push({ $count: 'count' });

  const result = await User.aggregate(pipeline);
  return result[0]?.count || 0;
}

const CRITERIA_OPS = { gte: (a, b) => a >= b, lte: (a, b) => a <= b, eq: (a, b) => a === b };

// Re-checks a single candidate (their user profile + the specific entry they submitted/are
// submitting) against a tournament's eligibility criteria, reporting exactly which criteria
// failed. Used both by the candidate submission route (3B) and by the organizer's edit flow
// (which only needs the pass/fail boolean — see meetsTournamentCriteria below). Unlike
// estimateParticipantPool (which asks "does the user have *any* qualifying entry"), this asks
// "does *this* entry still qualify."
//
// idVerified/banned/missing-or-hidden-entry are baseline gates, not criteria.value entries, so
// a failure there reports as { eligible: false, failedCriteria: [] } — the caller is expected to
// have already surfaced those cases with their own messaging (e.g. 3B step 5's idVerified check).
async function evaluateTournamentCriteria(userId, entryId, organizerId, criteria) {
  const valid = (criteria || []).filter(isValidCriterion);
  if (!valid.length) return { eligible: true, failedCriteria: [] };

  const needsEntry         = valid.some(c => PER_ENTRY_FIELDS.includes(c.field));
  const needsFollowerCount = valid.some(c => c.field === 'followerCount');
  const needsIsFollower    = valid.some(c => c.field === 'isFollower');
  const needsEntryCount    = valid.some(c => c.field === 'entryCount');

  const [user, entry, followerCount, followsOrganizer, entryCount] = await Promise.all([
    User.findById(userId).select('idVerified accountStatus sex birthdate createdAt').lean(),
    needsEntry ? Entry.findById(entryId).select('ratingAvg ratingCount hidden').lean() : Promise.resolve(null),
    needsFollowerCount ? Follow.countDocuments({ followingId: userId }) : Promise.resolve(null),
    needsIsFollower ? Follow.exists({ followerId: userId, followingId: organizerId }) : Promise.resolve(null),
    needsEntryCount ? Entry.countDocuments({ userId, hidden: { $ne: true } }) : Promise.resolve(null),
  ]);
  if (!user || !user.idVerified || user.accountStatus === 'banned') return { eligible: false, failedCriteria: [] };
  if (needsEntry && (!entry || entry.hidden)) return { eligible: false, failedCriteria: [] };

  const now = new Date();
  const failedCriteria = [];

  for (const c of valid) {
    let pass;
    if (c.field === 'sex') {
      pass = (SEX_MAP[c.value] || []).includes(user.sex?.value);
    } else if (c.field === 'age') {
      pass = !!user.birthdate?.value && CRITERIA_OPS[c.operator]((now - user.birthdate.value) / (MS_PER_DAY * YEAR_DAYS), c.value);
    } else if (c.field === 'accountAgeDays') {
      pass = CRITERIA_OPS[c.operator]((now - user.createdAt) / MS_PER_DAY, c.value);
    } else if (c.field === 'followerCount') {
      pass = CRITERIA_OPS[c.operator](followerCount, c.value);
    } else if (c.field === 'isFollower') {
      pass = !!followsOrganizer;
    } else if (c.field === 'entryCount') {
      pass = CRITERIA_OPS[c.operator](entryCount, c.value);
    } else if (PER_ENTRY_FIELDS.includes(c.field)) {
      pass = CRITERIA_OPS[c.operator](entry[c.field], c.value);
    }
    if (!pass && !failedCriteria.includes(c.field)) failedCriteria.push(c.field);
  }

  return { eligible: failedCriteria.length === 0, failedCriteria };
}

// Thin boolean wrapper kept for the organizer edit-flow caller (routes/tournaments.js), which
// only needs pass/fail, not the breakdown.
async function meetsTournamentCriteria(userId, entryId, organizerId, criteria) {
  return (await evaluateTournamentCriteria(userId, entryId, organizerId, criteria)).eligible;
}

// Builds a Mongo filter for the per-entry fields of a criteria set (merging multiple operators
// on the same field, e.g. two "ratingAvg" criteria, the same way estimateParticipantPool's own
// $match stage does) — lets a candidate's qualifying entries be found with a single indexed
// query instead of evaluating every owned entry one at a time.
function buildEntryCriteriaFilter(criteria) {
  const filter = {};
  (criteria || [])
    .filter(isValidCriterion)
    .filter(c => PER_ENTRY_FIELDS.includes(c.field))
    .forEach(c => mergeOp(filter, c.field, c.operator, c.value));
  return filter;
}

estimateParticipantPool.PER_ENTRY_FIELDS         = PER_ENTRY_FIELDS;
estimateParticipantPool.buildEntryCriteriaFilter = buildEntryCriteriaFilter;
estimateParticipantPool.meetsTournamentCriteria    = meetsTournamentCriteria;
estimateParticipantPool.evaluateTournamentCriteria = evaluateTournamentCriteria;
module.exports = estimateParticipantPool;
