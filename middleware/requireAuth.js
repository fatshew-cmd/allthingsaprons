const User = require('../models/User');

module.exports = async (req, res, next) => {
  if (!req.session.userId) return res.redirect('/signup');
  try {
    const user = await User.findById(req.session.userId).select('accountStatus').lean();
    if (!user || user.accountStatus === 'banned') {
      req.session.destroy(() => {});
      return res.redirect('/signup');
    }
    next();
  } catch (err) {
    next(err);
  }
};
