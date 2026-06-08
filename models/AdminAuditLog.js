const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema({
  ticketRef: { type: String, required: true, unique: true },

  // Who acted — admin for admin actions, user for user-submitted events
  actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorRole: {
    type: String,
    enum: ['user', 'moderator', 'supervisor', 'superadmin', 'founder'],
    required: true,
  },

  action: {
    type: String,
    required: true,
    enum: [
      'id_verification_submitted',
      'id_verification_approved',
      'id_verification_rejected',
      'id_verification_escalated',
      'id_verification_case_closed',
      'onboarding_entry_submitted',
      'onboarding_entry_approved',
      'onboarding_entry_rejected',
      'user_role_changed',
      'user_banned',
    ],
  },

  // Groups all events belonging to one verification cycle
  caseRef: { type: String, default: null },

  entityType: {
    type: String,
    required: true,
    enum: ['user', 'entry', 'tournament_entry', 'contest', 'tournament', 'comment'],
  },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },

  // The platform user affected (may equal actorId for user-submitted events)
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Free-text note from the admin — stored as-is, shown in audit log only
  remarks: { type: String, default: null },

  // Action-specific payload (e.g. rejection reasons array, old/new role, DOBs entered)
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

adminAuditLogSchema.index({ targetUserId: 1, createdAt: -1 });
adminAuditLogSchema.index({ actorId: 1,     createdAt: -1 });
adminAuditLogSchema.index({ action:  1,     createdAt: -1 });
adminAuditLogSchema.index({ caseRef: 1,     createdAt:  1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
