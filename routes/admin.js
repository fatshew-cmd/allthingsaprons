const express = require('express');
const router = express.Router();
const User = require('../models/User');
const isAdmin = require('../middleware/isAdmin');

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin Login', error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email, isAdmin: true });
    if (!user || user.password !== password) {
      return res.render('admin/login', { title: 'Admin Login', error: 'Invalid credentials' });
    }
    req.session.isAdmin = true;
    req.session.adminId = user._id;
    res.redirect('/admin');
  } catch {
    res.render('admin/login', { title: 'Admin Login', error: 'Something went wrong' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.use(isAdmin);

router.get('/', (req, res) => {
  res.render('admin/dashboard', { title: 'Dashboard' });
});

router.get('/users', async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  res.render('admin/users/index', { title: 'Users', users });
});

router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).send('User not found');
  res.render('admin/users/detail', { title: user.email, user });
});

module.exports = router;
