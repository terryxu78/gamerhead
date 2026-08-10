import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs, { createReadStream } from 'fs';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { Datastore } from '@google-cloud/datastore';
import { Storage } from '@google-cloud/storage';
import compression from 'compression';
import { GoogleGenAI, Type } from '@google/genai';

const require = createRequire(import.meta.url);
const multer = require('multer');
const execFileAsync = promisify(execFile);

// --- CONFIGURATION ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;

// Default to PRODUCTION unless explicitly 'development'
// This ensures Cloud Run behaves like production even if NODE_ENV is missing
const IS_PRODUCTION = process.env.NODE_ENV !== 'development';

console.log(`[Init] Starting server. Production Mode: ${IS_PRODUCTION}`);

// --- DATABASE SETUP ---
let dbInstance = null;
const mockDbStore = { logs: [] };

const getDb = () => {
    if (dbInstance) return dbInstance;
    try {
        const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
        const databaseId = process.env.DATASTORE_DATABASE || 'gamerhead';
        const opts = { databaseId };
        if (projectId) opts.projectId = projectId;
        console.log(`🔌 [DB] Initializing Datastore — project: ${projectId || 'auto'}, database: ${databaseId}`);
        dbInstance = new Datastore(opts);
        return dbInstance;
    } catch (error) {
        console.warn("⚠️ [DB] Connection failed (using mock):", error.message);
        return null;
    }
};

// --- EXPRESS APP SETUP ---
const app = express();

// 1. TOP LEVEL REQUEST LOGGER
app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
});

app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '50mb' }));

// --- AUTHENTICATION & USER IDENTITY MIDDLEWARE ---
const basicAuthUsersStr = process.env.BASIC_AUTH_USERS;

if (basicAuthUsersStr) {
    // Parse "user1:pass1,user2:pass2" into an array of objects
    const validUsers = basicAuthUsersStr.split(',').map(pair => {
        const [u, p] = pair.split(':');
        return { user: u, pass: p };
    }).filter(u => u.user && u.pass);

    console.log(`🔒 [Auth] Basic Authentication enabled for ${validUsers.length} user(s).`);
    
    app.use((req, res, next) => {
        // Skip auth for health checks
        if (req.path === '/healthz' || req.path === '/api/health') {
            return next();
        }
        
        const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

        if (login && password) {
            const isValid = validUsers.some(u => u.user === login && u.pass === password);
            if (isValid) {
                // Set the user identity for logging
                req.userEmail = login;
                return next();
            }
        }

        res.set('WWW-Authenticate', 'Basic realm="GamerHeads Login"');
        res.status(401).send('Authentication required.');
    });
} else {
    console.log(`🔓 [Auth] No Basic Auth configured. Relying on IAP or public access.`);
    
    // IAP Identity Extraction Middleware
    app.use((req, res, next) => {
        const iapEmail = req.headers['x-goog-authenticated-user-email'];
        if (iapEmail) {
            req.userEmail = iapEmail.replace('accounts.google.com:', '');
        }
        next();
    });
}

// --- GOOGLE SIGN-IN CONFIG ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTHORIZED_USERS = (process.env.AUTHORIZED_USERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const AUTHORIZED_DOMAIN = (process.env.AUTHORIZED_DOMAIN || '').trim().toLowerCase();

// --- ADMIN AUTHORIZATION ---
// Explicit admin allowlist. If unset, fall back to AUTHORIZED_USERS (every
// whitelisted user is an admin — the historical behaviour). If neither is set
// the app is open to any authenticated identity, so admin access is DENIED
// rather than left wide open.
const ADMIN_USERS = (process.env.ADMIN_USERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const adminAllowlist = ADMIN_USERS.length ? ADMIN_USERS : AUTHORIZED_USERS;

const isAdminEmail = (email) => {
    if (!email) return false;
    if (!adminAllowlist.length) return false;
    return adminAllowlist.includes(String(email).trim().toLowerCase());
};

if (ADMIN_USERS.length) {
    console.log(`👑 [Auth] Admins: ${ADMIN_USERS.join(', ')}`);
} else if (AUTHORIZED_USERS.length) {
    console.log(`👑 [Auth] ADMIN_USERS unset — falling back to AUTHORIZED_USERS for admin access.`);
} else {
    console.warn(`⚠️  [Auth] Neither ADMIN_USERS nor AUTHORIZED_USERS is set — /api/admin/* is disabled.`);
}

// Gate for /api/admin/* — must run after identity has been resolved.
const adminOnly = (req, res, next) => {
    if (isAdminEmail(req.userEmail)) return next();
    console.warn(`[Auth] Admin access denied for ${req.userEmail || 'anonymous'} → ${req.originalUrl}`);
    return res.status(403).json({
        error: adminAllowlist.length
            ? 'Admin access required.'
            : 'Admin access is disabled. Set ADMIN_USERS to enable the dashboard.'
    });
};

if (GOOGLE_CLIENT_ID) {
    console.log(`🔐 [Auth] Google Sign-In enabled. Client ID: ${GOOGLE_CLIENT_ID.slice(0, 12)}...`);
    if (AUTHORIZED_USERS.length) console.log(`   Authorized users: ${AUTHORIZED_USERS.join(', ')}`);
    else if (AUTHORIZED_DOMAIN) console.log(`   Authorized domain: ${AUTHORIZED_DOMAIN}`);
    else console.log(`   Any Google account can access.`);
}

// Verify Google ID token using google-auth-library (transitive dep via @google-cloud/datastore)
const verifyGoogleToken = async (idToken) => {
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    return ticket.getPayload(); // { email, name, picture, ... }
};

// --- ROUTES ---

// Health Check (Root) - Useful for load balancers
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

// Health Check (API) - Used by Dashboard
app.get('/api/health', (req, res) => {
    const db = getDb();
    res.json({
        status: 'ok',
        route: '/api/health',
        database: db ? 'connected' : 'mock',
        env: IS_PRODUCTION ? 'production' : 'development',
        timestamp: Date.now()
    });
});

// Public config endpoint — returns non-secret settings needed by the frontend
app.get('/api/config', (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

// Token verification endpoint — called by frontend after Google Sign-In
app.post('/api/auth/verify', async (req, res) => {
    if (!GOOGLE_CLIENT_ID) return res.json({ email: null, name: null, picture: null });

    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    try {
        const payload = await verifyGoogleToken(idToken);
        const email = (payload.email || '').toLowerCase();

        // Check authorization
        if (AUTHORIZED_USERS.length && !AUTHORIZED_USERS.includes(email)) {
            console.warn(`[Auth] Unauthorized login attempt: ${email}`);
            return res.status(403).json({ error: `Access denied. ${email} is not on the authorized users list.` });
        }
        if (AUTHORIZED_DOMAIN && !email.endsWith(`@${AUTHORIZED_DOMAIN}`)) {
            console.warn(`[Auth] Unauthorized domain login attempt: ${email}`);
            return res.status(403).json({ error: `Access denied. Only @${AUTHORIZED_DOMAIN} accounts are allowed.` });
        }

        console.log(`[Auth] Signed in: ${email}`);
        res.json({ email: payload.email, name: payload.name, picture: payload.picture });
    } catch (err) {
        console.error('[Auth] Token verification failed:', err.message);
        res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
    }
});

// Google token verification middleware for all /api/* routes (when enabled)
const googleAuthMiddleware = async (req, res, next) => {
    if (!GOOGLE_CLIENT_ID) return next(); // Auth not configured, skip

    // Skip public endpoints
    const publicPaths = ['/api/health', '/api/config', '/api/auth/verify'];
    if (publicPaths.includes(req.path)) return next();

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }

    try {
        const payload = await verifyGoogleToken(idToken);
        const email = (payload.email || '').toLowerCase();

        if (AUTHORIZED_USERS.length && !AUTHORIZED_USERS.includes(email)) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        if (AUTHORIZED_DOMAIN && !email.endsWith(`@${AUTHORIZED_DOMAIN}`)) {
            return res.status(403).json({ error: 'Access denied.' });
        }

        req.userEmail = payload.email;
        next();
    } catch (err) {
        console.warn('[Auth] Invalid token on API call:', err.message);
        res.status(401).json({ error: 'Token expired or invalid. Please sign in again.' });
    }
};

// API Router
const apiRouter = express.Router();
apiRouter.use(googleAuthMiddleware);

// Identity of the caller. Falls back to a browser-generated id so that
// deployments without any auth still keep each browser's history separate.
const ownerKeyOf = (req) => {
    if (req.userEmail) return String(req.userEmail).toLowerCase();
    const clientId = req.headers['x-gh-user-id'];
    if (typeof clientId === 'string' && clientId.trim()) return `anon:${clientId.trim()}`;
    return null;
};

// GET /api/me — who am I, and am I an admin?
apiRouter.get('/me', (req, res) => {
    res.json({
        email: req.userEmail || null,
        isAdmin: isAdminEmail(req.userEmail),
        adminEnabled: adminAllowlist.length > 0,
    });
});

// ── PROJECT HISTORY ────────────────────────────────────────────────────────
// Datastore kind 'Project' — one entity per saved project, scoped to its owner.
const PROJECT_KIND = 'Project';

// Datastore indexes every property by default and caps indexed values at 1500
// bytes. `excludeFromIndexes` only accepts explicit leaf paths, so listing the
// top-level object name does NOT cover nested fields — a base64
// `avatarConfig.referenceImage` blew up every save with
// `INVALID_ARGUMENT: The value of property "referenceImage" is longer than 1500 bytes`.
// The working set is therefore stored as one unindexed JSON string, and only
// the small fields the history list actually needs stay indexed.
const PROJECT_PAYLOAD_PROPERTY = 'payload';

// Datastore's hard entity limit is ~1 MiB; stay clear of it.
const MAX_PAYLOAD_BYTES = 900 * 1024;

// A gs:// URI is at most bucket(63) + a fixed path, so ~200 bytes is generous.
// This matters because avatarImageGcsUri is client-supplied and gets written to
// an INDEXED property, where Datastore rejects anything over 1500 bytes — the
// same failure class that made every save fail when a base64 reference image
// ended up indexed.
const MAX_GCS_URI_LENGTH = 500;

const isSaneGcsUri = (value) =>
    typeof value === 'string' &&
    value.startsWith('gs://') &&
    value.length <= MAX_GCS_URI_LENGTH;

/**
 * Remove data that must never be persisted in Datastore: inline base64 images
 * and blob/data URLs. They are either huge or meaningless outside the tab that
 * produced them.
 */
const stripHeavyFields = (payload) => {
    const clone = JSON.parse(JSON.stringify(payload ?? {}));

    if (clone.avatarConfig && typeof clone.avatarConfig === 'object') {
        // The inline base64 goes; the gs:// URI it was uploaded to stays, so a
        // restored project can put the reference image back.
        delete clone.avatarConfig.referenceImage;
    }
    if (Array.isArray(clone.avatarHistory)) {
        clone.avatarHistory = clone.avatarHistory
            .filter(a => a && isSaneGcsUri(a.gcsUri))
            .slice(0, 24)
            .map(a => ({
                gcsUri: a.gcsUri,
                prompt: typeof a.prompt === 'string' ? a.prompt.slice(0, 500) : '',
                aspectRatio: a.aspectRatio || null,
                createdAt: a.createdAt || null,
            }));
    }
    if (clone.avatarImageGcsUri !== undefined && clone.avatarImageGcsUri !== null
        && !isSaneGcsUri(clone.avatarImageGcsUri)) {
        console.warn('[Projects] Dropping implausible avatarImageGcsUri');
        delete clone.avatarImageGcsUri;
    }
    if (clone.avatarConfig && clone.avatarConfig.referenceImageGcsUri !== undefined
        && !isSaneGcsUri(clone.avatarConfig.referenceImageGcsUri)) {
        delete clone.avatarConfig.referenceImageGcsUri;
    }
    if (Array.isArray(clone.segments)) {
        clone.segments = clone.segments.map(seg => {
            const s = { ...seg };
            delete s.videoUrl;
            delete s.videoOptions;
            delete s.isGenerating;
            delete s.generatedUsingPrevUrl;
            // A data: URL here means the clip was returned inline and never
            // reached GCS — it cannot be restored, so don't store megabytes of it.
            if (s.videoGcsUri !== undefined && !isSaneGcsUri(s.videoGcsUri)) {
                delete s.videoGcsUri;
            }
            if (Array.isArray(s.videoOptionGcsUris)) {
                s.videoOptionGcsUris = s.videoOptionGcsUris.map(u => (isSaneGcsUri(u) ? u : null));
            }
            return s;
        });
    }
    return clone;
};

const projectToJson = (entity, database) => {
    const key = entity[database.KEY];
    let payload = {};
    try {
        payload = entity[PROJECT_PAYLOAD_PROPERTY] ? JSON.parse(entity[PROJECT_PAYLOAD_PROPERTY]) : {};
    } catch (err) {
        console.warn('[Projects] Corrupt payload, returning empty project body:', err.message);
    }
    return {
        id: String(key.id || key.name),
        name: entity.name || 'Untitled project',
        ownerEmail: entity.ownerEmail,
        gameInfo: payload.gameInfo || null,
        avatarConfig: payload.avatarConfig || null,
        scriptText: payload.scriptText || null,
        segments: payload.segments || [],
        exports: payload.exports || [],
        avatarImageGcsUri: payload.avatarImageGcsUri || null,
        avatarHistory: payload.avatarHistory || [],
        gameplayFileMeta: payload.gameplayFileMeta || null,
        createdAt: entity.createdAt ? new Date(entity.createdAt).getTime() : null,
        updatedAt: entity.updatedAt ? new Date(entity.updatedAt).getTime() : null,
    };
};

// GET /api/projects — list the caller's projects, newest first (summaries only)
apiRouter.get('/projects', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.json({ projects: [] });

    try {
        const query = database.createQuery(PROJECT_KIND).filter('ownerEmail', '=', owner);
        const [entities] = await database.runQuery(query);
        const projects = entities
            .map(e => ({
                id: String(e[database.KEY].id || e[database.KEY].name),
                name: e.name || 'Untitled project',
                gameTitle: e.gameTitle || null,
                gameUrl: e.gameUrl || null,
                targetAspectRatio: e.targetAspectRatio || null,
                layoutType: e.layoutType || null,
                segmentCount: e.segmentCount || 0,
                exportCount: e.exportCount || 0,
                hasScript: Boolean(e.hasScript),
                hasAvatar: Boolean(e.hasAvatar),
                avatarImageGcsUri: e.avatarImageGcsUri || null,
                createdAt: e.createdAt ? new Date(e.createdAt).getTime() : null,
                updatedAt: e.updatedAt ? new Date(e.updatedAt).getTime() : null,
            }))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 100);
        res.json({ projects });
    } catch (err) {
        console.error('[Projects] list failed:', err);
        res.status(500).json({ error: 'Failed to list projects: ' + err.message });
    }
});

// GET /api/projects/:id — full project payload (owner only)
apiRouter.get('/projects/:id', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.status(404).json({ error: 'Project not found' });

    try {
        const key = database.key([PROJECT_KIND, database.int(req.params.id)]);
        const [entity] = await database.get(key);
        if (!entity) return res.status(404).json({ error: 'Project not found' });
        if (entity.ownerEmail !== owner) {
            console.warn(`[Projects] ${owner} tried to read project owned by ${entity.ownerEmail}`);
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json(projectToJson(entity, database));
    } catch (err) {
        console.error('[Projects] get failed:', err);
        res.status(500).json({ error: 'Failed to load project: ' + err.message });
    }
});

// POST /api/projects — create or update. Body: { id?, name, gameInfo, avatarConfig,
// scriptText, segments, exports, avatarImageGcsUri }
apiRouter.post('/projects', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.status(503).json({ error: 'Datastore unavailable; project not saved.' });

    const { id, name, gameInfo, avatarConfig, scriptText, segments,
            exports: exportList, avatarImageGcsUri, avatarHistory,
            gameplayFileMeta } = req.body || {};

    try {
        const now = new Date();
        let key;
        let createdAt = now;

        if (id) {
            key = database.key([PROJECT_KIND, database.int(id)]);
            const [existing] = await database.get(key);
            if (!existing) return res.status(404).json({ error: 'Project not found' });
            if (existing.ownerEmail !== owner) {
                console.warn(`[Projects] ${owner} tried to overwrite project owned by ${existing.ownerEmail}`);
                return res.status(404).json({ error: 'Project not found' });
            }
            createdAt = existing.createdAt ? new Date(existing.createdAt) : now;
        } else {
            key = database.key([PROJECT_KIND]);
        }

        const body = stripHeavyFields({
            gameInfo: gameInfo || null,
            avatarConfig: avatarConfig || null,
            scriptText: typeof scriptText === 'string' ? scriptText : null,
            segments: Array.isArray(segments) ? segments : [],
            exports: Array.isArray(exportList) ? exportList : [],
            avatarImageGcsUri: avatarImageGcsUri || null,
            avatarHistory: Array.isArray(avatarHistory) ? avatarHistory : [],
            gameplayFileMeta: gameplayFileMeta || null,
        });

        const payload = JSON.stringify(body);
        if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
            return res.status(413).json({
                error: 'Project is too large to save. Try trimming the script or the number of clips.'
            });
        }

        const data = {
            ownerEmail: owner,
            name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 200) : 'Untitled project',
            // Indexed summary fields for the history list. Truncated so they can
            // never trip the 1500-byte index limit.
            gameTitle: (body.gameInfo?.title || '').slice(0, 300) || null,
            gameUrl: (body.gameInfo?.url || '').slice(0, 500) || null,
            targetAspectRatio: body.gameInfo?.targetAspectRatio || null,
            layoutType: body.gameInfo?.layoutType || null,
            segmentCount: body.segments.length,
            exportCount: body.exports.length,
            hasScript: Boolean(body.scriptText),
            hasAvatar: Boolean(body.avatarImageGcsUri),
            avatarImageGcsUri: body.avatarImageGcsUri || null,
            createdAt,
            updatedAt: now,
            [PROJECT_PAYLOAD_PROPERTY]: payload,
        };

        await database.save({ key, data, excludeFromIndexes: [PROJECT_PAYLOAD_PROPERTY] });
        const savedId = String(key.id || key.name);
        console.log(`[Projects] Saved ${savedId} for ${owner} (${Buffer.byteLength(payload, 'utf8')} bytes)`);
        res.json({ id: savedId, updatedAt: now.getTime(), createdAt: createdAt.getTime() });
    } catch (err) {
        console.error('[Projects] save failed:', err);
        res.status(500).json({ error: 'Failed to save project: ' + err.message });
    }
});

// DELETE /api/projects/:id — owner only
apiRouter.delete('/projects/:id', async (req, res) => {
    const owner = ownerKeyOf(req);
    if (!owner) return res.status(401).json({ error: 'Cannot determine caller identity.' });

    const database = getDb();
    if (!database) return res.status(503).json({ error: 'Datastore unavailable.' });

    try {
        const key = database.key([PROJECT_KIND, database.int(req.params.id)]);
        const [entity] = await database.get(key);
        if (!entity) return res.status(404).json({ error: 'Project not found' });
        if (entity.ownerEmail !== owner) {
            return res.status(404).json({ error: 'Project not found' });
        }
        await database.delete(key);
        res.json({ deleted: true });
    } catch (err) {
        console.error('[Projects] delete failed:', err);
        res.status(500).json({ error: 'Failed to delete project: ' + err.message });
    }
});

apiRouter.post('/log', async (req, res) => {
    const entry = {
        ...req.body,
        userEmail: req.userEmail || req.body.userEmail || null,
        timestamp: req.body.timestamp ? new Date(req.body.timestamp) : new Date(),
        _serverTime: new Date()
    };

    const database = getDb();
    try {
        if (database) {
            try {
                // Datastore API: Create a key and entity
                const key = database.key('GenerationLog');
                const entity = {
                    key: key,
                    data: entry
                };
                await database.save(entity);
            } catch (dbErr) {
                console.warn("⚠️ [API] Datastore save failed, falling back to mock storage:", dbErr.message);
                mockDbStore.logs.unshift(entry);
                if (mockDbStore.logs.length > 2000) mockDbStore.logs.pop();
            }
        } else {
            mockDbStore.logs.unshift(entry);
            // Limit mock storage to prevent overflow during long dev sessions
            if (mockDbStore.logs.length > 2000) mockDbStore.logs.pop();
        }
        res.status(200).json({ saved: true });
    } catch (e) {
        console.error("❌ [API] Log save failed:", e);
        res.status(500).json({ error: "Failed to save log" });
    }
});

apiRouter.get('/admin/stats', adminOnly, async (req, res) => {
    const database = getDb();
    const startTimeStr = req.query.from;
    const endTimeStr = req.query.to;

    let startDate = new Date();
    startDate.setDate(startDate.getDate() - 30); // Default to 30 days if not provided
    if (startTimeStr) startDate = new Date(startTimeStr);

    let endDate = new Date();
    if (endTimeStr) endDate = new Date(endTimeStr);

    // Limit query range to prevent massive data fetch if not using DB cursor
    // Max 100 days for safety if using full fetch
    const MAX_DAYS = 120;
    const diffTime = Math.abs(endDate - startDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
    
    if (diffDays > MAX_DAYS) {
        startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - MAX_DAYS);
    }

    try {
        let rawLogs = [];

        if (database) {
            console.log(`[Admin] Fetching logs from ${startDate.toISOString()} to ${endDate.toISOString()}`);
            
            try {
                const query = database.createQuery('GenerationLog')
                    .order('timestamp', { descending: true })
                    .limit(2000);
                
                const [entities] = await database.runQuery(query);
                
                console.log(`[Admin] Retrieved ${entities.length} documents from Datastore`);
                
                // Client-side filtering by date range
                rawLogs = entities
                    .map(entity => {
                        const id = entity[database.KEY].id || entity[database.KEY].name;
                        return { id, ...entity };
                    })
                    .filter(log => {
                        const ts = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
                        return ts >= startDate && ts <= endDate;
                    });
                    
                console.log(`[Admin] Filtered to ${rawLogs.length} logs in date range`);
                
            } catch (dbError) {
                console.error("❌ [Admin] Datastore query failed:", dbError.message);
                // Fallback: try without orderBy if index is missing
                console.log("[Admin] Attempting fallback query without orderBy...");
                const query = database.createQuery('GenerationLog').limit(2000);
                const [entities] = await database.runQuery(query);
                
                rawLogs = entities
                    .map(entity => {
                        const id = entity[database.KEY].id || entity[database.KEY].name;
                        return { id, ...entity };
                    })
                    .filter(log => {
                        const ts = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
                        return ts >= startDate && ts <= endDate;
                    });

                console.log(`[Admin] Fallback query returned ${rawLogs.length} filtered logs`);
            }
        } else {
            console.log("[Admin] Using mock store (no database connection)");
            // Mock Store Filter
            rawLogs = mockDbStore.logs.filter(l => {
                const ts = new Date(l.timestamp);
                return ts >= startDate && ts <= endDate;
            });
        }
        
        // Normalize Timestamps for Frontend
        const cleanedLogs = rawLogs.map(log => {
            let ts = log.timestamp;
            if (ts && typeof ts.toDate === 'function') ts = ts.toDate().getTime();
            else if (ts instanceof Date) ts = ts.getTime();
            else if (typeof ts === 'string') ts = new Date(ts).getTime();
            return { ...log, timestamp: ts };
        });

        console.log(`[Admin] Returning ${cleanedLogs.length} cleaned logs`);
        res.json({ logs: cleanedLogs });
    } catch (e) {
        console.error("❌ [API] Stats error:", e);
        console.error("Stack trace:", e.stack);
        res.status(500).json({ 
            error: e.message || "Failed to fetch logs",
            details: IS_PRODUCTION ? undefined : e.stack
        });
    }
});

// ============================================================
// VERTEX AI GEMINI PROXY ROUTES
// ============================================================

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
const GCP_LOCATION = process.env.GCP_LOCATION || 'us-central1';

// Regional client — for text/multimodal Gemini models
const getVertexAIClient = () => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: GCP_LOCATION   // e.g. us-central1
    });
};

// Veo client — always uses us-central1 regardless of Cloud Run deployment region
// Veo models are only available in us-central1
const getVeoClient = () => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: 'us-central1'
    });
};

// Global client — required for gemini-3.1-flash-image and Veo models
const getVertexAIGlobalClient = () => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: 'global'
    });
};

// Get ADC access token for authenticated video download
// Works on Cloud Run (metadata server) and local dev (ADC / GOOGLE_APPLICATION_CREDENTIALS)
const getAccessToken = async () => {
    // 1. Try GCE/Cloud Run metadata server first
    try {
        const resp = await fetch(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
            { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) }
        );
        if (resp.ok) {
            const { access_token } = await resp.json();
            return access_token;
        }
    } catch (_) { /* not on GCE, try ADC */ }

    // 2. Fallback: google-auth-library (transitive dep from @google-cloud/datastore)
    try {
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const token = await auth.getAccessToken();
        return token;
    } catch (e) {
        throw new Error('Cannot obtain access token. Ensure ADC is configured: ' + e.message);
    }
};

// GCS Storage client (lazy init)
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || '';
let storageInstance = null;

const getStorage = () => {
    if (!storageInstance) {
        storageInstance = new Storage();
    }
    return storageInstance;
};

/**
 * Copy a Veo-generated video (gs:// URI) into the customer bucket.
 * Downloads via ADC bearer token (same approach as download-video),
 * then streams the upload to GCS using the Storage client.
 * Returns the new gs://bucket/object URI.
 */
const copyVideoToBucket = async (sourceUri) => {
    const token = await getAccessToken();

    // Download from Veo temp storage
    const resp = await fetch(sourceUri, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`Failed to download video from Veo (${resp.status}): ${errText}`);
    }

    // Build destination object name: videos/<timestamp>-<random>.mp4
    const objectName = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;

    const storage = getStorage();
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(objectName);

    // Stream upload
    await new Promise((resolve, reject) => {
        const writeStream = file.createWriteStream({
            contentType: resp.headers.get('content-type') || 'video/mp4',
            resumable: false,
        });
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        resp.body.pipeTo(new WritableStream({
            write(chunk) { writeStream.write(chunk); },
            close() { writeStream.end(); },
            abort(err) { writeStream.destroy(err); }
        })).catch(reject);
    });

    const destUri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
    console.log(`[GCS] Video copied to ${destUri}`);
    return destUri;
};

/**
 * Persist an image (data: URL or raw base64) to the customer bucket.
 * Used for generated avatars and for user-supplied reference images, so that a
 * restored project can put the streamer back on screen instead of forcing a
 * paid regeneration. Best-effort: returns null instead of throwing.
 */
const uploadImageToBucket = async ({ dataUrl, base64, mimeType = 'image/png', label = 'image', prefix = 'avatars' }) => {
    if (!GCS_BUCKET_NAME) {
        console.log('[GCS] No bucket configured — image not persisted.');
        return null;
    }

    let raw = base64;
    let mime = mimeType;
    if (dataUrl) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (!m) {
            console.warn('[GCS] uploadImageToBucket: unrecognised data URL');
            return null;
        }
        mime = m[1];
        raw = m[2];
    }
    if (!raw) return null;

    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
              : mime.includes('webp') ? 'webp'
              : 'png';
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'image';
    const objectName = `${prefix}/${yyyy}/${mm}/${safeLabel}-${now.getTime()}-${randomUUID().slice(0, 8)}.${ext}`;

    try {
        await getStorage().bucket(GCS_BUCKET_NAME).file(objectName).save(Buffer.from(raw, 'base64'), {
            contentType: mime,
            resumable: false,
        });
        const uri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
        console.log(`[GCS] Image saved to ${uri}`);
        return uri;
    } catch (err) {
        console.error('[GCS] Failed to persist image:', err.message);
        return null;
    }
};

/**
 * Persist a finished export (stitched / composited / subtitled video) to the
 * customer bucket under exports/YYYY/MM/. Returns the gs:// URI, or null when
 * no bucket is configured or the upload fails — callers must stay best-effort
 * so a storage hiccup never costs the user their render.
 */
const uploadExportToBucket = async ({ localPath, buffer, ext = 'mp4', contentType = 'video/mp4', label = 'export' }) => {
    if (!GCS_BUCKET_NAME) {
        console.log('[GCS] No bucket configured — export not persisted.');
        return null;
    }
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const objectName = `exports/${yyyy}/${mm}/${label}-${now.getTime()}-${randomUUID().slice(0, 8)}.${ext}`;

    try {
        const bucket = getStorage().bucket(GCS_BUCKET_NAME);
        if (localPath) {
            await bucket.upload(localPath, { destination: objectName, contentType, resumable: false });
        } else if (buffer) {
            await bucket.file(objectName).save(buffer, { contentType, resumable: false });
        } else {
            throw new Error('uploadExportToBucket requires localPath or buffer');
        }
        const uri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
        console.log(`[GCS] Export saved to ${uri}`);
        return uri;
    } catch (err) {
        console.error('[GCS] Failed to persist export:', err.message);
        return null;
    }
};

// GET /api/admin/signed-url?uri=gs://bucket/path/file
// Returns a short-lived signed URL for a GCS object (admin only)
apiRouter.get('/admin/signed-url', adminOnly, async (req, res) => {
    const { uri } = req.query;
    if (!uri || !uri.startsWith('gs://')) {
        return res.status(400).json({ error: 'Invalid or missing gs:// uri' });
    }
    try {
        const withoutScheme = uri.slice(5); // remove "gs://"
        const slashIdx = withoutScheme.indexOf('/');
        if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
        const bucketName = withoutScheme.slice(0, slashIdx);

        // Only ever sign objects in this app's own bucket. Without this check the
        // endpoint can mint read URLs for any object the service account can see.
        if (!GCS_BUCKET_NAME || bucketName !== GCS_BUCKET_NAME) {
            console.warn(`[Admin] signed-url refused for foreign bucket: ${bucketName}`);
            return res.status(403).json({ error: 'URI is outside the configured application bucket.' });
        }
        const objectName = withoutScheme.slice(slashIdx + 1);

        const storage = getStorage();
        const [signedUrl] = await storage.bucket(bucketName).file(objectName).getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000, // 15 minutes
        });
        res.json({ url: signedUrl });
    } catch (err) {
        console.error('[Admin] signed-url error:', err);
        res.status(500).json({ error: 'Failed to generate signed URL: ' + err.message });
    }
});

// Safety settings for image generation
const SAFETY_SETTINGS_BLOCK_NONE = [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
];

// POST /api/gemini/generate-script
// Body: { prompt: string, inlineData?: { data: string, mimeType: string }, videoMimeType?: string, searchGrounding?: boolean, gameUrl?: string }
apiRouter.post('/gemini/generate-script', async (req, res) => {
    const { prompt, inlineData, videoMimeType, searchGrounding, gameUrl } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const ai = getVertexAIGlobalClient();
        const parts = [{ text: prompt }];
        if (inlineData) parts.push({ inlineData });

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: 'You are an expert content creator scriptwriter. You must strictly adhere to the provided pacing and word count rules (ranges per segment duration) to generate the script.',
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            id: { type: Type.INTEGER },
                            startTime: { type: Type.STRING },
                            endTime: { type: Type.STRING },
                            duration: { type: Type.INTEGER },
                            prompt: { type: Type.STRING },
                            dialogue: { type: Type.STRING }
                        },
                        required: ['id', 'startTime', 'endTime', 'duration', 'prompt', 'dialogue']
                    }
                },
                tools: searchGrounding ? [{ googleSearch: {} }] : undefined
            }
        });

        const rawSegments = JSON.parse(response.text || '[]');
        const validatedSegments = rawSegments.map(seg => {
            let d = seg.duration;
            if (d <= 4) d = 4;
            else if (d <= 6) d = 6;
            else d = 8;
            return { ...seg, duration: d };
        });

        const fullText = validatedSegments.map(s =>
            `[${s.startTime}]\n[Duration: ${s.duration}s]\n[Streamer Action: ${s.prompt}]\n[Streamer Dialogue: ${s.dialogue || '(No Dialogue)'}]\n`
        ).join('\n');

        const groundingUrls = [];
        if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
            response.candidates[0].groundingMetadata.groundingChunks.forEach(chunk => {
                if (chunk.web?.uri) groundingUrls.push(chunk.web.uri);
            });
        }

        res.json({ fullText, segments: validatedSegments, groundingUrls, inlineData: inlineData || null });
    } catch (err) {
        console.error('[Gemini] generate-script error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/analyze-script
// Body: { prompt: string }
apiRouter.post('/gemini/analyze-script', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const ai = getVertexAIGlobalClient();
        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            id: { type: Type.INTEGER },
                            startTime: { type: Type.STRING },
                            endTime: { type: Type.STRING },
                            duration: { type: Type.INTEGER },
                            prompt: { type: Type.STRING },
                            dialogue: { type: Type.STRING }
                        },
                        required: ['id', 'startTime', 'endTime', 'duration', 'prompt', 'dialogue']
                    }
                }
            }
        });

        const rawSegments = JSON.parse(response.text || '[]');
        const validatedSegments = rawSegments.map(seg => {
            let d = seg.duration;
            if (d <= 4) d = 4;
            else if (d <= 6) d = 6;
            else d = 8;
            return { ...seg, duration: d };
        });

        res.json(validatedSegments);
    } catch (err) {
        console.error('[Gemini] analyze-script error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/generate-avatar
// Body: { prompt: string, model: string, aspectRatio: string, referenceImageData?: string, referenceImageMime?: string }
apiRouter.post('/gemini/generate-avatar', async (req, res) => {
    const { prompt, model, aspectRatio, referenceImageData, referenceImageMime } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const parts = [{ text: prompt }];
        if (referenceImageData) {
            parts.push({ inlineData: { mimeType: referenceImageMime || 'image/png', data: referenceImageData } });
        }

        const ai = getVertexAIGlobalClient();   // Image model requires global endpoint
        const resolvedModel = model || 'gemini-3.1-flash-image';
        console.log(`[Gemini] Avatar model: ${resolvedModel} (global endpoint)`);
        const response = await ai.models.generateContent({
            model: resolvedModel,
            contents: [{ role: 'user', parts }],
            config: {
                temperature: 0.5,
                responseModalities: ['IMAGE', 'TEXT'],
                imageConfig: {
                    aspectRatio: aspectRatio || '16:9',
                    imageSize: '1K'
                },
                safetySettings: SAFETY_SETTINGS_BLOCK_NONE
            }
        });

        if (response.candidates?.[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData) {
                    const imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                    // Persist it: a generated avatar cannot be reproduced, and
                    // without a durable copy a restored project has no streamer
                    // and the Studio tab stays locked.
                    const gcsUri = await uploadImageToBucket({
                        base64: part.inlineData.data,
                        mimeType: part.inlineData.mimeType,
                        label: 'avatar',
                    });
                    return res.json({ imageData, gcsUri });
                }
            }
        }
        res.status(500).json({ error: 'No image generated in response' });
    } catch (err) {
        console.error('[Gemini] generate-avatar error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/generate-video
// Body: { prompt, imageBase64, aspectRatio, durationSeconds, model, systemInstruction }
// Returns: { operationName: string }
apiRouter.post('/gemini/generate-video', async (req, res) => {
    const { prompt, imageBase64, aspectRatio, durationSeconds, model, systemInstruction } = req.body;
    if (!prompt || !imageBase64) return res.status(400).json({ error: 'prompt and imageBase64 are required' });

    try {
        const ai = getVeoClient();  // Veo only available in us-central1
        const veoModel = model || 'veo-3.1-generate-001';
        const veoRatio = aspectRatio === '9:16' ? '9:16' : '16:9';

        const config = {
            numberOfVideos: 1,
            resolution: '720p',
            aspectRatio: veoRatio,
            durationSeconds: durationSeconds || 6,
            personGeneration: 'allow_adult',
        };
        if (systemInstruction) config.systemInstruction = systemInstruction;

        const operation = await ai.models.generateVideos({
            model: veoModel,
            prompt,
            image: { imageBytes: imageBase64, mimeType: 'image/png' },
            config
        });

        // Return the operation name for client-side polling
        res.json({ operationName: operation.name });
    } catch (err) {
        console.error('[Gemini] generate-video error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/gemini/video-operation?name=xxx
// Returns: { done: bool, videoUri?: string, error?: string }
// NOTE: We use direct REST API here because the SDK's getVideosOperation()
// requires a SDK-internal Operation object, not a plain { name } object.
apiRouter.get('/gemini/video-operation', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
        const token = await getAccessToken();

        // Veo operations must be polled via fetchPredictOperation (not standard GET /operations/{id})
        // name = "projects/.../locations/global/publishers/google/models/veo-xxx/operations/yyy"
        // Extract model path: "projects/.../locations/global/publishers/google/models/veo-xxx"
        const modelPathMatch = name.match(/^(.*\/models\/[^/]+)\/operations\//);
        if (!modelPathMatch) {
            throw new Error(`Cannot parse operation name: ${name}`);
        }
        const modelPath = modelPathMatch[1];
        const fetchOpUrl = `https://us-central1-aiplatform.googleapis.com/v1/${modelPath}:fetchPredictOperation`;
        console.log(`[Gemini] fetchPredictOperation: ${fetchOpUrl}`);

        const opResp = await fetch(fetchOpUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ operationName: name })
        });

        if (!opResp.ok) {
            const errText = await opResp.text().catch(() => opResp.statusText);
            throw new Error(`fetchPredictOperation failed (${opResp.status}): ${errText}`);
        }

        const operation = await opResp.json();
        console.log(`[Gemini] Operation status: done=${operation.done}`);

        if (!operation.done) {
            return res.json({ done: false });
        }
        if (operation.error) {
            return res.json({ done: true, error: operation.error.message || 'Video generation failed' });
        }

        // Log full response to understand URI structure
        console.log('[Gemini] Operation response:', JSON.stringify(operation.response));

        // Check for RAI (Responsible AI) content filter — video blocked by safety policy
        const raiFilteredCount = operation.response?.raiMediaFilteredCount;
        if (raiFilteredCount && raiFilteredCount > 0) {
            const reasons = operation.response?.raiMediaFilteredReasons || [];
            const reason = reasons[0] || 'Content policy violation';
            console.warn(`[Gemini] Video blocked by RAI filter: ${reason}`);
            return res.json({ done: true, error: `Video blocked by Vertex AI safety filter. Try rephrasing the prompt. (${reason})` });
        }

        // Try multiple possible response paths for video URI
        // GenerateVideoResponse uses: response.videos[0].gcsUri
        const videoUri = operation.response?.videos?.[0]?.gcsUri
                      || operation.response?.videos?.[0]?.uri
                      || operation.response?.generatedVideos?.[0]?.video?.uri
                      || operation.response?.generatedVideos?.[0]?.video?.gcsUri
                      || operation.response?.generatedSamples?.[0]?.video?.uri
                      || operation.response?.generatedSamples?.[0]?.video?.gcsUri;

        // Veo may return video bytes directly (bytesBase64Encoded) instead of a GCS URI
        const videoBase64 = operation.response?.videos?.[0]?.bytesBase64Encoded
                         || operation.response?.generatedVideos?.[0]?.video?.bytesBase64Encoded
                         || operation.response?.generatedSamples?.[0]?.video?.bytesBase64Encoded;

        if (!videoUri && !videoBase64) {
            return res.json({ done: true, error: 'No video URI returned. Response: ' + JSON.stringify(operation.response) });
        }

        let finalVideoUri = videoUri || null;

        if (videoBase64) {
            // Video returned as raw bytes — upload to customer bucket if configured,
            // otherwise stream directly to the frontend as a base64 data URL.
            if (GCS_BUCKET_NAME) {
                try {
                    console.log(`[GCS] Uploading inline video bytes to customer bucket: ${GCS_BUCKET_NAME}`);
                    const objectName = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
                    const storage = getStorage();
                    const file = storage.bucket(GCS_BUCKET_NAME).file(objectName);
                    await file.save(Buffer.from(videoBase64, 'base64'), { contentType: 'video/mp4', resumable: false });
                    finalVideoUri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
                    console.log(`[GCS] Inline video uploaded to ${finalVideoUri}`);
                } catch (uploadErr) {
                    console.error('[GCS] Failed to upload inline video bytes:', uploadErr.message);
                    // Fall back: send base64 directly so frontend can still play it
                    return res.json({ done: true, videoBase64: `data:video/mp4;base64,${videoBase64}` });
                }
            } else {
                // No bucket configured — send base64 directly to frontend
                console.log('[Gemini] No bucket configured, returning inline video as base64');
                return res.json({ done: true, videoBase64: `data:video/mp4;base64,${videoBase64}` });
            }
        }

        // If a customer bucket is configured and we have a GCS URI, copy the video there.
        if (GCS_BUCKET_NAME && finalVideoUri && !finalVideoUri.startsWith(`gs://${GCS_BUCKET_NAME}/`)) {
            try {
                console.log(`[GCS] Copying video to customer bucket: ${GCS_BUCKET_NAME}`);
                finalVideoUri = await copyVideoToBucket(finalVideoUri);
            } catch (copyErr) {
                console.error('[GCS] Failed to copy video to customer bucket, falling back to Veo URI:', copyErr.message);
            }
        }

        res.json({ done: true, videoUri: finalVideoUri });
    } catch (err) {
        console.error('[Gemini] video-operation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/gemini/download-video?uri=xxx
// Streams video to client.
// - gs://bucket/object  → read via Storage SDK (customer bucket or Veo bucket)
// - https://...         → fetch with ADC Bearer token (legacy Veo HTTP URIs)
apiRouter.get('/gemini/download-video', async (req, res) => {
    const { uri } = req.query;
    if (!uri) return res.status(400).json({ error: 'uri is required' });

    try {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');

        if (uri.startsWith('gs://')) {
            // Parse gs://bucket/object
            const withoutScheme = uri.slice(5);
            const slashIdx = withoutScheme.indexOf('/');
            if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
            const bucketName = withoutScheme.slice(0, slashIdx);
            const objectName = withoutScheme.slice(slashIdx + 1);

            console.log(`[GCS] Streaming gs://${bucketName}/${objectName}`);
            const storage = getStorage();
            const readStream = storage.bucket(bucketName).file(objectName).createReadStream();
            readStream.on('error', (err) => {
                console.error('[GCS] Read stream error:', err);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            });
            readStream.pipe(res);
        } else {
            // Legacy: HTTP URI from Veo temp storage — fetch with Bearer token
            const token = await getAccessToken();
            const videoResp = await fetch(uri, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!videoResp.ok) {
                const errText = await videoResp.text().catch(() => videoResp.statusText);
                console.error(`[Gemini] Video download failed (${videoResp.status}):`, errText);
                return res.status(videoResp.status).json({ error: `Download failed: ${errText}` });
            }

            const reader = videoResp.body.getReader();
            const pump = async () => {
                const { done, value } = await reader.read();
                if (done) { res.end(); return; }
                res.write(Buffer.from(value));
                await pump();
            };
            await pump();
        }
    } catch (err) {
        console.error('[Gemini] download-video error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/stitch-clips
// Body: multipart/form-data
//   - clips: video files (one or more)
//   - subtitleSrt: SRT text (optional) — if present, burned into the stitched video
// Returns: video/mp4 stream.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 } // 200MB per file
});

const escapeSubtitleFilterPath = (p) => p.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');

// Parse SRT timestamps (HH:MM:SS,mmm) into ASS timestamps (H:MM:SS.cc).
const srtTimeToAss = (t) => {
    const m = t.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) return '0:00:00.00';
    const [, h, mm, ss, ms] = m;
    const cs = Math.round(parseInt(ms.padEnd(3, '0'), 10) / 10);
    return `${parseInt(h, 10)}:${mm}:${ss}.${String(cs).padStart(2, '0')}`;
};

// Convert SRT text to ASS dialogue lines. Uses \N for line breaks.
const srtToAssDialogues = (srt) => {
    const blocks = srt.replace(/\r\n/g, '\n').split(/\n{2,}/);
    const lines = [];
    for (const block of blocks) {
        const parts = block.trim().split('\n');
        if (parts.length < 2) continue;
        const timeLine = parts.find(l => l.includes('-->'));
        if (!timeLine) continue;
        const timeIdx = parts.indexOf(timeLine);
        const [startRaw, endRaw] = timeLine.split('-->').map(s => s.trim());
        const text = parts.slice(timeIdx + 1).join('\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
        if (!text.trim()) continue;
        lines.push(`Dialogue: 0,${srtTimeToAss(startRaw)},${srtTimeToAss(endRaw)},Default,,0,0,0,,${text}`);
    }
    return lines.join('\n');
};

/**
 * Build a complete ASS subtitle file with the video's real dimensions as
 * PlayResX/Y. This bypasses the SRT→ASS conversion inside libass that would
 * otherwise use PlayResY=288 and blow up our pixel-sized FontSize.
 *
 * Rules of thumb for streaming-variety look, all in pixels:
 *   fontSize = ~4.2% of height (clamped 26..64)
 *   outline  = ~10% of fontSize (min 3)
 *   shadow   = ~6% of fontSize  (min 2)
 *   marginV  = ~7% of height    (min 40)
 */
const buildAssFromSrt = (srt, dimensions) => {
    const width = dimensions?.width || 1920;
    const height = dimensions?.height || 1080;
    const fontSize = Math.max(26, Math.min(64, Math.round(height * 0.042)));
    const outline = Math.max(3, Math.round(fontSize * 0.10));
    const shadow = Math.max(2, Math.round(fontSize * 0.06));
    const marginV = Math.max(40, Math.round(height * 0.07));

    const styleLine = `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,` +
        `&H00000000,&H80000000,1,0,0,0,100,100,0.4,0,1,${outline},${shadow},` +
        `2,80,80,${marginV},1`;

    return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${srtToAssDialogues(srt)}
`;
};

/**
 * Probe a video's width/height via ffprobe.
 * Returns { width, height } or null if the probe fails.
 */
const probeVideoDimensions = async (videoPath) => {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0:s=x',
            videoPath,
        ]);
        const [w, h] = stdout.trim().split('x').map(n => parseInt(n, 10));
        if (!w || !h) return null;
        return { width: w, height: h };
    } catch (err) {
        console.warn('[FFprobe] Failed to probe dimensions:', err.message);
        return null;
    }
};

/**
 * Burn an SRT into a video, re-encoding once. Style adapts to the video's height.
 * Returns the output file path.
 *
 * We generate an ASS file directly (rather than SRT + force_style) so we can
 * pin PlayResX/Y to the real video dimensions. Otherwise libass converts SRT
 * with PlayResY=288, and our pixel-scaled FontSize gets multiplied by
 * (video_height / 288) → 3.75x at 1080p, 6.67x at 1920p, wrapping text and
 * blowing letters off-screen.
 */
const burnSrtIntoVideo = async (inputPath, srt, tmpDir, outputName = 'final.mp4') => {
    const dimensions = await probeVideoDimensions(inputPath);
    const assContent = buildAssFromSrt(srt, dimensions);
    const assPath = path.join(tmpDir, `subs-${randomUUID()}.ass`);
    await writeFile(assPath, assContent, 'utf8');

    console.log(`[Subtitles] Burning subtitles — dimensions=${dimensions ? `${dimensions.width}x${dimensions.height}` : 'unknown'}`);

    const outputPath = path.join(tmpDir, outputName);
    const filterArg = `ass='${escapeSubtitleFilterPath(assPath)}'`;
    await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-vf', filterArg,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y',
        outputPath,
    ]);
    return outputPath;
};

/**
 * Stream a finished file to the client and resolve only once the response is
 * fully flushed. The caller can then safely delete the temp directory — piping
 * alone returns immediately and the old code raced the cleanup.
 */
const streamFileToResponse = (filePath, res) => new Promise((resolve) => {
    const stream = createReadStream(filePath);
    stream.on('error', (err) => {
        console.error('[Stream] Read error:', err.message);
        if (!res.headersSent) res.status(500).end();
        else res.end();
        resolve();
    });
    res.on('close', resolve);
    res.on('finish', resolve);
    stream.pipe(res);
});

apiRouter.post('/gemini/stitch-clips', upload.any(), async (req, res) => {
    const files = (req.files || []).filter(f => f.fieldname === 'clips');
    if (files.length === 0) {
        return res.status(400).json({ error: 'No clip files provided' });
    }

    const subtitleSrt = (req.body && typeof req.body.subtitleSrt === 'string')
        ? req.body.subtitleSrt.trim()
        : '';
    const saveToGcs = String(req.body?.saveToGcs || '') === 'true';

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'stitch-'));
    try {
        // 写入各片段到临时目录
        const clipPaths = [];
        for (let i = 0; i < files.length; i++) {
            const p = path.join(tmpDir, `clip_${i}.mp4`);
            await writeFile(p, files[i].buffer);
            clipPaths.push(p);
        }

        // 生成 FFmpeg concat filelist
        const fileListContent = clipPaths.map(p => `file '${p}'`).join('\n');
        const fileListPath = path.join(tmpDir, 'filelist.txt');
        await writeFile(fileListPath, fileListContent);

        // 运行 FFmpeg 无损拼接
        const concatPath = path.join(tmpDir, 'concat.mp4');
        await execFileAsync('ffmpeg', [
            '-f', 'concat',
            '-safe', '0',
            '-i', fileListPath,
            '-c', 'copy',
            '-y',
            concatPath
        ]);

        console.log(`[FFmpeg] Stitched ${files.length} clips → ${concatPath}`);

        // 有字幕：按视频尺寸自适应样式，烧入字幕
        let outPath = concatPath;
        let downloadName = 'stitched.mp4';
        if (subtitleSrt) {
            outPath = await burnSrtIntoVideo(concatPath, subtitleSrt, tmpDir, 'final.mp4');
            downloadName = 'stitched_subtitled.mp4';
            console.log(`[Subtitles] Burned subtitles → ${outPath}`);
        }

        // 成品落 GCS（best-effort，失败不影响下载）。必须在写响应头之前完成。
        if (saveToGcs) {
            const gcsUri = await uploadExportToBucket({
                localPath: outPath,
                ext: 'mp4',
                contentType: 'video/mp4',
                label: subtitleSrt ? 'streamer-subtitled' : 'streamer',
            });
            if (gcsUri) {
                res.setHeader('X-Gcs-Uri', gcsUri);
                res.setHeader('Access-Control-Expose-Headers', 'X-Gcs-Uri');
            }
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        await streamFileToResponse(outPath, res);
    } catch (err) {
        console.error('[FFmpeg] stitch-clips error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Stitch failed: ' + err.message });
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

// POST /api/gemini/burn-subtitles
// Body: multipart/form-data
//   - video: single video file (the final composite)
//   - srt: SRT text (form field)
// Returns: video/mp4 stream with subtitles burned in.
//
// Used after the browser finishes the PiP composite: the client sends the
// composite blob and a client-built SRT, so subtitles land on the final
// full-frame video, not on the tiny streamer PiP.
apiRouter.post('/gemini/burn-subtitles', upload.any(), async (req, res) => {
    const videoFile = (req.files || []).find(f => f.fieldname === 'video');
    if (!videoFile) {
        return res.status(400).json({ error: 'No video file provided' });
    }
    const srt = (req.body && typeof req.body.srt === 'string') ? req.body.srt : '';
    if (!srt.trim()) {
        return res.status(400).json({ error: 'srt field is required and non-empty' });
    }
    const saveToGcs = String(req.body?.saveToGcs || '') === 'true';

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'burn-'));

    try {
        const ext = videoFile.mimetype && videoFile.mimetype.includes('webm') ? 'webm' : 'mp4';
        const inputPath = path.join(tmpDir, `input.${ext}`);
        await writeFile(inputPath, videoFile.buffer);

        const finalPath = await burnSrtIntoVideo(inputPath, srt, tmpDir, 'final.mp4');

        if (saveToGcs) {
            const gcsUri = await uploadExportToBucket({
                localPath: finalPath,
                ext: 'mp4',
                contentType: 'video/mp4',
                label: 'mix-subtitled',
            });
            if (gcsUri) {
                res.setHeader('X-Gcs-Uri', gcsUri);
                res.setHeader('Access-Control-Expose-Headers', 'X-Gcs-Uri');
            }
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="subtitled.mp4"');
        await streamFileToResponse(finalPath, res);
    } catch (err) {
        console.error('[FFmpeg] burn-subtitles error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Burn failed: ' + err.message });
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

// POST /api/gemini/save-export
// Body: multipart/form-data
//   - video: the finished export produced in the browser (Canvas + MediaRecorder
//     composite). The server never sees this render otherwise, so it has to be
//     uploaded explicitly to be persisted.
//   - label: optional short name used in the object path
// Returns: { gcsUri }
apiRouter.post('/gemini/save-export', upload.any(), async (req, res) => {
    const videoFile = (req.files || []).find(f => f.fieldname === 'video');
    if (!videoFile) {
        return res.status(400).json({ error: 'No video file provided' });
    }
    if (!GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'No GCS bucket configured on this deployment.' });
    }

    const rawLabel = typeof req.body?.label === 'string' ? req.body.label : 'export';
    const label = rawLabel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'export';
    const isWebm = Boolean(videoFile.mimetype && videoFile.mimetype.includes('webm'));

    try {
        const gcsUri = await uploadExportToBucket({
            buffer: videoFile.buffer,
            ext: isWebm ? 'webm' : 'mp4',
            contentType: isWebm ? 'video/webm' : 'video/mp4',
            label,
        });
        if (!gcsUri) return res.status(500).json({ error: 'Upload to GCS failed.' });
        res.json({ gcsUri });
    } catch (err) {
        console.error('[GCS] save-export error:', err);
        res.status(500).json({ error: 'Failed to save export: ' + err.message });
    }
});

// GET /api/media/export-url?uri=gs://appbucket/...
// Short-lived signed URL for any authenticated user, but ONLY for objects in
// this deployment's own bucket. Used by <video> preview, which cannot attach an
// Authorization header to its src.
apiRouter.get('/media/export-url', async (req, res) => {
    const { uri } = req.query;
    if (!uri || typeof uri !== 'string' || !uri.startsWith('gs://')) {
        return res.status(400).json({ error: 'Invalid or missing gs:// uri' });
    }
    const withoutScheme = uri.slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
    const bucketName = withoutScheme.slice(0, slashIdx);
    const objectName = withoutScheme.slice(slashIdx + 1);

    if (!GCS_BUCKET_NAME || bucketName !== GCS_BUCKET_NAME) {
        return res.status(403).json({ error: 'URI is outside the configured application bucket.' });
    }

    try {
        const [url] = await getStorage().bucket(bucketName).file(objectName).getSignedUrl({
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000, // 1 hour — long enough to watch
        });
        res.json({ url });
    } catch (err) {
        console.error('[Media] export-url error:', err);
        res.status(500).json({ error: 'Failed to generate URL: ' + err.message });
    }
});

// POST /api/media/save-image
// Body: { dataUrl: "data:image/png;base64,...", label?: string }
// Returns: { gcsUri }
// For images the server did not produce itself — currently the avatar reference
// image the user picks from disk.
apiRouter.post('/media/save-image', async (req, res) => {
    const { dataUrl, label } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return res.status(400).json({ error: 'dataUrl (data: URL) is required' });
    }
    if (!GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'No GCS bucket configured on this deployment.' });
    }
    const gcsUri = await uploadImageToBucket({ dataUrl, label: label || 'reference' });
    if (!gcsUri) return res.status(500).json({ error: 'Upload to GCS failed.' });
    res.json({ gcsUri });
});

// GET /api/media/object?uri=gs://appbucket/...
// Streams an object from this deployment's own bucket, same-origin and
// authenticated.
//
// Why this exists rather than reusing a signed URL: the bucket has no CORS
// configuration, so a cross-origin `fetch()` of a signed URL is blocked and a
// <video crossOrigin="anonymous"> will not load at all. Restored clips have to
// behave exactly like freshly generated ones — playable, fetchable for
// stitching, and safe to draw on a canvas for last-frame extraction — so the
// client pulls them through here and wraps them in blob: URLs.
apiRouter.get('/media/object', async (req, res) => {
    const { uri } = req.query;
    if (!uri || typeof uri !== 'string' || !uri.startsWith('gs://')) {
        return res.status(400).json({ error: 'Invalid or missing gs:// uri' });
    }
    const withoutScheme = uri.slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
    const bucketName = withoutScheme.slice(0, slashIdx);
    const objectName = withoutScheme.slice(slashIdx + 1);

    if (!GCS_BUCKET_NAME || bucketName !== GCS_BUCKET_NAME) {
        return res.status(403).json({ error: 'URI is outside the configured application bucket.' });
    }

    try {
        const file = getStorage().bucket(bucketName).file(objectName);
        const [exists] = await file.exists();
        if (!exists) return res.status(404).json({ error: 'Object not found' });

        const [metadata] = await file.getMetadata();
        res.setHeader('Content-Type', metadata.contentType || 'application/octet-stream');
        if (metadata.size) res.setHeader('Content-Length', metadata.size);
        res.setHeader('Cache-Control', 'private, max-age=300');

        const stream = file.createReadStream();
        stream.on('error', (err) => {
            console.error('[Media] object stream error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: err.message });
            else res.end();
        });
        stream.pipe(res);
    } catch (err) {
        console.error('[Media] object error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to read object: ' + err.message });
    }
});

app.use('/api', apiRouter);

// Catch-all for API 404s
app.use('/api/*', (req, res) => {
    console.warn(`⚠️  [404] API route not found: ${req.originalUrl}`);
    res.status(404).json({ error: "API endpoint not found", path: req.originalUrl });
});


// --- SERVER STARTUP ---

const startServer = async () => {
    if (!IS_PRODUCTION) {
        console.log("⚡ [Server] Configuring Vite middleware (Development)...");
        try {
            const vite = await import('vite');
            const viteServer = await vite.createServer({
                server: { middlewareMode: true },
                appType: 'spa',
            });
            app.use(viteServer.middlewares);
        } catch (e) {
            console.error("❌ [Server] Failed to start Vite middleware:", e);
        }
    } 
    else {
        console.log("🚀 [Server] Configuring Static Serving (Production)...");
        const distPath = path.join(__dirname, 'dist');
        const indexHtmlPath = path.join(distPath, 'index.html');

        if (!fs.existsSync(indexHtmlPath)) {
            console.error(`❌ [Server] CRITICAL: 'dist/index.html' not found.`);
            console.error(`   Ensure 'vite' is in 'dependencies' in package.json so Cloud Run builds it.`);
        }

        // Serve static files
        app.use(express.static(distPath, {
            index: false,
            immutable: true,
            maxAge: '1y',
            fallthrough: true 
        }));

        // SPA Fallback
        app.get('*', (req, res) => {
            if (fs.existsSync(indexHtmlPath)) {
                // No API key injection needed — using Vertex AI via server-side proxy
                res.sendFile(indexHtmlPath);
            } else {
                res.status(500).send("Server Error: Build Output Missing. Check build logs.");
            }
        });
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n==================================================`);
        console.log(`✅ [Server] Listening on port ${PORT}`);
        console.log(`==================================================\n`);
    });
};

startServer().catch(e => {
    console.error("❌ [Server] Fatal startup error:", e);
    process.exit(1);
});
