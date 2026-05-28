const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const User    = require('../models/User');
const Item    = require('../models/Item');
const upload  = require('../middleware/upload');

const signupContests = [
  {
    _id: 'cont1',
    title: 'The Great Grill-Off',
    theme: 'BBQ & Outdoor Cooking',
    description: 'Design the ultimate apron for summer grilling. Bold, heat-resistant, and built for the pit.',
    organizer: '@atap',
    status: 'active',
    daysLeft: 8,
    submissionCount: 47,
    coverUrl: 'https://picsum.photos/seed/grill1/400/400',
  },
  {
    _id: 'cont2',
    title: 'Garden Party',
    theme: 'Botanical & Garden',
    description: 'Nature-inspired aprons for the green-thumb crowd. Think linen, flora, and earthy tones.',
    organizer: '@atap',
    status: 'active',
    daysLeft: 14,
    submissionCount: 31,
    coverUrl: 'https://picsum.photos/seed/garden2/400/400',
  },
  {
    _id: 'cont3',
    title: 'Studio Craft',
    theme: 'Artisan & Workshop',
    description: 'Celebrate the maker spirit. Raw materials, handcrafted details, and workshop aesthetics.',
    organizer: '@atap',
    status: 'active',
    daysLeft: 5,
    submissionCount: 19,
    coverUrl: 'https://picsum.photos/seed/craft3/400/400',
  },
];

router.get('/signup', (req, res) => {
  res.render('signup', { title: 'Sign Up', contests: signupContests, error: null });
});

router.post('/signup', upload.fields([
  { name: 'avatar',     maxCount: 1 },
  { name: 'entryPhoto', maxCount: 1 },
]), async (req, res) => {

  const renderError = (msg) =>
    res.render('signup', { title: 'Sign Up', contests: signupContests, error: msg });

  try {
    const {
      username, email, password, confirmPassword,
      bio, sex, orientation, location, birthdate,
      contestId, entryTitle, entryDescription,
    } = req.body;

    if (!username || !email || !password || !sex || !birthdate) {
      return renderError('Please complete all required fields.');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]{2,14}$/.test(username)) {
      return renderError('Username must start with a letter, contain only letters and digits, and be 3–15 characters.');
    }
    if (bio && bio.trim().length > 0 && (bio.trim().length < 20 || bio.trim().length > 220)) {
      return renderError('Bio must be between 20 and 220 characters.');
    }
    if (password !== confirmPassword) {
      return renderError('Passwords do not match.');
    }
    const pwLower   = (password.match(/[a-z]/g) || []).length;
    const pwUpper   = (password.match(/[A-Z]/g) || []).length;
    const pwDigit   = (password.match(/[0-9]/g) || []).length;
    const pwSpecial = (password.match(/[^a-zA-Z0-9]/g) || []).length;
    if (password.length < 12 || pwLower < 3 || pwUpper < 3 || pwDigit < 3 || pwSpecial < 3) {
      return renderError('Password must be at least 12 characters with 3+ lowercase, 3+ uppercase, 3+ digits, and 3+ special characters.');
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
      bio:         bio || undefined,
      sex,
      orientation: orientation || undefined,
      location:    location || undefined,
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
