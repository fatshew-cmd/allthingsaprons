require('dotenv').config();
const mongoose = require('mongoose');
const Entry    = require('../models/Entry');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons').then(async () => {
  const result = await Entry.updateMany(
    { title: { $exists: false } },
    { $set: { title: 'Untitled' } }
  );
  console.log(`Backfilled title on ${result.modifiedCount} entry/entries.`);
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
