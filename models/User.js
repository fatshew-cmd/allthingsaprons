const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  username:  { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  bio:       { type: String },
  avatar:    { type: String },
  sex:       { type: String, enum: ['male', 'female', 'other', 'prefer-not-to-say'] },
  location:  { type: String },
  birthdate: { type: Date },
  isAdmin:   { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
