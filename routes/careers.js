const express          = require('express');
const router           = express.Router();
const { Resend }       = require('resend');
const AdminApplication = require('../models/AdminApplication');

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@allthingsaprons.com';

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

router.get('/', (req, res) => {
  res.render('careers', {
    title:     'Join the Team',
    submitted: req.query.submitted === '1',
    error:     null,
  });
});

router.post('/', async (req, res) => {
  const name    = (req.body.name    || '').trim().slice(0, 100);
  const email   = (req.body.email   || '').trim().toLowerCase();
  const linkedin = (req.body.linkedin || '').trim().slice(0, 300);
  const message = (req.body.message || '').trim().slice(0, 3000);

  if (!name || !email || !message) {
    return res.render('careers', { title: 'Join the Team', submitted: false, error: 'Please fill in all required fields.' });
  }

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(email)) {
    return res.render('careers', { title: 'Join the Team', submitted: false, error: 'Please enter a valid email address.' });
  }

  try {
    await AdminApplication.create({ name, email, linkedin, message });

    const resend = getResend();
    if (resend) {
      try {
        await resend.emails.send({
          from:    FROM_EMAIL,
          to:      email,
          subject: 'We received your application — AllThingsAprons',
          html: `<p style="font-family:sans-serif">Hi ${name},</p><p style="font-family:sans-serif">Thanks for applying to join the AllThingsAprons team. We've received your application and will be in touch if your profile is a good fit.</p><p style="font-family:sans-serif">— The ATA Team</p>`,
        });
      } catch (emailErr) {
        console.error('Careers confirmation email failed:', emailErr.message);
      }
    }

    res.redirect('/careers?submitted=1');
  } catch (err) {
    console.error(err);
    res.render('careers', { title: 'Join the Team', submitted: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
