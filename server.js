import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
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

apiRouter.get('/admin/stats', async (req, res) => {
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

// Regional client — for text/multimodal Gemini models
const getVertexAIClient = () => {
    if (GEMINI_API_KEY) {
        return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }
    if (!GCP_PROJECT_ID) {
        throw new Error('Neither GEMINI_API_KEY nor GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: GCP_LOCATION   // e.g. us-central1
    });
};

// Veo / Omni regional client
const getVeoClient = () => {
    if (GEMINI_API_KEY) {
        return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }
    if (!GCP_PROJECT_ID) {
        throw new Error('Neither GEMINI_API_KEY nor GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: 'us-central1'
    });
};

// Resolves model aliases to their actual Google GenAI / Vertex AI API endpoints
const resolveModelId = (modelName, defaultModel) => {
    const m = (modelName || defaultModel || '').trim();
    // Alias gemini-3.6-flash-lite to the GA endpoint gemini-3.5-flash-lite
    if (m === 'gemini-3.6-flash-lite') return 'gemini-3.5-flash-lite';
    if (m === 'gemini-3.1-flash-image') return 'gemini-3.1-flash-lite-image';
    return m;
};

// Global client — required for gemini-3.1-flash-lite-image and Omni models
const getVertexAIGlobalClient = () => {
    if (GEMINI_API_KEY) {
        return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }
    if (!GCP_PROJECT_ID) {
        throw new Error('Neither GEMINI_API_KEY nor GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is set.');
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

// GET /api/admin/signed-url?uri=gs://bucket/path/file
// Returns a short-lived signed URL for a GCS object (admin only)
apiRouter.get('/admin/signed-url', async (req, res) => {
    const { uri } = req.query;
    if (!uri || !uri.startsWith('gs://')) {
        return res.status(400).json({ error: 'Invalid or missing gs:// uri' });
    }
    try {
        const withoutScheme = uri.slice(5); // remove "gs://"
        const slashIdx = withoutScheme.indexOf('/');
        if (slashIdx === -1) return res.status(400).json({ error: 'Invalid GCS URI' });
        const bucketName = withoutScheme.slice(0, slashIdx);
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

// Safety settings: Disable all filters to prevent false positive blocks in gaming reactions
const SAFETY_SETTINGS_BLOCK_NONE = [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
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

        const modelToUse = resolveModelId(req.body.model, 'gemini-3.6-flash');
        console.log(`[Gemini] Generating script with ${modelToUse} (searchGrounding:`, !!searchGrounding, ')');
        const response = await ai.models.generateContent({
            model: modelToUse,
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: `You are an expert gaming livestreamer director and scriptwriter.
CRITICAL DIALOGUE DURATION & WORD COUNT RULE:
Every segment's 'dialogue' MUST contain enough spoken words to match its 'duration' in seconds at a natural speaking rate.
- 3s segment: 5 to 6 words.
- 4s segment: 7 to 9 words.
- 5s segment: 9 to 11 words.
- 6s segment: 11 to 13 words.
- 7s segment: 13 to 15 words.
- 8s segment: 15 to 17 words.
- 9s segment: 16 to 19 words.
- 10s segment: 18 to 22 words.
NEVER produce 1-word or 2-word dialogue (e.g. "Nice!") for long multi-second clips. Always write full, engaging livestreamer commentary sentences.`,
                responseMimeType: 'application/json',
                safetySettings: SAFETY_SETTINGS_BLOCK_NONE,
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
            let d = Number(seg.duration) || 6;
            if (d < 3) d = 3;
            if (d > 10) d = 10;
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
        const modelToUse = resolveModelId(req.body.model, 'gemini-3.6-flash');
        console.log(`[Gemini] Analyzing script with ${modelToUse}`);
        const response = await ai.models.generateContent({
            model: modelToUse,
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                safetySettings: SAFETY_SETTINGS_BLOCK_NONE,
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
            let d = Number(seg.duration) || 6;
            if (d < 3) d = 3;
            if (d > 10) d = 10;
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
        const resolvedModel = resolveModelId(model, 'gemini-3.1-flash-lite-image');
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
                    return res.json({ imageData: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` });
                }
            }
        }
        res.status(500).json({ error: 'No image generated in response' });
    } catch (err) {
        console.error('[Gemini] generate-avatar error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/gemini/omni-interaction
// Body: { prompt, goldenAvatarBase64, prevPoseBase64, aspectRatio, previousInteractionId, durationSeconds, task }
// Returns: { interactionId: string, videoUri?: string, videoBase64?: string }
apiRouter.post('/gemini/omni-interaction', async (req, res) => {
    const { 
        prompt, 
        goldenAvatarBase64, 
        prevPoseBase64, 
        aspectRatio, 
        durationSeconds 
    } = req.body;

    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const ai = getVertexAIGlobalClient();

        // 1. Determine starting frame image (<Image0>)
        // For Shot 1: golden avatar image
        // For Shot 2+: exact ending pose frame of previous clip (seamless continuity)
        const sourceImage = prevPoseBase64 || goldenAvatarBase64;
        if (!sourceImage) return res.status(400).json({ error: 'Starting image is required' });

        const mimeMatch = sourceImage.match(/^data:(image\/[a-z]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const cleanImageData = sourceImage.replace(/^data:image\/[a-z]+;base64,/, '');

        const inputParts = [
            { type: 'text', text: prompt },
            {
                type: 'image',
                mime_type: mimeType,
                data: cleanImageData
            }
        ];

        const responseFormat = {
            type: 'video',
            aspect_ratio: aspectRatio === '9:16' ? '9:16' : '16:9'
        };

        if (GCS_BUCKET_NAME) {
            responseFormat.delivery = 'uri';
            responseFormat.gcs_uri = `gs://${GCS_BUCKET_NAME}/videos/`;
        } else if (GEMINI_API_KEY) {
            responseFormat.delivery = 'uri';
        } else {
            responseFormat.delivery = 'inline';
        }

        const interactionConfig = {
            model: 'gemini-omni-flash-preview',
            input: inputParts,
            response_format: responseFormat,
            generation_config: {
                video_config: {
                    task: 'image_to_video'
                }
            }
        };

        console.log(`[Omni Flash] Generating clip (task: image_to_video, duration: ${durationSeconds || 6}s, ratio: ${aspectRatio || '16:9'}, isContinuity: ${!!prevPoseBase64})...`);
        
        let interaction = null;
        let url, headers;
        if (GEMINI_API_KEY) {
            url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${GEMINI_API_KEY}`;
            headers = { 'Content-Type': 'application/json' };
        } else {
            const token = await getAccessToken();
            url = `https://aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT_ID}/locations/global/interactions`;
            headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };
        }

        const maxAttempts = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[Omni Flash] Generation attempt ${attempt}/${maxAttempts}...`);
                const resp = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(interactionConfig),
                    signal: AbortSignal.timeout(180000) // 3 minute timeout
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    // Retry on transient 5xx or rate limit (429) errors
                    if (resp.status >= 500 || resp.status === 429) {
                        console.warn(`[Omni Flash] Transient error (${resp.status}): ${errText}. Retrying in ${attempt * 2}s...`);
                        lastError = new Error(`Interactions API transient error (${resp.status}): ${errText}`);
                        if (attempt < maxAttempts) {
                            await new Promise(r => setTimeout(r, attempt * 2000));
                            continue;
                        }
                    }
                    throw new Error(`Interactions API request failed (${resp.status}): ${errText}`);
                }

                interaction = await resp.json();
                break;
            } catch (err) {
                lastError = err;
                const isTransient = err.name === 'TimeoutError' 
                                 || err.code === 'UND_ERR_HEADERS_TIMEOUT' 
                                 || err.message?.includes('fetch failed')
                                 || err.message?.includes('Internal error')
                                 || err.message?.includes('500');

                if (attempt < maxAttempts && isTransient) {
                    console.warn(`[Omni Flash] Attempt ${attempt} failed (${err.message}). Retrying in ${attempt * 2}s...`);
                    await new Promise(r => setTimeout(r, attempt * 2000));
                    continue;
                }
                throw err;
            }
        }

        if (!interaction) {
            throw lastError || new Error('Video generation failed after retries.');
        }

        console.log('[Omni Flash] Interaction completed:', interaction?.id || 'ID_N/A');
        console.log('[Omni Flash] Raw response keys:', Object.keys(interaction || {}));

        let videoUri = interaction?.output_video?.uri 
                    || interaction?.output_video?.gcsUri 
                    || interaction?.output_video?.gcs_uri
                    || interaction?.output?.uri
                    || interaction?.output?.video?.uri
                    || interaction?.output?.video?.gcsUri
                    || interaction?.response?.videos?.[0]?.gcsUri 
                    || interaction?.response?.videos?.[0]?.uri
                    || null;

        let videoBase64 = interaction?.output_video?.data 
                       || interaction?.output_video?.bytesBase64Encoded 
                       || interaction?.output_video?.bytes_base64_encoded
                       || interaction?.output?.data
                       || interaction?.output?.video?.data
                       || interaction?.output?.video?.bytesBase64Encoded
                       || interaction?.response?.videos?.[0]?.bytesBase64Encoded
                       || null;

        // Modern Interactions API schema: steps[].content[]
        if (Array.isArray(interaction?.steps)) {
            for (const step of interaction.steps) {
                if (Array.isArray(step.content)) {
                    for (const item of step.content) {
                        if (item.type === 'video' || item.mime_type?.startsWith('video/')) {
                            if (item.uri && !videoUri) videoUri = item.uri;
                            if (item.data && !videoBase64) videoBase64 = item.data;
                        }
                    }
                }
            }
        }

        // Legacy schema: outputs[]
        if (Array.isArray(interaction?.outputs)) {
            for (const item of interaction.outputs) {
                if (item.type === 'video' || item.mime_type?.startsWith('video/')) {
                    if (item.uri && !videoUri) videoUri = item.uri;
                    if (item.data && !videoBase64) videoBase64 = item.data;
                }
            }
        }

        // If videoUri is returned (e.g. Generative Language files URI), fetch bytes so browser can play without CORS/auth issues
        if (!videoBase64 && videoUri && videoUri.startsWith('http')) {
            try {
                console.log(`[Omni Flash] Fetching video bytes from URI: ${videoUri}`);
                const fetchUrl = GEMINI_API_KEY && !videoUri.includes('key=')
                    ? `${videoUri}${videoUri.includes('?') ? '&' : '?'}key=${GEMINI_API_KEY}`
                    : videoUri;
                let fetchHeaders = {};
                if (!GEMINI_API_KEY) {
                    try {
                        const token = await getAccessToken();
                        if (token) fetchHeaders['Authorization'] = `Bearer ${token}`;
                    } catch (_) {}
                }
                const vResp = await fetch(fetchUrl, { headers: fetchHeaders });
                if (vResp.ok) {
                    const buf = await vResp.arrayBuffer();
                    videoBase64 = Buffer.from(buf).toString('base64');
                    console.log(`[Omni Flash] Downloaded ${buf.byteLength} video bytes.`);
                } else {
                    console.warn(`[Omni Flash] Video fetch returned ${vResp.status}`);
                }
            } catch (fetchErr) {
                console.warn('[Omni Flash] Failed to fetch video bytes:', fetchErr.message);
            }
        }

        if (videoBase64) {
            if (GCS_BUCKET_NAME) {
                try {
                    console.log(`[GCS] Uploading Omni Flash video bytes to customer bucket: ${GCS_BUCKET_NAME}`);
                    const objectName = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
                    const storage = getStorage();
                    const file = storage.bucket(GCS_BUCKET_NAME).file(objectName);
                    await file.save(Buffer.from(videoBase64, 'base64'), { contentType: 'video/mp4', resumable: false });
                    videoUri = `gs://${GCS_BUCKET_NAME}/${objectName}`;
                    console.log(`[GCS] Video saved to ${videoUri}`);
                } catch (uploadErr) {
                    console.warn('[GCS] Save to bucket failed, returning direct base64:', uploadErr.message);
                }
            }
        }

        // If videoUri is on a temp Google bucket, copy to customer bucket
        if (GCS_BUCKET_NAME && videoUri && !videoUri.startsWith(`gs://${GCS_BUCKET_NAME}/`)) {
            try {
                videoUri = await copyVideoToBucket(videoUri);
            } catch (copyErr) {
                console.warn('[GCS] Copy to customer bucket failed, using direct URI:', copyErr.message);
            }
        }

        res.json({
            interactionId: interaction?.id || randomUUID(),
            videoUri: videoUri || null,
            videoBase64: videoBase64 ? `data:video/mp4;base64,${videoBase64}` : null
        });
    } catch (err) {
        console.error('[Omni Flash] omni-interaction error:', err);
        res.status(500).json({ error: err.message || 'Omni Flash generation failed' });
    }
});

// POST /api/gemini/director-copilot
// Body: { instruction: string, currentDialogue: string, currentPrompt: string, gameTitle?: string, streamerTone?: string }
// Returns: { updatedDialogue: string, updatedPrompt: string, summary: string }
apiRouter.post('/gemini/director-copilot', async (req, res) => {
    const { instruction, currentDialogue, currentPrompt, gameTitle, streamerTone } = req.body;
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });

    try {
        const ai = getVertexAIGlobalClient();
        const systemInstruction = `
You are an expert AI Streamer Director Co-Pilot for GamerHeads.
Your job is to take a director's instruction (e.g. "React with more shock", "Make it sarcastic", "Whisper like ASMR") and rewrite the streamer's micro-expression action prompt and dialogue.

CRITICAL RULES:
1. PURE HUMAN ACTION: The 'updatedPrompt' must describe physical micro-expressions and body language only (eyes, jaw, posture, hands). Never describe what is on the game screen.
2. VOCAL FX: Include expressive vocal brackets (e.g. "[Laughing]", "[Sharp gasp]", "[ASMR whisper]", "[Shouting]") at the start of 'updatedDialogue'.
3. AUDIO: Strictly spoken dialogue and vocal reactions. No music, no external SFX.
4. Output raw JSON only with fields: 'updatedDialogue', 'updatedPrompt', 'summary'.
`;

        const userContent = `
GAME CONTEXT: ${gameTitle || 'Gameplay Highlight'}
CURRENT STREAMER ACTION: "${currentPrompt || ''}"
CURRENT STREAMER DIALOGUE: "${currentDialogue || ''}"
DIRECTOR INSTRUCTION: "${instruction}"
`;

        const modelToUse = resolveModelId(req.body.model, 'gemini-3.6-flash');
        console.log(`[Gemini] Director Co-Pilot running with ${modelToUse}`);
        const response = await ai.models.generateContent({
            model: modelToUse,
            contents: userContent,
            config: {
                systemInstruction,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        updatedDialogue: { type: Type.STRING },
                        updatedPrompt: { type: Type.STRING },
                        summary: { type: Type.STRING }
                    },
                    required: ['updatedDialogue', 'updatedPrompt', 'summary']
                }
            }
        });

        const result = JSON.parse(response.text || '{}');
        res.json(result);
    } catch (err) {
        console.error('[Gemini] director-copilot error:', err);
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
            // HTTP URI — fetch with GEMINI_API_KEY or Bearer token
            let fetchUrl = uri;
            let headers = {};
            if (GEMINI_API_KEY) {
                if (!fetchUrl.includes('key=')) {
                    fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + 'key=' + GEMINI_API_KEY;
                }
            } else {
                try {
                    const token = await getAccessToken();
                    if (token) headers['Authorization'] = `Bearer ${token}`;
                } catch (_) {}
            }

            const videoResp = await fetch(fetchUrl, { headers });

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

apiRouter.post('/gemini/stitch-clips', upload.any(), async (req, res) => {
    const files = (req.files || []).filter(f => f.fieldname === 'clips');
    if (files.length === 0) {
        return res.status(400).json({ error: 'No clip files provided' });
    }

    const subtitleSrt = (req.body && typeof req.body.subtitleSrt === 'string')
        ? req.body.subtitleSrt.trim()
        : '';

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

        // 无字幕：直接流式返回
        if (!subtitleSrt) {
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', 'attachment; filename="stitched.mp4"');
            createReadStream(concatPath).pipe(res);
            return;
        }

        // 有字幕：按视频尺寸自适应样式，烧入字幕后再返回
        const finalPath = await burnSrtIntoVideo(concatPath, subtitleSrt, tmpDir, 'final.mp4');
        console.log(`[Subtitles] Burned subtitles → ${finalPath}`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="stitched_subtitled.mp4"');
        createReadStream(finalPath).pipe(res);
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

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'burn-'));

    try {
        const ext = videoFile.mimetype && videoFile.mimetype.includes('webm') ? 'webm' : 'mp4';
        const inputPath = path.join(tmpDir, `input.${ext}`);
        await writeFile(inputPath, videoFile.buffer);

        const finalPath = await burnSrtIntoVideo(inputPath, srt, tmpDir, 'final.mp4');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="subtitled.mp4"');
        createReadStream(finalPath).pipe(res);
    } catch (err) {
        console.error('[FFmpeg] burn-subtitles error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Burn failed: ' + err.message });
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
