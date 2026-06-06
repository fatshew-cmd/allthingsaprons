require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../models/User');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons').then(async () => {
  const result = await User.updateMany(
    { role: 'admin' },
    { $set: { role: 'founder', permissions: [] } }
  );
  console.log(`Migrated ${result.modifiedCount} admin account(s) → founder.`);
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
