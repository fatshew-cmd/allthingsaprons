const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const User    = require('../models/User');
const upload  = require('../middleware/upload');

// GET /admin/profile
router.get('/', async (req, res) => {
  try {
    const user = await User.findById(req.session.adminId)
      .select('displayName email avatar role permissions createdAt isTemporary temporaryUntil accountStatus')
      .lean();
    if (!user) return res.redirect('/admin/login');

    res.render('admin/profile', { title: 'My Profile', currentPage: 'profile', user });
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

// POST /admin/profile/display-name
router.post('/display-name', async (req, res) => {
  try {
    const name = (req.body.displayName || '').trim().slice(0, 50);
    if (!name) return res.redirect('/admin/profile?error=name_empty');

    await User.findByIdAndUpdate(req.session.adminId, {
      $set:  { 'displayName.value': name },
      $push: { 'displayName.history': { value: name, setAt: new Date(), source: 'profile' } },
    });

    req.session.adminDisplayName = name;
    res.redirect('/admin/profile?success=name');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/profile?error=name_failed');
  }
});

// POST /admin/profile/avatar
router.post('/avatar', upload.avatar.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/admin/profile?error=avatar_missing');

    const filePath = '/uploads/avatars/' + req.file.filename;
    await User.findByIdAndUpdate(req.session.adminId, {
      $set:  { 'avatar.value': filePath },
      $push: { 'avatar.history': { value: filePath, setAt: new Date(), source: 'profile' } },
    });

    req.session.adminAvatar = filePath;
    res.redirect('/admin/profile?success=avatar');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/profile?error=avatar_failed');
  }
});

// POST /admin/profile/password
router.post('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.redirect('/admin/profile?error=password_missing');
    }
    if (newPassword !== confirmPassword) {
      return res.redirect('/admin/profile?error=password_match');
    }
    if (newPassword.length < 8) {
      return res.redirect('/admin/profile?error=password_length');
    }

    const user = await User.findById(req.session.adminId).select('password');
    if (!user) return res.redirect('/admin/login');

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.redirect('/admin/profile?error=password_wrong');

    const hash = await bcrypt.hash(newPassword, 12);
    await User.findByIdAndUpdate(req.session.adminId, { password: hash });

    res.redirect('/admin/profile?success=password');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/profile?error=password_failed');
  }
});

module.exports = router;
