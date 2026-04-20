import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Datastore } from '@google-cloud/datastore';
import { Storage } from '@google-cloud/storage';
import compression from 'compression';
import { GoogleGenAI, Type } from '@google/genai';

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
            // Datastore API: Create a key and entity
            const key = database.key('GenerationLog');
            const entity = {
                key: key,
                data: entry
            };
            await database.save(entity);
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

// Global client — required for gemini-3.1-flash-image-preview and Veo models
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

// Safety settings for image generation
const SAFETY_SETTINGS_BLOCK_NONE = [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
];

// POST /api/gemini/generate-script
// Body: { prompt: string, inlineData?: { data: string, mimeType: string }, videoMimeType?: string }
apiRouter.post('/gemini/generate-script', async (req, res) => {
    const { prompt, inlineData, videoMimeType } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const ai = getVertexAIGlobalClient();
        const parts = [{ text: prompt }];
        if (inlineData) parts.push({ inlineData });

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [{ role: 'user', parts }],
            config: {
                thinkingConfig: { thinkingBudget: 1024 },
                tools: [{ googleSearch: {} }],
                systemInstruction: 'You are an expert content creator scriptwriter. Use the provided context to generate the script.',
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
            model: 'gemini-3-flash-preview',
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
        const resolvedModel = model || 'gemini-3.1-flash-image-preview';
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
