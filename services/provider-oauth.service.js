const crypto = require('node:crypto');

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_PROFILE_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_KEYS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_AUTHORIZATION_ENDPOINT = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
const APPLE_KEYS_ENDPOINT = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

function decodeJwtSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function createAppleClientSecret({ clientId, clientSecret, nowSeconds = () => Math.floor(Date.now() / 1000) }) {
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) throw new Error('Apple OAuth client secret is not configured.');
  if (clientSecret.trim().startsWith('-----BEGIN')) {
    throw new Error('APPLE_CLIENT_SECRET must be a signed Apple client-secret JWT; signing keys are not configured.');
  }
  const segments = clientSecret.split('.');
  if (segments.length !== 3) throw new Error('APPLE_CLIENT_SECRET must be a signed Apple client-secret JWT.');
  const claims = decodeJwtSegment(segments[1]);
  if (claims.aud !== APPLE_ISSUER || claims.sub !== clientId ||
      !Number.isFinite(claims.exp) || claims.exp <= nowSeconds() ||
      !Number.isFinite(claims.iat) || claims.iat > nowSeconds() + 60) {
    throw new Error('APPLE_CLIENT_SECRET JWT must be valid for the configured client ID.');
  }
  return clientSecret;
}

function createProviderOAuthService({ env = process.env, fetchImpl = globalThis.fetch, nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  let googleKeyCache = { expiresAt: 0, keys: [] };
  let appleKeyCache = { expiresAt: 0, keys: [] };

  function callbackUrl(provider, origin) {
    const configuredBaseUrl = env.PUBLIC_BASE_URL || (env.NODE_ENV === 'production' ? '' : origin);
    const baseUrl = String(configuredBaseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('PUBLIC_BASE_URL is required for provider sign-in in production.');
    const parsedBaseUrl = new URL(baseUrl);
    if (env.NODE_ENV === 'production' && parsedBaseUrl.protocol !== 'https:') {
      throw new Error('Provider sign-in requires an HTTPS PUBLIC_BASE_URL in production.');
    }
    return `${baseUrl}/api/auth/${provider}/callback`;
  }

  function getAuthorizationUrl(provider, { origin, state, nonce }) {
    const redirectUri = callbackUrl(provider, origin);
    if (provider === 'google') {
      if (!env.GOOGLE_CLIENT_ID) throw new Error('Google OAuth is not configured.');
      const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        state,
        nonce,
        prompt: 'select_account'
      }).toString();
      return url.toString();
    }
    if (provider === 'apple') {
      if (!env.APPLE_CLIENT_ID) throw new Error('Apple OAuth is not configured.');
      const url = new URL(APPLE_AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: env.APPLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: 'name email',
        state,
        nonce
      }).toString();
      return url.toString();
    }
    throw new Error('Unsupported OAuth provider.');
  }

  async function readJson(response, label) {
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`${label} returned invalid JSON.`, { cause: error });
    }
    if (!response.ok) throw new Error(body?.error_description || body?.error?.message || `${label} request failed with HTTP ${response.status}.`);
    return body;
  }

  async function getGoogleKeys() {
    if (googleKeyCache.expiresAt > nowSeconds() && googleKeyCache.keys.length) return googleKeyCache.keys;
    const response = await fetchImpl(GOOGLE_KEYS_ENDPOINT);
    const body = await readJson(response, 'Google signing keys');
    if (!Array.isArray(body.keys) || !body.keys.length) throw new Error('Google signing keys response was invalid.');
    googleKeyCache = { expiresAt: nowSeconds() + 3600, keys: body.keys };
    return body.keys;
  }

  async function verifyGoogleIdentityToken(idToken, expectedNonce) {
    if (typeof idToken !== 'string') throw new Error('Google did not return an identity token.');
    const [encodedHeader, encodedClaims, encodedSignature, extra] = idToken.split('.');
    if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined) {
      throw new Error('Google identity token is malformed.');
    }
    const header = decodeJwtSegment(encodedHeader);
    const claims = decodeJwtSegment(encodedClaims);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new Error('Google identity token uses an unsupported signing algorithm.');
    }
    const key = (await getGoogleKeys()).find((candidate) => candidate.kid === header.kid && candidate.alg === 'RS256');
    if (!key) throw new Error('Google identity token signing key was not found.');
    const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
    const validSignature = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url')
    );
    if (!validSignature) throw new Error('Google identity token signature is invalid.');
    const audienceMatches = Array.isArray(claims.aud)
      ? claims.aud.includes(env.GOOGLE_CLIENT_ID)
      : claims.aud === env.GOOGLE_CLIENT_ID;
    if (!audienceMatches || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== env.GOOGLE_CLIENT_ID) ||
        !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
        !Number.isFinite(claims.exp) || claims.exp <= nowSeconds() ||
        !Number.isFinite(claims.iat) || claims.iat > nowSeconds() + 60 ||
        claims.nonce !== expectedNonce || typeof claims.sub !== 'string' ||
        typeof claims.email !== 'string' || claims.email_verified !== true) {
      throw new Error('Google identity token claims are invalid.');
    }
    return claims;
  }

  async function exchangeGoogleCode(code, redirectUri, expectedNonce) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('Google OAuth is not configured.');
    const tokenResponse = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    const tokens = await readJson(tokenResponse, 'Google token exchange');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('Google did not return an access token.');
    const claims = await verifyGoogleIdentityToken(tokens.id_token, expectedNonce);
    const profileResponse = await fetchImpl(GOOGLE_PROFILE_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await readJson(profileResponse, 'Google profile');
    if (!profile.sub || !profile.email || profile.email_verified !== true) {
      throw new Error('Google did not provide a verified email and user ID.');
    }
    if (claims.sub !== String(profile.sub) ||
        String(claims.email || '').toLowerCase() !== String(profile.email).toLowerCase()) {
      throw new Error('Google profile does not match its identity token.');
    }
    return { provider: 'google', providerUserId: String(profile.sub), email: String(profile.email).toLowerCase() };
  }

  async function getAppleKeys() {
    if (appleKeyCache.expiresAt > nowSeconds() && appleKeyCache.keys.length) return appleKeyCache.keys;
    const response = await fetchImpl(APPLE_KEYS_ENDPOINT);
    const body = await readJson(response, 'Apple signing keys');
    if (!Array.isArray(body.keys) || !body.keys.length) throw new Error('Apple signing keys response was invalid.');
    appleKeyCache = { expiresAt: nowSeconds() + 3600, keys: body.keys };
    return body.keys;
  }

  async function verifyAppleIdentityToken(idToken, clientId, expectedNonce) {
    if (typeof idToken !== 'string') throw new Error('Apple did not return an identity token.');
    const [encodedHeader, encodedClaims, encodedSignature, extra] = idToken.split('.');
    if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined) {
      throw new Error('Apple identity token is malformed.');
    }
    const header = decodeJwtSegment(encodedHeader);
    const claims = decodeJwtSegment(encodedClaims);
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') {
      throw new Error('Apple identity token uses an unsupported signing algorithm.');
    }
    const key = (await getAppleKeys()).find((candidate) => candidate.kid === header.kid && candidate.alg === header.alg);
    if (!key) throw new Error('Apple identity token signing key was not found.');
    const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
    const signature = Buffer.from(encodedSignature, 'base64url');
    const signingInput = Buffer.from(`${encodedHeader}.${encodedClaims}`);
    let validSignature;
    if (header.alg === 'ES256') {
      if (signature.length !== 64) throw new Error('Apple identity token signature is malformed.');
      const derSignature = joseEcdsaToDer(signature);
      validSignature = crypto.verify('sha256', signingInput, publicKey, derSignature);
    } else {
      validSignature = crypto.verify('RSA-SHA256', signingInput, publicKey, signature);
    }
    if (!validSignature) throw new Error('Apple identity token signature is invalid.');
    if (claims.iss !== APPLE_ISSUER ||
        !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) ||
        !Number.isFinite(claims.exp) || claims.exp <= nowSeconds() ||
        !Number.isFinite(claims.iat) || claims.iat > nowSeconds() + 60) {
      throw new Error('Apple identity token claims are invalid.');
    }
    if (expectedNonce) {
      const hashedNonce = crypto.createHash('sha256').update(expectedNonce).digest('hex');
      if (claims.nonce !== expectedNonce && claims.nonce !== hashedNonce) {
        throw new Error('Apple OAuth nonce validation failed.');
      }
    }
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
      throw new Error('Apple did not provide a verified email.');
    }
    if (!claims.sub || !claims.email) throw new Error('Apple profile is missing its user ID or email.');
    return { provider: 'apple', providerUserId: String(claims.sub), email: String(claims.email).toLowerCase() };
  }

  function joseEcdsaToDer(raw) {
    function integer(value) {
      let first = 0;
      while (first < value.length - 1 && value[first] === 0) first += 1;
      let bytes = value.subarray(first);
      if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
      return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
    }
    const r = integer(raw.subarray(0, 32));
    const s = integer(raw.subarray(32));
    const sequence = Buffer.concat([r, s]);
    return Buffer.concat([Buffer.from([0x30, sequence.length]), sequence]);
  }

  async function exchangeAppleCode(code, redirectUri, expectedNonce) {
    if (!env.APPLE_CLIENT_ID || !env.APPLE_CLIENT_SECRET) throw new Error('Apple OAuth is not configured.');
    const clientSecret = createAppleClientSecret({
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: env.APPLE_CLIENT_SECRET,
      nowSeconds
    });
    const tokenResponse = await fetchImpl(APPLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.APPLE_CLIENT_ID,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    const tokens = await readJson(tokenResponse, 'Apple token exchange');
    return verifyAppleIdentityToken(tokens.id_token, env.APPLE_CLIENT_ID, expectedNonce);
  }

  return {
    callbackUrl,
    exchangeAppleCode,
    exchangeGoogleCode,
    getAuthorizationUrl
  };
}

module.exports = {
  APPLE_ISSUER,
  createAppleClientSecret,
  createProviderOAuthService,
  decodeJwtSegment
};
