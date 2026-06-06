const FULL_ACCESS = new Set(['superadmin', 'founder']);

module.exports = function requireDomain(domain) {
  return function (req, res, next) {
    const role = req.session.adminRole;
    if (!role) return res.redirect('/admin/login');
    if (FULL_ACCESS.has(role)) return next();
    const permissions = req.session.adminPermissions || [];
    if (domain && permissions.includes(domain)) return next();
    return res.redirect('/admin');
  };
};
