const User                = require('../models/User');
const UserReport           = require('../models/UserReport');
const Follow               = require('../models/Follow');
const ContestContribution  = require('../models/ContestContribution');

// TEMP: bypass eligibility for these usernames during local testing — remove before launch
const TEST_BYPASS_USERNAMES = ['celuiqui', 'storiesbyshews'];

module.exports = async function requireOrganizerEligibility(req, res, next) {
  try {
    const userId = req.currentUser._id;
    const user = await User.findById(userId).select('username idVerified accountStatus').lean();
    if (!user) return res.redirect('/signup');

    if (TEST_BYPASS_USERNAMES.includes(user.username?.value)) return next();

    if (!user.idVerified) return res.redirect('/verify-identity');
    if (user.accountStatus === 'banned') {
      return res.status(403).json({ error: 'Your account has an active ban.' });
    }

    const [pendingReports, followerCount, contributedContestIds] = await Promise.all([
      UserReport.countDocuments({ reportedUserId: userId, status: 'pending' }),
      Follow.countDocuments({ followingId: userId }),
      ContestContribution.distinct('contestId', { contributorId: userId }),
    ]);

    if (pendingReports > 0) {
      return res.status(403).json({ error: 'Your account has pending reports under review.' });
    }
    if (followerCount <= 250) {
      return res.status(403).json({ error: 'You need more than 250 followers to organize a tournament.' });
    }
    if (contributedContestIds.length < 5) {
      return res.status(403).json({ error: 'You must have contributed to at least 5 contests.' });
    }

    next();
  } catch (err) {
    next(err);
  }
};
