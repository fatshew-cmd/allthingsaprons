const FULL_ACCESS = new Set(['superadmin', 'founder']);

module.exports = function requireDomain(domain) {
  return function (req, res, next) {
    // null domain = founder-only; always check the real role so impersonation can't grant access
    if (domain === null) {
      return req.session.adminRole === 'founder' ? next() : res.redirect('/admin');
    }
    const role = req.session.roleOverride || req.session.adminRole;
    if (!role) return res.redirect('/admin/login');
    if (FULL_ACCESS.has(role)) return next();
    const permissions = req.session.permissionsOverride || req.session.adminPermissions || [];
    if (permissions.includes(domain)) return next();
    return res.redirect('/admin');
  };
};
