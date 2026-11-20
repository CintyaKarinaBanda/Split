import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, transaction } from './db.js';
import { route } from './route.js';

const SESSION_COOKIE = '__Host-split';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const INVITE_SECONDS = 24 * 60 * 60;
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const validToken = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };

export async function configureAccess(app, { enabled, ownerKey }) {
  const error = (res, status, message) => res.status(status).json({ error: message });
  if (!enabled) {
    app.get('/api/session', route(async (_req, res) => res.json({ private: false, signed_in: true, owner: true })));
    return;
  }
  if (!validToken(ownerKey)) throw new Error('SPLIT_OWNER_KEY debe ser una clave aleatoria de 32 bytes en base64url.');
  const ownerTag = hash(ownerKey);
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS access_sessions (
      token_hash TEXT PRIMARY KEY,
      owner_tag TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_grants (
      token_hash TEXT NOT NULL REFERENCES access_sessions(token_hash) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY(token_hash, group_id)
    );
    CREATE TABLE IF NOT EXISTS plan_invites (
      token_hash TEXT PRIMARY KEY,
      group_id INTEGER UNIQUE NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `));
  const readSession = db.prepare('SELECT * FROM access_sessions WHERE token_hash=? AND expires_at>?');
  const createSession = db.prepare('INSERT INTO access_sessions (token_hash,owner_tag,expires_at) VALUES (?,?,?)');
  const dropSession = db.prepare('DELETE FROM access_sessions WHERE token_hash=?');
  const hasGrant = db.prepare('SELECT 1 FROM access_grants WHERE token_hash=? AND group_id=?');
  const getInvite = db.prepare('SELECT group_id FROM plan_invites WHERE token_hash=? AND expires_at>?');
  const dropInvite = db.prepare('DELETE FROM plan_invites WHERE token_hash=?');
  const grant = db.prepare('INSERT OR IGNORE INTO access_grants (token_hash,group_id) VALUES (?,?)');
  const purgeSessions = db.prepare('DELETE FROM access_sessions WHERE expires_at<=?');
  const purgeGrants = db.prepare('DELETE FROM access_grants WHERE token_hash IN (SELECT token_hash FROM access_sessions WHERE expires_at<=?)');

  app.use('/api', route(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin
      && origin !== (process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`)) {
      return error(res, 403, 'Origen de la solicitud no permitido.');
    }
    const raw = req.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
    const session = validToken(raw) ? (await readSession.get(hash(raw), now())) : null;
    if (session && (!session.owner_tag || session.owner_tag === ownerTag)) {
      req.access = { id: session.token_hash, owner: Boolean(session.owner_tag) };
    }
    next();
  }));

  const describe = access => ({ private: true, signed_in: Boolean(access), owner: Boolean(access?.owner) });
  const setCookie = (res, value) => res.cookie(SESSION_COOKIE, value, { ...cookieOptions, maxAge: SESSION_SECONDS * 1000 });
  app.get('/api/session', route(async (req, res) => res.json(describe(req.access))));
  app.post('/api/session', route(async (req, res) => {
    const { code } = req.body ?? {};
    if (!validToken(code)) return error(res, 400, 'Ingresa una clave o invitación válida.');
    const digest = hash(code);
    const owner = timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(ownerTag, 'hex'));
    if (!owner && !(await getInvite.get(digest, now()))) {
      return error(res, 401, 'La clave o invitación no es válida, ya se usó o venció.');
    }
    const value = token();
    const sessionId = hash(value);
    const result = await transaction(async () => {
      const timestamp=now();
      await purgeGrants.run(timestamp);
      await purgeSessions.run(timestamp);
      const existing=req.access&&await readSession.get(req.access.id,timestamp)?req.access:null;
      if (owner) {
        (await createSession.run(sessionId, ownerTag, now() + SESSION_SECONDS));
        if (existing?.owner) (await dropSession.run(existing.id));
        return { owner: true, newSession: true };
      }
      const invite = (await getInvite.get(digest, now()));
      if (!invite) return null;
      if (!existing) (await createSession.run(sessionId, null, now() + SESSION_SECONDS));
      if (!existing?.owner) (await grant.run(existing?.id ?? sessionId, invite.group_id));
      (await dropInvite.run(digest));
      return { owner: Boolean(existing?.owner), newSession: !existing };
    });
    if (!result) return error(res, 401, 'La clave o invitación no es válida, ya se usó o venció.');
    if (result.newSession) setCookie(res, value);
    return res.json(describe(result));
  }));
  app.delete('/api/session', route(async (req, res) => {
    if (req.access) await transaction(async () => {
      await db.prepare('DELETE FROM access_grants WHERE token_hash=?').run(req.access.id);
      await dropSession.run(req.access.id);
    });
    res.clearCookie(SESSION_COOKIE, cookieOptions).json(describe(null));
  }));

  app.use('/api/groups', route(async (req, res, next) => {
    if (!req.access) return error(res, 401, 'Inicia sesión para ver tus planes.');
    if (req.access.owner) return next();
    const groupPath = /^\/(\d+)(?:\/|$)/.exec(req.path);
    if (!groupPath && req.method === 'GET' && req.path === '/') return next();
    if (groupPath && (await hasGrant.get(req.access.id, Number(groupPath[1])))) {
      const ownerOnly = /^\/\d+\/(?:invite|guest-access)(?:\/|$)/.test(req.path)
        || (req.method === 'DELETE' && /^\/\d+\/?$/.test(req.path));
      if (ownerOnly) return error(res, 403, 'Solo la persona administradora puede realizar esta acción.');
      return next();
    }
    return error(res, 404, 'Plan no disponible.');
  }));

  app.post('/api/groups/:id/invite', route(async (req, res) => {
    if (!req.access?.owner) return error(res, 403, 'Solo la persona administradora puede generar invitaciones.');
    const id = Number(req.params.id);
    const code = token();
    const invite=await db.prepare(`INSERT INTO plan_invites (token_hash,group_id,expires_at)
      SELECT ?,id,? FROM groups WHERE id=?
      ON CONFLICT(group_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at`)
      .run(hash(code), now() + INVITE_SECONDS,id);
    if(!invite.changes)return error(res,404,'Plan no disponible.');
    return res.status(201).json({ code });
  }));
  app.delete('/api/groups/:id/guest-access', route(async (req, res) => {
    if (!req.access?.owner) return error(res, 403, 'Solo la persona administradora puede revocar accesos.');
    const id = Number(req.params.id);
    (await transaction(async () => {
      (await db.prepare('DELETE FROM plan_invites WHERE group_id=?').run(id));
      (await db.prepare('DELETE FROM access_grants WHERE group_id=?').run(id));
    }));
    return res.json({ ok: true });
  }));
}
