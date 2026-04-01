import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Datastore } from '@google-cloud/datastore';
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
        if (projectId) {
            console.log(`🔌 [DB] Initializing Datastore for Project ID: ${projectId}`);
            dbInstance = new Datastore({ projectId });
        } else {
            console.log(`🔌 [DB] Initializing Datastore (Auto-Discovery Mode)`);
            dbInstance = new Datastore();
        }
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

// API Router
const apiRouter = express.Router();

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

const getVertexAIClient = () => {
    if (!GCP_PROJECT_ID) {
        throw new Error('GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT environment variable is not set.');
    }
    return new GoogleGenAI({
        vertexai: true,
        project: GCP_PROJECT_ID,
        location: GCP_LOCATION
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
        const ai = getVertexAIClient();
        const parts = [{ text: prompt }];
        if (inlineData) parts.push({ inlineData });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-04-17',
            contents: { parts },
            config: {
                thinkingConfig: { thinkingBudget: 1024 },
                tools: [{ googleSearch: {} }],
                systemInstruction: 'You are an expert content creator scriptwriter. Use the provided context to generate the script.',
            }
        });

        const fullText = response.text || 'No script generated.';
        const groundingUrls = [];
        if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
            response.candidates[0].groundingMetadata.groundingChunks.forEach(chunk => {
                if (chunk.web?.uri) groundingUrls.push(chunk.web.uri);
            });
        }

        res.json({ fullText, groundingUrls, inlineData: inlineData || null });
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
        const ai = getVertexAIClient();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-04-17',
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
        const ai = getVertexAIClient();
        const parts = [{ text: prompt }];
        if (referenceImageData) {
            parts.push({ inlineData: { mimeType: referenceImageMime || 'image/png', data: referenceImageData } });
        }

        const response = await ai.models.generateContent({
            model: model || 'gemini-2.0-flash-exp',
            contents: { parts },
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
        const ai = getVertexAIClient();
        const veoModel = model || 'veo-3.1-generate-preview';
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
apiRouter.get('/gemini/video-operation', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
        const ai = getVertexAIClient();
        const operation = await ai.operations.getVideosOperation({ operation: { name } });

        if (!operation.done) {
            return res.json({ done: false });
        }
        if (operation.error) {
            return res.json({ done: true, error: operation.error.message || 'Video generation failed' });
        }

        const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
        if (!videoUri) {
            return res.json({ done: true, error: 'No video URI returned from API' });
        }
        res.json({ done: true, videoUri });
    } catch (err) {
        console.error('[Gemini] video-operation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/gemini/download-video?uri=xxx
// Fetches video using ADC token and streams to client
apiRouter.get('/gemini/download-video', async (req, res) => {
    const { uri } = req.query;
    if (!uri) return res.status(400).json({ error: 'uri is required' });

    try {
        const token = await getAccessToken();
        const videoResp = await fetch(uri, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!videoResp.ok) {
            const errText = await videoResp.text().catch(() => videoResp.statusText);
            console.error(`[Gemini] Video download failed (${videoResp.status}):`, errText);
            return res.status(videoResp.status).json({ error: `Download failed: ${errText}` });
        }

        const contentType = videoResp.headers.get('content-type') || 'video/mp4';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');

        // Stream the response body to the client
        const reader = videoResp.body.getReader();
        const pump = async () => {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(Buffer.from(value));
            await pump();
        };
        await pump();
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
