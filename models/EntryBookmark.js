const mongoose = require('mongoose');

const entryBookmarkSchema = new mongoose.Schema({
  entryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

entryBookmarkSchema.index({ entryId: 1, userId: 1 }, { unique: true });
entryBookmarkSchema.index({ userId: 1 });

module.exports = mongoose.model('EntryBookmark', entryBookmarkSchema);
