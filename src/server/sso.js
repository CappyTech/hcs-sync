import jwt from 'jsonwebtoken';

const COOKIE_NAME = process.env.HCS_SSO_COOKIE_NAME || 'hcs_sso';
const ISSUER = process.env.HCS_SSO_ISSUER || 'hcs-app';
const AUDIENCE = process.env.HCS_SSO_AUDIENCE || 'hcs-sync';
const SECRET = process.env.HCS_SSO_JWT_SECRET || '';
const LOGIN_URL = process.env.HCS_SSO_LOGIN_URL || 'https://app.heroncs.co.uk/sso/hcs-sync';

function verifyToken(token) {
  if (!SECRET) throw new Error('HCS_SSO_JWT_SECRET is not configured');
  return jwt.verify(token, SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function optionalSso(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return next();
    const payload = verifyToken(token);
    // Attach minimal user context
    req.user = {
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      sso: true,
    };
  } catch {}
  next();
}

export function ensureSsoAuthenticated(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      const returnTo = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
      const url = new URL(LOGIN_URL);
      url.searchParams.set('return_to', returnTo.toString());
      return res.redirect(url.toString());
    }
    const payload = verifyToken(token);
    req.user = {
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      sso: true,
    };
    next();
  } catch (err) {
    // Invalid token → force re-login
    const returnTo = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
    const url = new URL(LOGIN_URL);
    url.searchParams.set('return_to', returnTo.toString());
    return res.redirect(url.toString());
  }
}
