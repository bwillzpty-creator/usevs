const crypto = require('crypto');
const fs = require('fs/promises');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com'
]);
const SESSION_COOKIE = 'usevs_issuer_session';
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const EMAIL_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_BUSINESS_DOCUMENT_BYTES = 5 * 1024 * 1024;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getEmailDomain(value) {
  const normalized = normalizeEmail(value);
  return normalized.includes('@') ? normalized.split('@').pop() : '';
}

function isCorporateEmail(value) {
  const email = normalizeEmail(value);
  const domain = getEmailDomain(email);
  return email.length <= 254 && EMAIL_PATTERN.test(email) && !FREE_EMAIL_DOMAINS.has(domain);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function readEncryptionKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  return key.length === 32 ? key : null;
}

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const [saltHex, hashHex] = storedHash.split(':');
  if (!/^[a-f\d]{32}$/i.test(saltHex || '') || !/^[a-f\d]{128}$/i.test(hashHex || '')) return false;
  const calculated = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return safeEqual(calculated.toString('hex'), hashHex);
}

function parseBusinessDocument(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Business document must be a base64 data URL.');
  const match = /^data:(application\/pdf|image\/(?:png|jpeg));base64,([a-z\d+/=]+)$/i.exec(value);
  if (!match) throw new Error('Business document must be a PDF, PNG, or JPEG file.');
  const contents = Buffer.from(match[2], 'base64');
  if (!contents.length || contents.length > MAX_BUSINESS_DOCUMENT_BYTES) {
    throw new Error('Business document must be smaller than 5 MB.');
  }
  const validSignature = match[1] === 'application/pdf'
    ? contents.subarray(0, 5).toString() === '%PDF-'
    : match[1] === 'image/png'
      ? contents.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : contents.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (!validSignature) throw new Error('Business document content does not match its file type.');
  return { mediaType: match[1], contents: contents.toString('base64') };
}

class IssuerAuth {
  constructor({ storePath, encryptionKey, emailTransport, emailFrom, publicBaseUrl, reviewToken }) {
    this.storePath = storePath;
    this.encryptionKey = readEncryptionKey(encryptionKey);
    this.emailTransport = emailTransport;
    this.emailFrom = emailFrom;
    this.publicBaseUrl = typeof publicBaseUrl === 'string' ? publicBaseUrl.replace(/\/+$/, '') : '';
    this.reviewToken = typeof reviewToken === 'string' && reviewToken.length >= 32 ? reviewToken : '';
    this.challenges = new Map();
    this.sessions = new Map();
    this.loginRate = new Map();
    this.registrationRate = new Map();
    this.storeQueue = Promise.resolve();
  }

  async initialize() {
    try {
      await fs.access(this.storePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.writeFile(this.storePath, '{"employers":[]}', { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch((writeError) => {
        if (writeError.code !== 'EEXIST') throw writeError;
      });
    }
  }

  async ensureReviewAccount(password) {
    const email = 'review@us-evs.com';
    return this.updateStore((store) => {
      const alreadyExists = store.employers.some((employer) =>
        employer.officers.some((officer) => normalizeEmail(officer.email) === email));
      if (alreadyExists) return false;

      const now = new Date().toISOString();
      store.employers.push({
        id: crypto.randomUUID(),
        legalName: 'US-EVS Review Account',
        businessAddress: '100 Main Street',
        businessPhone: '202-555-0100',
        businessEmail: email,
        domain: getEmailDomain(email),
        status: 'verified',
        emailVerifiedAt: now,
        verifiedAt: now,
        createdAt: now,
        businessDocument: null,
        officers: [{
          id: crypto.randomUUID(),
          fullName: 'US-EVS Reviewer',
          title: 'Verified User / Full Access',
          email,
          passwordHash: hashPassword(password),
          active: true,
          createdAt: now
        }]
      });
      return true;
    });
  }

  async readStore() {
    const value = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
    if (!value || !Array.isArray(value.employers)) throw new Error('Issuer account storage is invalid.');
    return value;
  }

  updateStore(update) {
    const write = async () => {
      const store = await this.readStore();
      const result = await update(store);
      const temporaryPath = `${this.storePath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.storePath);
      return result;
    };
    const pending = this.storeQueue.then(write, write);
    this.storeQueue = pending.catch(() => {});
    return pending;
  }

  encryptSensitive(value) {
    if (!this.encryptionKey) throw new Error('DATA_ENCRYPTION_KEY must be a valid 32-byte key.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  decryptSensitive(envelope) {
    if (!this.encryptionKey) throw new Error('DATA_ENCRYPTION_KEY must be a valid 32-byte key.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  encryptRetainedSensitive(value) {
    if (!this.encryptionKey) throw new Error('DATA_ENCRYPTION_KEY must be a valid 32-byte key.');
    const dataKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      keyEnvelope: this.encryptSensitive(dataKey.toString('base64')),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  decryptRetainedSensitive(envelope) {
    const dataKey = Buffer.from(this.decryptSensitive(envelope.keyEnvelope), 'base64');
    if (dataKey.length !== 32) throw new Error('Encrypted letter key is invalid.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  async registerEmployer(input, remoteAddress) {
    if (!this.emailTransport || !this.publicBaseUrl) {
      throw new Error('Employer registration requires configured email delivery and PUBLIC_BASE_URL.');
    }
    if (!this.encryptionKey) throw new Error('Employer registration requires DATA_ENCRYPTION_KEY.');
    const nowTime = Date.now();
    const registrationKey = remoteAddress || 'unknown';
    for (const [key, limit] of this.registrationRate) {
      if (limit.resetAt < nowTime) this.registrationRate.delete(key);
    }
    if (this.registrationRate.size > 5000) throw new Error('Employer registration is temporarily unavailable.');
    const registrationLimit = this.registrationRate.get(registrationKey) || { attempts: 0, resetAt: nowTime + 60 * 60 * 1000 };
    if (registrationLimit.resetAt < nowTime) {
      registrationLimit.attempts = 0;
      registrationLimit.resetAt = nowTime + 60 * 60 * 1000;
    }
    registrationLimit.attempts += 1;
    this.registrationRate.set(registrationKey, registrationLimit);
    if (registrationLimit.attempts > 5) throw new Error('Too many employer registration attempts. Try again later.');

    const legalName = typeof input.legalBusinessName === 'string' ? input.legalBusinessName.trim() : '';
    const businessAddress = typeof input.businessAddress === 'string' ? input.businessAddress.trim() : '';
    const businessPhone = typeof input.businessPhone === 'string' ? input.businessPhone.trim() : '';
    const businessEmail = normalizeEmail(input.businessEmail);
    const officerEmail = normalizeEmail(input.officerEmail);
    const officerName = typeof input.officerName === 'string' ? input.officerName.trim() : '';
    const officerTitle = typeof input.officerTitle === 'string' ? input.officerTitle.trim() : '';
    const domain = getEmailDomain(businessEmail);

    if (!legalName || legalName.length > 200 || !businessAddress || businessAddress.length > 300 ||
      !/^[+()\d .-]{7,30}$/.test(businessPhone) || !isCorporateEmail(businessEmail) ||
        !isCorporateEmail(officerEmail) || getEmailDomain(officerEmail) !== domain ||
      !officerName || officerName.length > 160 || !officerTitle || officerTitle.length > 120) {
      throw new Error('Provide the legal business name, address, phone, and matching corporate emails for the business and HR signatory.');
    }

    const officerPasswordHash = hashPassword(input.officerPassword);
    const businessDocument = parseBusinessDocument(input.businessDocument);
    const emailToken = crypto.randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const employer = {
      id: crypto.randomUUID(),
      legalName,
      businessAddress,
      businessPhone,
      businessEmail,
      domain,
      status: 'pending_email',
      emailTokenHash: digest(emailToken),
      emailTokenExpiresAt: Date.now() + EMAIL_TOKEN_LIFETIME_MS,
      emailVerifiedAt: null,
      verifiedAt: null,
      createdAt: now,
      businessDocument: businessDocument ? this.encryptSensitive(JSON.stringify(businessDocument)) : null,
      officers: [{
        id: crypto.randomUUID(),
        fullName: officerName,
        title: officerTitle,
        email: officerEmail,
        passwordHash: officerPasswordHash,
        active: true,
        createdAt: now
      }]
    };

    await this.updateStore((store) => {
      const existing = store.employers.some((entry) => entry.businessEmail === businessEmail ||
        entry.officers.some((officer) => officer.email === officerEmail));
      if (existing) throw new Error('An account already exists for this business or signatory email.');
      store.employers.push(employer);
    });

    const confirmationUrl = `${this.publicBaseUrl}/api/employers/confirm?token=${encodeURIComponent(emailToken)}`;
    try {
      await this.emailTransport.sendMail({
        from: this.emailFrom,
        to: businessEmail,
        subject: 'Confirm your employer account',
        text: `Confirm the corporate email for ${legalName}: ${confirmationUrl}\n\nAfter confirmation, the account must pass business review before letters can be issued.`
      });
    } catch (error) {
      await this.updateStore((store) => {
        store.employers = store.employers.filter((entry) => entry.id !== employer.id);
      });
      throw new Error('Unable to send employer confirmation email.');
    }
    return { employerId: employer.id };
  }

  async confirmEmployerEmail(token) {
    if (typeof token !== 'string' || !token) return false;
    return this.updateStore((store) => {
      const employer = store.employers.find((entry) => entry.emailTokenHash && safeEqual(entry.emailTokenHash, digest(token)));
      if (!employer || employer.emailTokenExpiresAt < Date.now()) return false;
      employer.emailVerifiedAt = new Date().toISOString();
      employer.status = 'pending_review';
      delete employer.emailTokenHash;
      delete employer.emailTokenExpiresAt;
      return true;
    });
  }

  async approveEmployer(employerId) {
    return this.updateStore((store) => {
      const employer = store.employers.find((entry) => entry.id === employerId);
      if (!employer || !employer.emailVerifiedAt || employer.status !== 'pending_review') return false;
      employer.status = 'verified';
      employer.verifiedAt = new Date().toISOString();
      employer.businessDocument = null;
      return true;
    });
  }

  isValidReviewToken(value) {
    return Boolean(this.reviewToken) && safeEqual(this.reviewToken, value);
  }

  async getBusinessDocument(employerId) {
    const store = await this.readStore();
    const employer = store.employers.find((entry) => entry.id === employerId && entry.status === 'pending_review');
    if (!employer?.businessDocument) return null;
    return JSON.parse(this.decryptSensitive(employer.businessDocument));
  }

  async addOfficer(context, input) {
    const email = normalizeEmail(input.email);
    const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!fullName || fullName.length > 160 || !title || title.length > 120 ||
      !isCorporateEmail(email) || getEmailDomain(email) !== context.employer.domain) {
      throw new Error('Signatory name, title, and an email at the verified corporate domain are required.');
    }
    const passwordHash = hashPassword(input.password);
    return this.updateStore((store) => {
      const employer = store.employers.find((entry) => entry.id === context.employer.id && entry.status === 'verified');
      if (!employer) throw new Error('Verified employer account required.');
      if (store.employers.some((entry) => entry.officers.some((officer) => officer.email === email))) {
        throw new Error('A signatory account already exists for this email.');
      }
      const officer = { id: crypto.randomUUID(), fullName, title, email, passwordHash, active: true, createdAt: new Date().toISOString() };
      employer.officers.push(officer);
      return { id: officer.id, fullName, title, email };
    });
  }

  async beginSignIn(emailValue, password, remoteAddress) {
    if (!this.emailTransport) throw new Error('One-time code delivery is not configured.');
    const email = normalizeEmail(emailValue);
    const now = Date.now();
    if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new Error('Sign-in failed or employer authorization is incomplete.');
    const rateKey = `${remoteAddress || 'unknown'}:${email}`;
    for (const [key, limit] of this.loginRate) {
      if (limit.resetAt < now) this.loginRate.delete(key);
    }
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt < now) this.challenges.delete(id);
    }
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(hash);
    }
    if (this.loginRate.size > 10000 || this.challenges.size > 10000) {
      throw new Error('Sign-in is temporarily unavailable.');
    }
    const rate = this.loginRate.get(rateKey) || { attempts: 0, resetAt: now + 15 * 60 * 1000 };
    if (rate.resetAt < now) {
      rate.attempts = 0;
      rate.resetAt = now + 15 * 60 * 1000;
    }
    rate.attempts += 1;
    this.loginRate.set(rateKey, rate);
    if (rate.attempts > 10) throw new Error('Too many sign-in attempts. Try again later.');

    const store = await this.readStore();
    let employer;
    let officer;
    for (const entry of store.employers) {
      const found = entry.officers.find((item) => item.email === email);
      if (found) {
        employer = entry;
        officer = found;
        break;
      }
    }
    if (!employer || !officer || !officer.active || employer.status !== 'verified' ||
        !verifyPassword(password, officer.passwordHash)) {
      throw new Error('Sign-in failed or employer authorization is incomplete.');
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const challengeId = crypto.randomBytes(24).toString('base64url');
    await this.emailTransport.sendMail({
      from: this.emailFrom,
      to: officer.email,
      subject: 'Your HR sign-in verification code',
      text: `Your one-time sign-in code is ${code}. It expires in 10 minutes. Do not share this code.`
    });
    this.challenges.set(challengeId, {
      employerId: employer.id,
      officerId: officer.id,
      codeHash: digest(code),
      expiresAt: now + CHALLENGE_LIFETIME_MS,
      attempts: 0
    });
    return { challengeId };
  }

  async completeSignIn(challengeId, code) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.attempts >= 5) {
      this.challenges.delete(challengeId);
      throw new Error('Verification code is invalid or expired.');
    }
    challenge.attempts += 1;
    if (!safeEqual(challenge.codeHash, digest(String(code || '')))) {
      if (challenge.attempts >= 5) this.challenges.delete(challengeId);
      throw new Error('Verification code is invalid or expired.');
    }
    this.challenges.delete(challengeId);
    const store = await this.readStore();
    const employer = store.employers.find((entry) => entry.id === challenge.employerId && entry.status === 'verified');
    const officer = employer?.officers.find((entry) => entry.id === challenge.officerId && entry.active);
    if (!employer || !officer) throw new Error('Employer or signatory authorization is no longer active.');
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(digest(token), {
      employerId: employer.id,
      officerId: officer.id,
      expiresAt: Date.now() + SESSION_LIFETIME_MS
    });
    return { token, employer: this.publicEmployer(employer), officer: this.publicOfficer(officer) };
  }

  readSessionToken(request) {
    const cookie = request.headers.cookie || '';
    const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    return token ? decodeURIComponent(token.slice(SESSION_COOKIE.length + 1)) : '';
  }

  async getSession(request) {
    const token = this.readSessionToken(request);
    const tokenHash = digest(token);
    const session = this.sessions.get(tokenHash);
    if (!token || !session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(tokenHash);
      return null;
    }
    for (const [hash, current] of this.sessions) {
      if (current.expiresAt <= Date.now()) this.sessions.delete(hash);
    }
    const store = await this.readStore();
    const employer = store.employers.find((entry) => entry.id === session.employerId && entry.status === 'verified');
    const officer = employer?.officers.find((entry) => entry.id === session.officerId && entry.active);
    if (!employer || !officer) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return { employer: this.publicEmployer(employer), officer: this.publicOfficer(officer) };
  }

  logout(request) {
    const token = this.readSessionToken(request);
    if (token) this.sessions.delete(digest(token));
  }

  publicEmployer(employer) {
    return {
      id: employer.id,
      legalName: employer.legalName,
      businessAddress: employer.businessAddress,
      businessPhone: employer.businessPhone,
      businessEmail: employer.businessEmail,
      status: employer.status,
      verifiedAt: employer.verifiedAt
    };
  }

  publicOfficer(officer) {
    return { id: officer.id, fullName: officer.fullName, title: officer.title, email: officer.email };
  }
}

module.exports = {
  IssuerAuth,
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
  isCorporateEmail,
  normalizeEmail,
  hashPassword,
  verifyPassword
};