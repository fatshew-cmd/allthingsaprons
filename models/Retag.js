const mongoose = require('mongoose');
const { Schema, Types: { ObjectId } } = mongoose;

const retagSchema = new Schema({
  entryId:   { type: ObjectId, ref: 'Entry',   required: true },
  contestId: { type: ObjectId, ref: 'Contest', required: true },
  userId:    { type: ObjectId, ref: 'User',    required: true },
}, { timestamps: true });

retagSchema.index({ entryId: 1 });
retagSchema.index({ contestId: 1 }, { unique: true });

module.exports = mongoose.model('Retag', retagSchema);
