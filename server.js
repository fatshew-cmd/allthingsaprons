const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const session = require('express-session');
require('dotenv').config();

const pagesRouter = require('./routes/pages');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/', pagesRouter);
app.use('/api', apiRouter);
app.use('/admin', adminRouter);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons';

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.warn('MongoDB unavailable — running without DB:', err.message));

app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
