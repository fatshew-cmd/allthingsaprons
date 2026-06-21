const Agenda   = require('agenda');
const mongoose = require('mongoose');

// Reuse the existing mongoose connection rather than opening a second one.
// Must be required after mongoose.connect() has been called in server.js.
const agenda = new Agenda({
  mongo:        mongoose.connection.db,
  db:           { collection: 'agendaJobs' },
  processEvery: '30 seconds',
  maxConcurrency: 10,
});

module.exports = agenda;
