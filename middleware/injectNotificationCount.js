const Notification = require('../models/Notification');

module.exports = async function injectNotificationCount(req, res, next) {
  res.locals.unreadNotifications = 0;
  if (req.session?.userId) {
    try {
      res.locals.unreadNotifications = await Notification.countDocuments({
        userId: req.session.userId,
        read: false,
      });
    } catch { /* non-fatal — badge just shows 0 */ }
  }
  next();
};
