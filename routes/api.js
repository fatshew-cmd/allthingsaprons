const express = require('express');
const router = express.Router();
const User = require('../models/User');

router.get('/has-user', async (req, res) => {
  try {
    const count = await User.countDocuments();
    res.json({ exists: count > 0 });
  } catch {
    res.json({ exists: false });
  }
});

module.exports = router;
