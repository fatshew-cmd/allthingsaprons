const crypto        = require('crypto');
const AdminAuditLog = require('../models/AdminAuditLog');

function generateRef() {
  const date  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let suffix  = '';
  for (let i = 0; i < 8; i++) suffix += chars[bytes[i] % chars.length];
  return `ATA-${date}-${suffix}`;
}

// Generates a stable case-level reference (stored on the User for the duration of the cycle)
function generateCaseRef() {
  return generateRef();
}

/**
 * @param {object} opts
 * @param {string|ObjectId} opts.actorId
 * @param {string}          opts.actorRole
 * @param {string}          opts.action
 * @param {string}          opts.entityType
 * @param {string|ObjectId} opts.entityId
 * @param {string|ObjectId} [opts.targetUserId]
 * @param {string}          [opts.caseRef]     — shared ref across a verification cycle
 * @param {string}          [opts.remarks]
 * @param {object}          [opts.metadata]
 */
async function logAuditEvent(opts) {
  try {
    await AdminAuditLog.create({
      ticketRef:    generateRef(),
      actorId:      opts.actorId,
      actorRole:    opts.actorRole,
      action:       opts.action,
      entityType:   opts.entityType,
      entityId:     opts.entityId,
      targetUserId: opts.targetUserId || opts.actorId,
      caseRef:      opts.caseRef      || null,
      remarks:      opts.remarks?.trim() || null,
      metadata:     opts.metadata || {},
    });
  } catch (err) {
    console.error('[audit] logAuditEvent failed:', err.message);
  }
}

module.exports = logAuditEvent;
module.exports.generateCaseRef = generateCaseRef;
