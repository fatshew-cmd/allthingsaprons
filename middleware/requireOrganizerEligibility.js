const User                = require('../models/User');
const UserReport           = require('../models/UserReport');
const Follow               = require('../models/Follow');
const ContestContribution  = require('../models/ContestContribution');
const Tournament           = require('../models/Tournament');

// TEMP: bypass eligibility for these usernames during local testing — remove before launch
const TEST_BYPASS_USERNAMES = ['celuiqui', 'storiesbyshews'];

const MAX_CONCURRENT_TOURNAMENTS = 3;

module.exports = async function requireOrganizerEligibility(req, res, next) {
  try {
    const userId = req.currentUser._id;
    const user = await User.findById(userId).select('username idVerified accountStatus').lean();
    if (!user) return res.redirect('/signup');

    if (TEST_BYPASS_USERNAMES.includes(user.username?.value)) return next();

    if (!user.idVerified) return res.redirect('/verify-identity');

    function blocked(message) {
      return res.redirect('/tournaments?flash=' + encodeURIComponent(message) + '&flashType=error');
    }

    if (user.accountStatus === 'banned') {
      return blocked('Your account has an active ban.');
    }

    const [pendingReports, followerCount, contributedContestIds, concurrentTournaments] = await Promise.all([
      UserReport.countDocuments({ reportedUserId: userId, status: 'pending' }),
      Follow.countDocuments({ followingId: userId }),
      ContestContribution.distinct('contestId', { contributorId: userId }),
      Tournament.countDocuments({ createdBy: userId, status: { $in: ['open', 'cooldown', 'active'] } }),
    ]);

    if (pendingReports > 0) {
      return blocked('Your account has pending reports under review.');
    }
    if (followerCount <= 250) {
      return blocked('You need more than 250 followers to organize a tournament.');
    }
    if (contributedContestIds.length < 5) {
      return blocked('You must have contributed to at least 5 contests.');
    }
    if (concurrentTournaments >= MAX_CONCURRENT_TOURNAMENTS) {
      return blocked(`You can only have ${MAX_CONCURRENT_TOURNAMENTS} tournaments running at once. Wait for one to close before starting another.`);
    }

    next();
  } catch (err) {
    next(err);
  }
};
