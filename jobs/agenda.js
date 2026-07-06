const Agenda = require('agenda');

// Agenda manages its own MongoClient (rather than reusing mongoose.connection.db) so a
// mongoose reconnect (sleep/wake, network blip) can't leave it polling a stale db handle
// and silently stop processing jobs forever without crashing the process.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons';

const agenda = new Agenda({
  db:           { address: MONGO_URI, collection: 'agendaJobs' },
  processEvery: '30 seconds',
  maxConcurrency: 10,
}, (err) => {
  // Without this callback, a failed initial connect throws inside Agenda's own
  // MongoClient.connect callback and crashes the process instead of just leaving
  // background jobs unprocessed.
  if (err) console.error('Agenda failed to connect to MongoDB:', err.message);
});

// Index-creation failures emit 'error' on the agenda instance — with no listener,
// Node treats that as an uncaught exception and crashes the process too.
agenda.on('error', (err) => console.error('Agenda error:', err.message));

module.exports = agenda;
