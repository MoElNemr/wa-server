require('dotenv').config();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const crypto = require('crypto');
const cache = require('./cache');

const PORT = process.env.PORT || 3000;
const AUTH_BASE_DIR = path.join(__dirname, 'auth_info');
const LARAVEL_APP_URL = process.env.LARAVEL_APP_URL || 'http://127.0.0.1:8000';
const SHARED_SECRET = process.env.SHARED_SECRET || process.env.SERVER_SECRET || 'vertex_wa_secure_secret_key_2026';
const TOKEN_MAX_AGE_SEC = 300; // 5 minutes
const CORS_ORIGIN = process.env.CORS_ORIGIN || LARAVEL_APP_URL;
const LOGGER = pino({ level: 'silent' });

if (!fs.existsSync(AUTH_BASE_DIR)) {
    fs.mkdirSync(AUTH_BASE_DIR, { recursive: true });
}

/**
 * Invalidate cached session responses on any state change/update.
 */
function invalidateSessionCache(sessionId) {
    cache.del('sessions:all');
    if (sessionId) {
        const cleanId = String(sessionId).startsWith('session_') ? String(sessionId) : `session_${sessionId}`;
        cache.del(`session:${cleanId}`);
        cache.del(`session:${sessionId}`);
    }
}

/**
 * Verify 5-minute rotating HMAC token.
 */
function verifyServerToken(token) {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [timestampStr, providedSignature] = parts;
    const timestamp = parseInt(timestampStr, 10);
    if (!timestamp || isNaN(timestamp)) return false;

    const now = Math.floor(Date.now() / 1000);
    // Token must be within 5-minute window (300s)
    if (Math.abs(now - timestamp) > TOKEN_MAX_AGE_SEC) {
        return false;
    }

    const expectedSignature = crypto
        .createHmac('sha256', SHARED_SECRET)
        .update(`${timestamp}:${SHARED_SECRET}`)
        .digest('hex');

    if (expectedSignature.length !== providedSignature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(providedSignature));
}

/**
 * Generate 5-minute rotating HMAC token.
 */
function generateServerToken() {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
        .createHmac('sha256', SHARED_SECRET)
        .update(`${timestamp}:${SHARED_SECRET}`)
        .digest('hex');
    return `${timestamp}.${signature}`;
}

const app = express();
app.use(express.json());

// CORS - allow only Laravel domain
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Shared-Secret, X-Server-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Authentication middleware (5-minute rotating token enforcement)
app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/api/health') return next();

    const tokenHeader = req.headers['x-server-token'] || 
        (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null);
    const secretHeader = req.headers['x-shared-secret'];

    // 1. Verify 5-minute rotating token
    if (tokenHeader) {
        if (verifyServerToken(tokenHeader)) {
            return next();
        }
        return res.status(401).json({
            error: 'Unauthorized: Server token is invalid or expired (> 5 minutes). Must refresh token every 5 min.',
            code: 'TOKEN_EXPIRED_OR_INVALID'
        });
    }

    // 2. Allow direct pre-shared secret fallback for server bootstrap
    if (SHARED_SECRET && secretHeader === SHARED_SECRET) {
        return next();
    }

    return res.status(401).json({
        error: 'Unauthorized: Missing or invalid authentication token. Valid 5-minute token required.',
        code: 'AUTH_REQUIRED'
    });
});

// Token issuance / refresh endpoint
app.post('/api/auth/token', (req, res) => {
    const secret = req.headers['x-shared-secret'] || req.body?.secret;
    if (SHARED_SECRET && secret !== SHARED_SECRET) {
        return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
    }
    const token = generateServerToken();
    res.json({
        status: 'ok',
        token,
        expires_in: TOKEN_MAX_AGE_SEC
    });
});

// In-memory active session registry
// Key: sessionId (string) -> { sock, sessionId, businessId, webhookUrl, status, phoneNumber, qr, qrImage, lastActiveAt }
const activeSessions = {};

/**
 * Resolve session folder path securely.
 */
function getSessionDir(sessionId) {
    const cleanId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(AUTH_BASE_DIR, cleanId.startsWith('session_') ? cleanId : `session_${cleanId}`);
}

/**
 * Dispatch webhook payload to Laravel backend.
 */
async function dispatchWebhook(sessionEntry, event, data) {
    const targetUrl = sessionEntry.webhookUrl;
    if (!targetUrl) return;

    try {
        await axios.post(targetUrl, { event, data }, {
            timeout: 8000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Server-Token': generateServerToken(),
                'X-Shared-Secret': SHARED_SECRET
            }
        });
        console.log(`[Session ${sessionEntry.sessionId}] Webhook "${event}" delivered to ${targetUrl}`);
    } catch (err) {
        console.warn(`[Session ${sessionEntry.sessionId}] Webhook "${event}" delivery failed: ${err.message}`);
    }
}

/**
 * Start or resume a WhatsApp Baileys session.
 */
async function startSession(sessionId, meta = {}) {
    sessionId = String(sessionId);

    // Return existing socket if active
    if (activeSessions[sessionId] && activeSessions[sessionId].sock) {
        console.log(`[Session ${sessionId}] Existing active session found. Reusing socket.`);
        return activeSessions[sessionId];
    }

    const sessionDir = getSessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const businessId = meta.business_id || meta.businessId || sessionId.replace(/^session_/, '');
    const laravelUrl = process.env.LARAVEL_APP_URL || 'http://127.0.0.1:8000';
    const webhookUrl = meta.webhook_url || meta.webhookUrl || `${laravelUrl}/webhooks/whatsapp/${businessId}`;

    // Persist session metadata for auto-boot on server restart
    const metaFilePath = path.join(sessionDir, 'meta.json');
    try {
        fs.writeFileSync(metaFilePath, JSON.stringify({
            sessionId,
            businessId,
            webhookUrl,
            updatedAt: new Date().toISOString()
        }, null, 2));
    } catch (err) {
        console.error(`[Session ${sessionId}] Failed to save metadata: ${err.message}`);
    }

    const sessionEntry = {
        sessionId,
        businessId,
        webhookUrl,
        sock: null,
        status: 'connecting',
        phoneNumber: null,
        readyForPairing: false,
        lastActiveAt: new Date().toISOString()
    };
    activeSessions[sessionId] = sessionEntry;
    invalidateSessionCache(sessionId);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

    const sock = makeWASocket({
        version,
        auth: state,
        logger: LOGGER,
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        syncFullHistory: false
    });

    sessionEntry.sock = sock;

    // Save credentials on updates
    sock.ev.on('creds.update', saveCreds);

    // Monitor connection events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        invalidateSessionCache(sessionId);

        // 1. Companion handshake / pairing code ready (QR is omitted, using pairing code only)
        if (qr) {
            console.log(`[Session ${sessionId}] Companion pairing handshake ready for phone number pairing.`);
            sessionEntry.readyForPairing = true;
            sessionEntry.status = 'connecting';
            invalidateSessionCache(sessionId);
        }

        // 2. Connection closed
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[Session ${sessionId}] Connection closed (status: ${statusCode}). Reconnect: ${shouldReconnect}`);
            sessionEntry.status = 'disconnected';
            sessionEntry.readyForPairing = false;
            delete activeSessions[sessionId];

            if (!shouldReconnect) {
                console.log(`[Session ${sessionId}] User logged out. Cleaning up credentials.`);
                if (fs.existsSync(sessionDir)) {
                    try {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    } catch (err) {
                        console.error(`[Session ${sessionId}] Failed removing files: ${err.message}`);
                    }
                }

                await dispatchWebhook(sessionEntry, 'connection.update', {
                    session_id: sessionId,
                    business_id: sessionEntry.businessId,
                    status: 'disconnected'
                });
            } else {
                // Exponential reconnect backoff
                setTimeout(() => {
                    startSession(sessionId, { businessId, webhookUrl })
                        .catch(err => console.error(`[Session ${sessionId}] Reconnect failed: ${err.message}`));
                }, 4000);
            }
        }

        // 3. Connection open
        else if (connection === 'open') {
            const rawJid = sock.user?.id || '';
            const formattedNumber = rawJid.split(':')[0] || rawJid.split('@')[0];

            sessionEntry.status = 'connected';
            sessionEntry.phoneNumber = formattedNumber;
            sessionEntry.readyForPairing = false;

            console.log(`[Session ${sessionId}] WhatsApp connected. Number: ${formattedNumber}`);

            await dispatchWebhook(sessionEntry, 'connection.update', {
                session_id: sessionId,
                business_id: sessionEntry.businessId,
                status: 'connected',
                phone_number: formattedNumber
            });
        }
    });

    // Handle messages (both inbound from customers and outbound from phone/web)
    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            if (!msg.message) continue;

            const from = msg.key.remoteJid;
            if (!from || from === 'status@broadcast' || from.endsWith('@broadcast')) continue;

            const isFromMe = Boolean(msg.key.fromMe);

            let m = msg.message;
            if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
            if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
            if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
            if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

            const text = m.conversation ||
                         m.extendedTextMessage?.text ||
                         m.imageMessage?.caption ||
                         m.videoMessage?.caption ||
                         m.documentMessage?.caption ||
                         (m.audioMessage ? '[تسجيل صوتي]' : null) ||
                         (m.stickerMessage ? '[ملصق]' : null) ||
                         (m.locationMessage ? '[موقع جغرافي]' : null) ||
                         (m.contactMessage ? '[جهة اتصال]' : null) ||
                         (m.imageMessage ? '[صورة]' : null) ||
                         (m.videoMessage ? '[فيديو]' : null) ||
                         (m.documentMessage ? '[مستند]' : null) ||
                         null;

            const messageId = msg.key.id || `WA_${Date.now()}`;
            const pushName = msg.pushName || null;

            console.log(`[Session ${sessionId}] ${isFromMe ? 'Outbound' : 'Inbound'} message [${from}]: "${text || '[media]'}"`);

            await dispatchWebhook(sessionEntry, 'messages.upsert', {
                session_id: sessionId,
                business_id: sessionEntry.businessId,
                account_phone_number: sessionEntry.phoneNumber || (sock.user?.id ? sock.user.id.split(':')[0] : null),
                from: from,
                is_from_me: isFromMe,
                push_name: pushName,
                message_id: messageId,
                text: text || '[رسالة وسائط]'
            });
        }
    });

    return sessionEntry;
}

/**
 * Auto-boot previously saved sessions on startup.
 */
function autoBootSessions() {
    if (!fs.existsSync(AUTH_BASE_DIR)) return;

    const entries = fs.readdirSync(AUTH_BASE_DIR);
    entries.forEach(entry => {
        if (entry.startsWith('session_') || entry.startsWith('instance_')) {
            const sessionPath = path.join(AUTH_BASE_DIR, entry);
            const metaPath = path.join(sessionPath, 'meta.json');

            let meta = {};
            if (fs.existsSync(metaPath)) {
                try {
                    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                } catch (e) {
                    // Ignore parse error
                }
            }

            const sessionId = meta.sessionId || (entry.startsWith('session_') ? entry : `session_${entry.replace('instance_', '')}`);
            console.log(`[Auto-Boot] Restoring WhatsApp session: ${sessionId}`);
            startSession(sessionId, meta).catch(err => {
                console.error(`[Auto-Boot] Failed to restore session ${sessionId}: ${err.message}`);
            });
        }
    });
}

// -----------------------------------------------------------------------------
// REST API Endpoints
// -----------------------------------------------------------------------------

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        active_sessions_count: Object.keys(activeSessions).length
    });
});
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        active_sessions_count: Object.keys(activeSessions).length
    });
});

// List all active sessions (cached with instant invalidation on update)
app.get(['/api/sessions', '/api/instances/active'], (req, res) => {
    const cached = cache.get('sessions:all');
    if (cached) {
        return res.json(cached);
    }

    const list = Object.keys(activeSessions).map(id => {
        const s = activeSessions[id];
        return {
            session_id: s.sessionId,
            business_id: s.businessId,
            status: s.status,
            phone_number: s.phoneNumber,
            ready_for_pairing: Boolean(s.readyForPairing)
        };
    });

    const result = {
        active_instances: Object.keys(activeSessions),
        sessions: list
    };

    cache.set('sessions:all', result, 60);
    res.json(result);
});

// Start session
// Standard: POST /api/sessions/start
// Legacy: POST /api/instance/init
app.post(['/api/sessions/start', '/api/instance/init'], async (req, res) => {
    const body = req.body || {};
    const rawId = body.session_id || body.instance_id || (body.business_id ? `session_${body.business_id}` : null);

    if (!rawId) {
        return res.status(400).json({ error: 'Missing session_id or business_id parameter' });
    }

    const sessionId = String(rawId).startsWith('session_') ? String(rawId) : `session_${rawId}`;
    const businessId = body.business_id || sessionId.replace('session_', '');
    const webhookUrl = body.webhook_url || null;

    try {
        const existing = activeSessions[sessionId];

        if (existing && existing.status === 'connected') {
            return res.json({
                status: 'connected',
                session_id: sessionId,
                phone_number: existing.phoneNumber,
                message: 'Session is already connected.'
            });
        }

        const session = existing || await startSession(sessionId, {
            business_id: businessId,
            webhook_url: webhookUrl
        });

        return res.json({
            status: session.status,
            session_id: sessionId,
            ready_for_pairing: Boolean(session.readyForPairing),
            message: 'Session ready. Request pairing code with phone number.'
        });
    } catch (err) {
        console.error(`[API] Error initializing session ${sessionId}:`, err);
        return res.status(500).json({ error: err.message });
    }
});

// Outbound message sending
// Standard: POST /api/sessions/:sessionId/messages
// Legacy: POST /api/instance/send
app.post(['/api/sessions/:sessionId/messages', '/api/instance/send'], async (req, res) => {
    const paramId = req.params?.sessionId;
    const bodyId = req.body?.instance_id || req.body?.session_id;
    const rawId = paramId || bodyId;

    if (!rawId) {
        return res.status(400).json({ error: 'Missing session_id or instance_id parameter' });
    }

    const sessionId = String(rawId).startsWith('session_') ? String(rawId) : `session_${rawId}`;
    const { to, text } = req.body || {};

    if (!to || !text) {
        return res.status(400).json({ error: 'Missing required parameters: to, text' });
    }

    const session = activeSessions[sessionId];
    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(404).json({
            status: 'failed',
            error: `Session ${sessionId} is not connected or active in memory.`
        });
    }

    try {
        // Format recipient JID: support full JIDs (@lid, @s.whatsapp.net, @g.us, @newsletter), and standard phone numbers
        let targetJid;
        const toStr = String(to).trim();
        if (toStr.includes('@')) {
            targetJid = toStr;
        } else {
            let cleanRecipient = toStr.replace(/[^0-9]/g, '');
            // Normalize Egyptian local numbers (01xxxxxxxxx -> 201xxxxxxxxx)
            if (cleanRecipient.startsWith('01') && cleanRecipient.length === 11) {
                cleanRecipient = '2' + cleanRecipient;
            } else if (cleanRecipient.startsWith('05') && cleanRecipient.length === 10) {
                cleanRecipient = '966' + cleanRecipient.substring(1);
            }
            targetJid = `${cleanRecipient}@s.whatsapp.net`;
        }

        const sent = await session.sock.sendMessage(targetJid, { text });
        const messageId = sent?.key?.id || `WA_${Date.now()}`;

        console.log(`[Session ${sessionId}] Outbound message sent to [${targetJid}]: ID ${messageId}`);

        return res.json({
            status: 'success',
            message_id: messageId,
            to: targetJid,
            timestamp: Date.now()
        });
    } catch (err) {
        console.error(`[Session ${sessionId}] Error sending message:`, err);
        return res.status(500).json({ status: 'failed', error: err.message });
    }
});

// Single session details / status (cached with instant invalidation on update)
app.get(['/api/sessions/:sessionId', '/api/instance/:sessionId'], (req, res) => {
    const rawId = req.params.sessionId;
    const sessionId = String(rawId).startsWith('session_') ? String(rawId) : `session_${rawId}`;
    const cacheKey = `session:${sessionId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }

    const session = activeSessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: `Session ${sessionId} not found.` });
    }

    const result = {
        session_id: session.sessionId,
        business_id: session.businessId,
        status: session.status,
        phone_number: session.phoneNumber,
        ready_for_pairing: Boolean(session.readyForPairing)
    };

    cache.set(cacheKey, result, 60);
    res.json(result);
});

// Request 8-digit Pairing Code for phone number linking
app.post(['/api/sessions/pairing-code', '/api/sessions/:sessionId/pairing-code'], async (req, res) => {
    const rawId = req.params?.sessionId || req.body?.session_id || (req.body?.business_id ? `session_${req.body.business_id}` : null);
    const phoneNumber = String(req.body?.phone_number || '').replace(/[^0-9]/g, '');

    if (!rawId || !phoneNumber) {
        return res.status(400).json({ error: 'Missing session_id or phone_number parameter' });
    }

    const sessionId = String(rawId).startsWith('session_') ? String(rawId) : `session_${rawId}`;
    try {
        let session = activeSessions[sessionId];
        if (!session || !session.sock) {
            session = await startSession(sessionId, {
                business_id: req.body?.business_id || sessionId.replace('session_', ''),
                webhook_url: req.body?.webhook_url
            });
        }

        // Wait until companion registration handshake is ready (signaled by readyForPairing or connected)
        let attempts = 0;
        while (attempts < 35 && !session.readyForPairing && session.status !== 'connected') {
            await new Promise(r => setTimeout(r, 200));
            attempts++;
        }

        if (session.status === 'connected') {
            return res.json({
                status: 'connected',
                session_id: sessionId,
                phone_number: session.phoneNumber,
                message: 'الحساب متصل بالفعل!'
            });
        }

        const code = await session.sock.requestPairingCode(phoneNumber);
        const formattedCode = code ? (code.match(/.{1,4}/g)?.join(' - ') || code) : code;
        console.log(`[Session ${sessionId}] Pairing code generated for ${phoneNumber}: ${formattedCode}`);

        return res.json({
            status: 'pairing_code_ready',
            session_id: sessionId,
            pairing_code: formattedCode,
            raw_code: code
        });
    } catch (err) {
        console.error(`[Session ${sessionId}] Pairing code error:`, err);
        return res.status(500).json({ error: err.message });
    }
});

// Logout / disconnect session
// Standard: DELETE /api/sessions/:sessionId
// Aliases: POST /api/sessions/:sessionId/logout, POST /api/instance/logout
const handleLogout = async (req, res) => {
    const rawId = req.params?.sessionId || req.body?.session_id || req.body?.instance_id;

    if (!rawId) {
        return res.status(400).json({ error: 'Missing session_id or instance_id parameter' });
    }

    const sessionId = String(rawId).startsWith('session_') ? String(rawId) : `session_${rawId}`;
    console.log(`[API] Terminating session: ${sessionId}`);

    const session = activeSessions[sessionId];
    if (session && session.sock) {
        try {
            await session.sock.logout();
        } catch (err) {
            console.warn(`[Session ${sessionId}] Baileys logout error: ${err.message}`);
            try {
                session.sock.end();
            } catch (e) {}
        }
    }

    delete activeSessions[sessionId];
    invalidateSessionCache(sessionId);

    const sessionDir = getSessionDir(sessionId);
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (err) {
            console.error(`[Session ${sessionId}] Error removing session folder:`, err.message);
        }
    }

    return res.json({
        success: true,
        message: `Session ${sessionId} logged out and cleaned up successfully.`
    });
};

app.delete('/api/sessions/:sessionId', handleLogout);
app.post('/api/sessions/:sessionId/logout', handleLogout);
app.post('/api/instance/logout', handleLogout);

// Cache flush endpoint
app.post('/api/cache/clear', (req, res) => {
    cache.flush();
    res.json({ status: 'ok', message: 'Cache flushed successfully' });
});

// Start HTTP Server
const server = app.listen(PORT, () => {
    console.log(`🚀 VERTEX WhatsApp Baileys Service running on port ${PORT}`);
    autoBootSessions();
});

module.exports = { app, server, activeSessions, startSession, verifyServerToken, generateServerToken, cache, invalidateSessionCache };