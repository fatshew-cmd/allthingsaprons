const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('index', { title: 'All Things Aprons' });
});

router.get('/signup', (req, res) => {
  res.render('signup', { title: 'Sign Up' });
});

module.exports = router;
