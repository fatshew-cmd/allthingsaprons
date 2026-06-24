const User = require('../models/User');

module.exports = async (req, res, next) => {
  try {
    const user = await User.findById(req.session.userId).select('accountStatus role idVerified username avatar email displayName');
    if (!user || user.accountStatus === 'banned') {
      req.session.destroy(() => {});
      return res.redirect('/signup');
    }
    req.currentUser = {
      _id:         user._id,
      role:        user.role,
      idVerified:  user.idVerified,
      username:    user.username?.value    || null,
      avatar:      user.avatar?.value      || null,
      email:       user.email?.value       || null,
      displayName: user.displayName?.value || null,
    };
    next();
  } catch (err) {
    next(err);
  }
};
