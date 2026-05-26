const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const User    = require('../models/User');
const Item    = require('../models/Item');
const upload  = require('../middleware/upload');

const activeContests = [
  {
    _id: 'cont1',
    title: 'The Great Grill-Off',
    theme: 'BBQ & Outdoor Cooking',
    status: 'active',
    daysLeft: 8,
    submissionCount: 47,
    coverUrl: 'https://picsum.photos/seed/grill1/400/225',
  },
  {
    _id: 'cont2',
    title: 'Garden Party',
    theme: 'Botanical & Garden',
    status: 'active',
    daysLeft: 14,
    submissionCount: 31,
    coverUrl: 'https://picsum.photos/seed/garden2/400/225',
  },
  {
    _id: 'cont3',
    title: 'Studio Craft',
    theme: 'Artisan & Workshop',
    status: 'active',
    daysLeft: 5,
    submissionCount: 19,
    coverUrl: 'https://picsum.photos/seed/craft3/400/225',
  },
];

router.get('/signup', (req, res) => {
  res.render('signup', { title: 'Sign Up', contests: activeContests, error: null });
});

router.post('/signup', upload.fields([
  { name: 'avatar',     maxCount: 1 },
  { name: 'entryPhoto', maxCount: 1 },
]), async (req, res) => {

  const renderError = (msg) =>
    res.render('signup', { title: 'Sign Up', contests: activeContests, error: msg });

  try {
    const {
      username, email, password, confirmPassword,
      bio, sex, location, birthdate,
      contestId, entryTitle, entryDescription,
    } = req.body;

    if (!username || !email || !password || !sex || !birthdate) {
      return renderError('Please complete all required fields.');
    }
    if (!/^[a-z0-9_]{3,20}$/.test(username.toLowerCase())) {
      return renderError('Username must be 3–20 characters: letters, numbers, and underscores only.');
    }
    if (password !== confirmPassword) {
      return renderError('Passwords do not match.');
    }
    if (password.length < 8) {
      return renderError('Password must be at least 8 characters.');
    }
    if (!contestId) {
      return renderError('Please select a contest to enter.');
    }
    if (!req.files?.entryPhoto) {
      return renderError('Please upload a photo for your contest entry.');
    }
    if (!entryTitle) {
      return renderError('Please give your entry a title.');
    }

    const existing = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
    });
    if (existing) {
      if (existing.email === email.toLowerCase()) return renderError('This email is already registered.');
      return renderError('This username is already taken.');
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const avatarPath = req.files?.avatar?.[0]
      ? `/uploads/avatars/${req.files.avatar[0].filename}`
      : null;

    const user = await User.create({
      username:  username.toLowerCase().trim(),
      email:     email.toLowerCase().trim(),
      password:  hashedPassword,
      bio:       bio || undefined,
      sex,
      location:  location || undefined,
      birthdate: new Date(birthdate),
      avatar:    avatarPath,
    });

    const entryPhotoPath = `/uploads/entries/${req.files.entryPhoto[0].filename}`;

    await Item.create({
      mediaUrl:    entryPhotoPath,
      mediaType:   'image',
      title:       entryTitle.trim(),
      description: entryDescription || undefined,
      creator:     user._id,
    });

    req.session.userId = user._id.toString();
    res.redirect('/feed');
  } catch (err) {
    console.error('Signup error:', err);
    renderError('Something went wrong. Please try again.');
  }
});

module.exports = router;
