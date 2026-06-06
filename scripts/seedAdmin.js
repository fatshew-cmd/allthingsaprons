require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const User     = require('../models/User');

const { MONGO_URI, ADMIN_PASSWORD } = process.env;

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD not set in .env');
  process.exit(1);
}

mongoose.connect(MONGO_URI || 'mongodb://localhost:27017/allthingsaprons').then(async () => {
  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const now            = new Date();

  const existing = await User.findOne({ 'email.value': 'fatshew@gmail.com' });

  if (existing) {
    await User.findByIdAndUpdate(existing._id, {
      $set: {
        password:         hashedPassword,
        role:             'founder',
        accountStatus:    'active',
        onboardingStatus: 'approved',
        'email.confirmed': true,
      },
    });
  } else {
    await User.create({
      password:         hashedPassword,
      role:             'founder',
      accountStatus:    'active',
      onboardingStatus: 'approved',
      email: {
        value:     'fatshew@gmail.com',
        confirmed: true,
        history:   [{ value: 'fatshew@gmail.com', setAt: now, source: 'admin' }],
      },
    });
  }

  console.log('Admin account ready — fatshew@gmail.com');
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
