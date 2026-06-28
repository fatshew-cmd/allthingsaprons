const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
require('dotenv').config();

const pagesRouter      = require('./routes/pages');
const apiRouter        = require('./routes/api');
const adminRouter      = require('./routes/admin');
const authRouter       = require('./routes/auth');
const verifyIdentityRouter = require('./routes/verify-identity');
const contactRouter    = require('./routes/contact');
const careersRouter    = require('./routes/careers');
const followRouter     = require('./routes/follow');
const messagesRouter   = require('./routes/messages');
const notificationsRouter = require('./routes/notifications');
const walletRouter     = require('./routes/wallet');
const exploreRouter    = require('./routes/explore');
const injectNotificationCount = require('./middleware/injectNotificationCount');
const injectRightPanelData    = require('./middleware/injectRightPanelData');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons' }),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/', authRouter);
app.use('/verify-identity', verifyIdentityRouter);
app.use('/contact', contactRouter);
app.use('/careers', careersRouter);
app.use('/admin', adminRouter);
app.use('/', followRouter);
app.use('/wallet', injectNotificationCount, injectRightPanelData, walletRouter);
app.use('/messages', injectNotificationCount, injectRightPanelData, messagesRouter);
app.use('/notifications', injectNotificationCount, injectRightPanelData, notificationsRouter);
app.use('/', injectNotificationCount, injectRightPanelData, exploreRouter);
app.use('/', injectNotificationCount, injectRightPanelData, pagesRouter);
app.use('/api', apiRouter);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons';

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');
    const agenda                  = require('./jobs/agenda');
    const { registerContestJobs } = require('./jobs/contestJobs');
    const { startSweeper }        = require('./jobs/sweeper');
    const { registerWalletJobs, startWalletJobs } = require('./jobs/walletJobs');
    registerContestJobs(agenda);
    registerWalletJobs(agenda);
    await agenda.start();
    await startSweeper(agenda);
    await startWalletJobs(agenda);
    console.log('Background jobs started');

    async function gracefulShutdown(signal) {
      console.log(`${signal} received — stopping background jobs`);
      await agenda.stop();
      process.exit(0);
    }
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
  })
  .catch((err) => console.warn('MongoDB unavailable — running without DB:', err.message));

app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
