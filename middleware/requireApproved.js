const User = require('../models/User');

module.exports = async (req, res, next) => {
  try {
    const user = await User.findById(req.session.userId).select('onboardingStatus role username avatar email');
    if (!user) {
      req.session.destroy(() => {});
      return res.redirect('/signup');
    }
    if (user.onboardingStatus !== 'approved') return res.redirect('/onboarding');
    req.currentUser = user;
    next();
  } catch (err) {
    next(err);
  }
};
