require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const { MONGO_URI, ADMIN_PASSWORD } = process.env;

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD not set in .env');
  process.exit(1);
}

mongoose.connect(MONGO_URI || 'mongodb://localhost:27017/allthingsaprons').then(async () => {
  await User.findOneAndUpdate(
    { email: 'fatshew@gmail.com' },
    { email: 'fatshew@gmail.com', password: ADMIN_PASSWORD, isAdmin: true },
    { upsert: true, new: true }
  );
  console.log('Admin account ready — fatshew@gmail.com');
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
