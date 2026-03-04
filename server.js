import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Datastore } from '@google-cloud/datastore';
import compression from 'compression';

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
app.use(express.json());

// --- AUTHENTICATION MIDDLEWARE ---
const basicAuthUser = process.env.BASIC_AUTH_USER;
const basicAuthPass = process.env.BASIC_AUTH_PASS;

if (basicAuthUser && basicAuthPass) {
    console.log(`🔒 [Auth] Basic Authentication enabled for user: ${basicAuthUser}`);
    app.use((req, res, next) => {
        // Skip auth for health checks
        if (req.path === '/healthz' || req.path === '/api/health') {
            return next();
        }
        
        const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

        if (login && password && login === basicAuthUser && password === basicAuthPass) {
            return next();
        }

        res.set('WWW-Authenticate', 'Basic realm="GamerHeads Login"');
        res.status(401).send('Authentication required.');
    });
} else {
    console.log(`🔓 [Auth] No Basic Auth configured. Relying on IAP or public access.`);
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
                let html = fs.readFileSync(indexHtmlPath, 'utf-8');
                const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
                html = html.replace(
                    '<!--ENV_INJECTION_POINT-->', 
                    `<script>window.GEMINI_API_KEY = "${apiKey}";</script>`
                );
                res.send(html);
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
