const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const subdir = file.fieldname === 'avatar'
      ? 'avatars'
      : file.fieldname === 'banner'
      ? 'banners'
      : (file.fieldname === 'idSelfie' || file.fieldname === 'idDoc')
      ? 'id-docs'
      : file.fieldname === 'support'
      ? 'support'
      : 'entries';
    const dir = path.join(__dirname, `../public/uploads/${subdir}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    if (file.mimetype.startsWith('video/') && file.fieldname !== 'avatar') return cb(null, true);
    cb(new Error('Invalid file type'));
  },
});

module.exports = upload;
