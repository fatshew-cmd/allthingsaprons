const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

function makeStorage(subdirOrFn) {
  return multer.diskStorage({
    destination(req, file, cb) {
      const subdir = typeof subdirOrFn === 'function' ? subdirOrFn(file) : subdirOrFn;
      const dir = path.join(__dirname, `../public/uploads/${subdir}`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  });
}

const imageOnly    = (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'));
const imageOrVideo = (req, file, cb) => (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) ? cb(null, true) : cb(new Error('Images and videos only'));

const MB = 1024 * 1024;

module.exports = {
  // Single-field uploaders
  avatar:    multer({ storage: makeStorage('avatars'),       limits: { fileSize: 10 * MB }, fileFilter: imageOnly }),
  banner:    multer({ storage: makeStorage('banners'),       limits: { fileSize: 10 * MB }, fileFilter: imageOnly }),
  idDocs:    multer({ storage: makeStorage('id-docs'),       limits: { fileSize: 10 * MB }, fileFilter: imageOnly }),
  entry:     multer({ storage: makeStorage('entries'),       limits: { fileSize: 100 * MB }, fileFilter: imageOrVideo }),
  thumbnail: multer({ storage: makeStorage('announcements'), limits: { fileSize: 5 * MB },  fileFilter: imageOnly }),
  support:   multer({ storage: makeStorage('support'),       limits: { fileSize: 2.5 * MB }, fileFilter: imageOnly }),

  // Combined avatar + banner for the settings/profile route
  profile: multer({
    storage: makeStorage(file => file.fieldname === 'banner' ? 'banners' : 'avatars'),
    limits: { fileSize: 10 * MB },
    fileFilter: imageOnly,
  }),
};
