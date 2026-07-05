const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons';

mongoose.connect(MONGO_URI).then(async () => {
  const deleted = await mongoose.connection.db.collection('ratings').deleteMany({});
  const updated = await mongoose.connection.db.collection('entries').updateMany({}, { $set: { ratingAvg: 0, ratingCount: 0 } });
  console.log(`Deleted ${deleted.deletedCount} rating(s). Reset ${updated.modifiedCount} entry/entries.`);
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
