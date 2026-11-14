'use strict';
// All settings come from environment variables (see DEPLOY.md).
const crypto = require('node:crypto');

const env = process.env;
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${env.PORT || 4747}`).replace(/\/+$/, '');
const isHttps = PUBLIC_URL.startsWith('https://');
const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(PUBLIC_URL);
const production = env.NODE_ENV === 'production';

let secret = env.SESSION_SECRET || '';
if (secret.length < 32) {
  if (production) {
    console.error('FATAL: SESSION_SECRET must be set to at least 32 random characters in production.');
    process.exit(1);
  }
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[cloud-swat] SESSION_SECRET not set: using a temporary one (logins reset on restart).');
}

module.exports = {
  APP_NAME: 'Cloud SWAT',
  VERSION: '1.0.0',
  PORT: Number(env.PORT || 4747),
  PUBLIC_URL,
  ORIGIN: new URL(PUBLIC_URL).origin,
  isHttps,
  production,
  TRUST_PROXY: env.TRUST_PROXY === '1',
  SECRET: secret,
  DB_PATH: env.DB_PATH || './data/cloud-swat.db',
  RETENTION_DAYS: Math.max(1, Number(env.RETENTION_DAYS || 30)),
  // Optional: show an estimated cost if you set a blended price per million tokens.
  PRICE_PER_MTOK: env.PRICE_PER_MTOK ? Number(env.PRICE_PER_MTOK) : null,
  GITHUB: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    ? { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET } : null,
  GOOGLE: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET } : null,
  // Test-only login. Refused unless the site runs on localhost and not in production.
  DEV_LOGIN: env.DEV_LOGIN === '1' && isLocal && !production,
};
