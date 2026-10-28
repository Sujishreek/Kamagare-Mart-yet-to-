/**
 * Users.gs : register, login (admin + customer on one form), profile, Google sign-in.
 */

function publicUser_(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone || null,
    address: row.address || '',
    profileImage: row.profileImage || ''
  };
}

function findUserBy_(table, fn) {
  for (var i = 0; i < table.rows.length; i++) if (fn(table.rows[i])) return table.rows[i];
  return null;
}

var REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;
var REGISTRATION_CODE_RESEND_MS = 60 * 1000;
var REGISTRATION_CODE_MAX_ATTEMPTS = 5;
var REGISTRATION_FROM_EMAIL = 'kamageremart04@gmail.com';

function getRegistrationEmailSender_() {
  var target = REGISTRATION_FROM_EMAIL.trim().toLowerCase();
  var effectiveUser = '';
  try {
    if (typeof Session !== 'undefined' && Session.getEffectiveUser) {
      effectiveUser = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    }
  } catch (e) {}
  if (effectiveUser && effectiveUser === target) {
    return { authorized: true, isAlias: false, email: target };
  }

  var activeUser = '';
  try {
    if (typeof Session !== 'undefined' && Session.getActiveUser) {
      activeUser = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
    }
  } catch (e) {}
  if (activeUser && activeUser === target) {
    return { authorized: true, isAlias: false, email: target };
  }

  var aliases = GmailApp.getAliases().map(function (alias) { return alias.trim().toLowerCase(); });
  if (aliases.indexOf(target) >= 0) {
    return { authorized: true, isAlias: true, email: target };
  }

  return { authorized: false, isAlias: false, currentAccount: effectiveUser || activeUser || 'unknown' };
}

function authorizeRegistrationEmail() {
  var sender = getRegistrationEmailSender_();
  if (!sender.authorized) {
    throw new Error(
      'Current Google account is [' + sender.currentAccount + '], but sender is set to [' + REGISTRATION_FROM_EMAIL + ']. ' +
      'To send from ' + REGISTRATION_FROM_EMAIL + ', either run this script from the ' + REGISTRATION_FROM_EMAIL + ' account, ' +
      'or open Gmail Settings -> Accounts and Import -> "Send mail as" in ' + sender.currentAccount + ' and add ' + REGISTRATION_FROM_EMAIL + '.'
    );
  }
  var quota = MailApp.getRemainingDailyQuota();
  Logger.log('Registration email sender is authorized as ' + REGISTRATION_FROM_EMAIL + ' (' + (sender.isAlias ? 'alias' : 'primary account') + '). Remaining daily recipient quota: ' + quota);
  return quota;
}

function registrationCodeHash_(email, code) {
  return sha256Hex_(prop_('ADMIN_JWT_SECRET') + ':' + email + ':' + code);
}

function findPendingRegistration_(email) {
  return findUserBy_(readTable_('PendingRegistrations'), function (row) {
    return row.email === email;
  });
}

function removeExpiredRegistrations_(keepEmail) {
  var now = Date.now();
  var rows = readTable_('PendingRegistrations').rows
    .filter(function (row) { return row.email !== keepEmail && Number(row.expiresAt) <= now; })
    .sort(function (a, b) { return b._row - a._row; });
  var sh = sheet_('PendingRegistrations');
  rows.forEach(function (row) { sh.deleteRow(row._row); });
}

function sendRegistrationCode_(email, code) {
  if (typeof GmailApp === 'undefined' || !GmailApp.sendEmail) {
    return fail_(503, 'Email delivery is unavailable. Please contact the store administrator.');
  }
  try {
    if (MailApp.getRemainingDailyQuota && MailApp.getRemainingDailyQuota() < 1) {
      return fail_(429, 'Email verification is temporarily unavailable. Please try again later.');
    }
    var sender = getRegistrationEmailSender_();
    if (!sender.authorized) {
      return fail_(503, 'Email verification must be authorized to send from ' + REGISTRATION_FROM_EMAIL + '. Ask the store administrator to add it as a verified Gmail "Send mail as" address.');
    }
    var mailOptions = { name: 'Kamagere Mart' };
    if (sender.isAlias) {
      mailOptions.from = REGISTRATION_FROM_EMAIL;
    }
    GmailApp.sendEmail(
      email,
      'Your Kamagere Mart verification code',
      'Your six-digit Kamagere Mart verification code is ' + code +
        '. It expires in 10 minutes. If you did not request this code, you can ignore this email.',
      mailOptions
    );
    return null;
  } catch (error) {
    console.error('Unable to send registration verification email: ' + error);
    return fail_(503, 'Email verification could not be sent from ' + REGISTRATION_FROM_EMAIL + '. Ask the store administrator to authorize this sender and Gmail access, then try again.');
  }
}

function registrationDetailsError_(body) {
  var name = String(body.name || '').trim();
  var email = String(body.email || '').trim().toLowerCase();
  var phone = String(body.phone || '').trim();
  var password = body.password;
  if (!name || !email || !phone || !password) return fail_(400, 'Please fill all required fields.');
  if (name.length > 255) return fail_(400, 'Enter a name up to 255 characters.');
  if (!EMAIL_REGEX.test(email)) return fail_(400, 'Please enter a valid email address.');
  if (!PHONE_REGEX.test(phone)) return fail_(400, 'Please enter a valid 10-digit Indian mobile number.');
  if (!PASSWORD_REGEX.test(String(password))) {
    return fail_(400, 'Password must be at least 8 characters and contain uppercase, lowercase, number, and special symbol.');
  }
  if (String(body.address || '').length > 2000) return fail_(400, 'Address must be 2,000 characters or fewer.');
  return null;
}

function registrationConflict_(email, phone) {
  var users = readTable_('Users');
  var emailTaken = findUserBy_(users, function (user) { return String(user.email).toLowerCase() === email; });
  var phoneTaken = findUserBy_(users, function (user) { return user.phone === phone; });
  if (!emailTaken && !phoneTaken) return null;
  return fail_(409, emailTaken && phoneTaken
    ? 'This email address and phone number are already registered.'
    : emailTaken ? 'Email is already registered.' : 'Phone number is already registered.');
}

function register_(ctx) {
  removeExpiredRegistrations_();
  var b = ctx.body;
  var validationError = registrationDetailsError_(b);
  if (validationError) return validationError;

  var name = String(b.name).trim();
  var email = String(b.email).trim().toLowerCase();
  var phone = String(b.phone).trim();
  var adminEmail = prop_('ADMIN_EMAIL').trim().toLowerCase();
  if (adminEmail && email === adminEmail) return fail_(409, 'This email address cannot be used for a customer account.');
  var conflict = registrationConflict_(email, phone);
  if (conflict) return conflict;

  var pending = findPendingRegistration_(email);
  var now = Date.now();
  if (pending && now - Number(pending.lastSentAt) < REGISTRATION_CODE_RESEND_MS) {
    return ok_({ message: 'A verification code was already sent. Check your email or wait before requesting another.', verificationRequired: true });
  }

  var code = String(parseInt(randomHex_(1).slice(0, 8), 16) % 900000 + 100000);
  var sendError = sendRegistrationCode_(email, code);
  if (sendError) return sendError;

  var record = {
    email: email,
    name: name,
    phone: phone,
    password: hashPassword_(String(b.password)),
    address: String(b.address || '').trim(),
    codeHash: registrationCodeHash_(email, code),
    expiresAt: now + REGISTRATION_CODE_TTL_MS,
    attempts: 0,
    lastSentAt: now
  };
  if (pending) updateRow_('PendingRegistrations', pending._row, record);
  else insertRow_('PendingRegistrations', record);
  return ok_({ message: 'A verification code has been sent to your email address.', verificationRequired: true }, 200);
}

function resendRegistrationCode_(ctx) {
  var email = String(ctx.body.email || '').trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) return fail_(400, 'Please enter a valid email address.');
  removeExpiredRegistrations_(email);
  var pending = findPendingRegistration_(email);
  if (!pending) return fail_(404, 'Registration details were not found. Please create your account again.');
  var now = Date.now();
  if (now - Number(pending.lastSentAt) < REGISTRATION_CODE_RESEND_MS) {
    return fail_(429, 'Please wait one minute before requesting another code.');
  }

  var code = String(parseInt(randomHex_(1).slice(0, 8), 16) % 900000 + 100000);
  var sendError = sendRegistrationCode_(email, code);
  if (sendError) return sendError;
  pending.codeHash = registrationCodeHash_(email, code);
  pending.expiresAt = now + REGISTRATION_CODE_TTL_MS;
  pending.attempts = 0;
  pending.lastSentAt = now;
  updateRow_('PendingRegistrations', pending._row, pending);
  return ok_({ message: 'A new verification code has been sent to your email address.' });
}

function verifyRegistration_(ctx) {
  var email = String(ctx.body.email || '').trim().toLowerCase();
  var code = String(ctx.body.code || '').trim();
  if (!EMAIL_REGEX.test(email)) return fail_(400, 'Please enter a valid email address.');
  if (!/^\d{6}$/.test(code)) return fail_(400, 'Enter the six-digit verification code.');

  var pending = findPendingRegistration_(email);
  if (!pending) return fail_(404, 'Registration details were not found. Please create your account again.');
  var pendingSheet = sheet_('PendingRegistrations');
  if (Number(pending.expiresAt) <= Date.now()) {
    pendingSheet.deleteRow(pending._row);
    return fail_(410, 'Your verification code expired. Create your account again to receive a new code.');
  }
  if (Number(pending.attempts) >= REGISTRATION_CODE_MAX_ATTEMPTS) {
    pendingSheet.deleteRow(pending._row);
    return fail_(429, 'Too many incorrect codes. Create your account again to restart verification.');
  }
  if (!safeEqual_(registrationCodeHash_(email, code), pending.codeHash)) {
    pending.attempts = Number(pending.attempts) + 1;
    updateRow_('PendingRegistrations', pending._row, pending);
    return fail_(400, 'That verification code is incorrect.');
  }

  var conflict = registrationConflict_(email, pending.phone);
  if (conflict) {
    pendingSheet.deleteRow(pending._row);
    return conflict;
  }
  var id = nextId_('Users');
  insertRow_('Users', {
    id: id, name: pending.name, email: email, phone: pending.phone, password: pending.password,
    address: pending.address, profileImage: ''
  });
  var user = findUserBy_(readTable_('Users'), function (row) { return row.id === id; });
  pendingSheet.deleteRow(pending._row);
  return ok_({ message: 'Email verified. You can now log in.', user: publicUser_(user) }, 201);
}

function login_(ctx) {
  var email = ctx.body.email;
  var password = ctx.body.password;
  if (!email || !password) return fail_(400, 'Email and password are required.');
  if (!EMAIL_REGEX.test(String(email).trim())) return fail_(400, 'Please enter a valid email address.');

  if (checkAdminCredentials_(email, password).ok) return fail_(401, 'Invalid email or password.');
  if (!PASSWORD_REGEX.test(String(password))) {
    return fail_(400, 'Password must be at least 8 characters and contain uppercase, lowercase, number, and special symbol.');
  }
  var wanted = String(email).trim().toLowerCase();
  var user = findUserBy_(readTable_('Users'), function (u) { return String(u.email).toLowerCase() === wanted; });
  if (!user || !user.password || !verifyPassword_(String(password), user.password)) {
    return fail_(401, 'Invalid email or password.');
  }
  return ok_({ message: 'Login successful', role: 'customer', user: publicUser_(user), token: createCustomerToken_(user) });
}

function adminLogin_(ctx) {
  var email = ctx.body.email;
  var password = ctx.body.password;
  if (!email || !password || typeof password !== 'string') return fail_(400, 'Admin email and password are required.');
  if (!EMAIL_REGEX.test(String(email).trim())) return fail_(400, 'Please enter a valid admin email address.');
  var check = checkAdminCredentials_(email, password);
  if (!check.configured) return fail_(503, 'Admin login is not configured.');
  if (!check.ok) return fail_(401, 'Invalid admin email or password.');
  return ok_({ message: 'Admin login successful', token: check.token, admin: { email: check.email, role: 'admin' } });
}

function adminSession_(ctx, m, auth) {
  return ok_({ admin: { email: auth.session.email, role: 'admin' }, expiresAt: auth.session.exp ? auth.session.exp * 1000 : null });
}

function updateProfile_(ctx, m, auth) {
  var b = ctx.body;
  var name = String(b.name || '').trim();
  var email = String(b.email || '').trim();
  var phone = String(b.phone || '').trim();
  var address = String(b.address || '').trim();
  var photo = String(b.profileImage || '');

  if (!name || name.length > 255) return fail_(400, 'Enter a name up to 255 characters.');
  if (!EMAIL_REGEX.test(email)) return fail_(400, 'Please enter a valid email address.');
  if (!PHONE_REGEX.test(phone)) return fail_(400, 'Please enter a valid 10-digit Indian mobile number.');
  if (address.length > 2000) return fail_(400, 'Address must be 2,000 characters or fewer.');
  if (photo.length > 100000 || (photo && !/^data:image\/jpeg;base64,[A-Za-z0-9+\/]+={0,2}$/.test(photo))) {
    return fail_(400, 'Profile photos must be JPEG images smaller than 75 KB.');
  }

  var users = readTable_('Users');
  var dup = findUserBy_(users, function (u) {
    return u.id !== auth.customerId && (String(u.email).toLowerCase() === email.toLowerCase() || u.phone === phone);
  });
  if (dup) return fail_(409, 'That email address or phone number is already in use.');

  var existing = findUserBy_(users, function (u) { return u.id === auth.customerId; });
  if (!existing) return fail_(404, 'Customer account not found.');

  existing.name = name;
  existing.email = email;
  existing.phone = phone;
  existing.address = address;
  existing.profileImage = photo || existing.profileImage || '';
  updateRow_('Users', existing._row, existing);
  return ok_({ message: 'Profile updated successfully.', user: publicUser_(existing) });
}

// ---------------------------------------------------------------- Google login

function googleConfig_() {
  return ok_({ clientId: prop_('GOOGLE_CLIENT_ID') || null });
}

/** Verifies a Google ID token through Google's tokeninfo endpoint. */
function googleSignIn_(ctx) {
  var clientId = prop_('GOOGLE_CLIENT_ID');
  if (!clientId) return fail_(503, 'Google sign-in is not configured. Add GOOGLE_CLIENT_ID in Script Properties.');
  var credential = String(ctx.body.credential || '');
  if (!credential || credential.length > 12000) return fail_(400, 'A valid Google credential is required.');

  var info;
  try {
    var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return fail_(401, 'Unable to verify your Google account.');
    info = JSON.parse(resp.getContentText());
  } catch (e) {
    return fail_(401, 'Unable to verify your Google account.');
  }
  if (info.aud !== clientId) return fail_(401, 'Unable to verify your Google account.');
  if (!info.sub || !info.email || String(info.email_verified) !== 'true') {
    return fail_(401, 'Google did not provide a verified email address.');
  }

  var users = readTable_('Users');
  var wanted = String(info.email).toLowerCase();
  var user = findUserBy_(users, function (u) { return String(u.email).toLowerCase() === wanted; });
  if (!user) {
    var id = nextId_('Users');
    insertRow_('Users', {
      id: id, name: String(info.name || wanted.split('@')[0]).slice(0, 255), email: info.email, phone: '',
      password: '', address: '', profileImage: ''
    });
    user = findUserBy_(readTable_('Users'), function (u) { return u.id === id; });
  }
  return ok_({ message: 'Google sign-in successful', user: publicUser_(user), token: createCustomerToken_(user) });
}
