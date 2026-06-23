require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons').then(async () => {
  const db = mongoose.connection.db;
  const users = db.collection('users');

  // Count affected documents before migrating
  const affected = await users.countDocuments({ 'wallet.balanceCHL': { $exists: true } });
  console.log(`Found ${affected} user(s) with legacy wallet.balanceCHL field.`);

  if (affected === 0) {
    console.log('Nothing to migrate.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // For each affected user, add balanceCHL into purchasedCHL and drop the old field.
  // Uses aggregation pipeline update (MongoDB 4.2+) so we can reference field values.
  const result = await users.updateMany(
    { 'wallet.balanceCHL': { $exists: true } },
    [
      {
        $set: {
          'wallet.purchasedCHL': {
            $add: [
              { $ifNull: ['$wallet.purchasedCHL', 0] },
              { $ifNull: ['$wallet.balanceCHL', 0] },
            ],
          },
        },
      },
      { $unset: 'wallet.balanceCHL' },
    ]
  );

  console.log(`✓ Migrated ${result.modifiedCount} user(s): wallet.balanceCHL → wallet.purchasedCHL`);

  // Spot-check: show any users still carrying the old field
  const remaining = await users.countDocuments({ 'wallet.balanceCHL': { $exists: true } });
  if (remaining > 0) {
    console.warn(`⚠  ${remaining} document(s) still have wallet.balanceCHL — investigate manually.`);
  } else {
    console.log('✓ No legacy fields remaining.');
  }

  await mongoose.disconnect();
  process.exit(0);
}).catch(err => {
  console.error('DB connection error:', err.message);
  process.exit(1);
});
