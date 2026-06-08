/**
 * One-time migration: grant platform access to users stuck in the old onboarding pipeline.
 * Existing idVerified values are untouched — unverified users will be redirected to
 * /verify-identity when they first attempt to submit an entry.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const result = await User.updateMany(
    { onboardingStatus: { $in: ['pending_id_verification', 'pending_submission', 'pending_approval', 'rejected'] } },
    { $set: { onboardingStatus: 'approved', accountStatus: 'active' } }
  );

  console.log(`Updated ${result.modifiedCount} user(s) to onboardingStatus: approved / accountStatus: active`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
