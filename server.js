const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode');

const PORT = process.env.PORT || 3000;
const AUTH_BASE_DIR = path.join(__dirname, 'auth_info');
const LOGGER = pino({ level: 'silent' });

if (!fs.existsSync(AUTH_BASE_DIR)) {
    fs.mkdirSync(AUTH_BASE_DIR, { recursive: true });
}

const app = express();
app.use(express.json());

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
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
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
    const webhookUrl = meta.webhook_url || meta.webhookUrl || `http://127.0.0.1:8000/webhooks/whatsapp/${businessId}`;

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
        qr: null,
        qrImage: null,
        lastActiveAt: new Date().toISOString()
    };
    activeSessions[sessionId] = sessionEntry;

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

        // 1. QR code received
        if (qr) {
            console.log(`[Session ${sessionId}] QR code generated.`);
            sessionEntry.qr = qr;
            sessionEntry.status = 'connecting';
            try {
                sessionEntry.qrImage = await qrcode.toDataURL(qr, { margin: 2, scale: 6 });
            } catch (qrErr) {
                console.error(`[Session ${sessionId}] Failed to generate QR image: ${qrErr.message}`);
                sessionEntry.qrImage = null;
            }

            await dispatchWebhook(sessionEntry, 'connection.update', {
                session_id: sessionId,
                business_id: sessionEntry.businessId,
                status: 'qr',
                qr_code: sessionEntry.qrImage || qr,
                qr_raw: qr,
                qr_image: sessionEntry.qrImage
            });
        }

        // 2. Connection closed
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[Session ${sessionId}] Connection closed (status: ${statusCode}). Reconnect: ${shouldReconnect}`);
            sessionEntry.status = 'disconnected';
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
            sessionEntry.qr = null;
            sessionEntry.qrImage = null;

            console.log(`[Session ${sessionId}] WhatsApp connected. Number: ${formattedNumber}`);

            await dispatchWebhook(sessionEntry, 'connection.update', {
                session_id: sessionId,
                business_id: sessionEntry.businessId,
                status: 'connected',
                phone_number: formattedNumber
            });
        }
    });

    // Handle inbound messages
    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            if (!from || from === 'status@broadcast') continue;

            const text = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text ||
                         msg.message.imageMessage?.caption ||
                         msg.message.videoMessage?.caption ||
                         msg.message.documentMessage?.caption ||
                         null;

            const messageId = msg.key.id || `WA_${Date.now()}`;
            const pushName = msg.pushName || null;

            console.log(`[Session ${sessionId}] Inbound message from [${from}]: "${text || '[media]'}"`);

            await dispatchWebhook(sessionEntry, 'messages.upsert', {
                session_id: sessionId,
                business_id: sessionEntry.businessId,
                from: from,
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

// List all active sessions
app.get(['/api/sessions', '/api/instances/active'], (req, res) => {
    const list = Object.keys(activeSessions).map(id => {
        const s = activeSessions[id];
        return {
            session_id: s.sessionId,
            business_id: s.businessId,
            status: s.status,
            phone_number: s.phoneNumber,
            has_qr: Boolean(s.qr)
        };
    });

    res.json({
        active_instances: Object.keys(activeSessions),
        sessions: list
    });
});

// Start session / request QR code
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

        if (existing && existing.qr) {
            return res.json({
                status: 'qr_ready',
                session_id: sessionId,
                qr_code: existing.qrImage || existing.qr,
                qr_image: existing.qrImage,
                qr_raw: existing.qr
            });
        }

        // Start session
        const session = await startSession(sessionId, {
            business_id: businessId,
            webhook_url: webhookUrl
        });

        // Wait up to 6 seconds for immediate QR generation before returning response
        let attempts = 0;
        while (attempts < 30 && !session.qrImage && !session.qr && session.status !== 'connected') {
            await new Promise(resolve => setTimeout(resolve, 200));
            attempts++;
        }

        if (session.status === 'connected') {
            return res.json({
                status: 'connected',
                session_id: sessionId,
                phone_number: session.phoneNumber
            });
        }

        if (session.qrImage || session.qr) {
            if (!session.qrImage && session.qr) {
                try {
                    session.qrImage = await qrcode.toDataURL(session.qr, { margin: 2, scale: 6 });
                } catch (e) {}
            }
            return res.json({
                status: 'qr_ready',
                session_id: sessionId,
                qr_code: session.qrImage || session.qr,
                qr_image: session.qrImage,
                qr_raw: session.qr
            });
        }

        return res.json({
            status: 'connecting',
            session_id: sessionId,
            message: 'Session initialization in progress, QR will be pushed via webhook.'
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
        // Format recipient JID
        const cleanRecipient = String(to).replace(/[^0-9]/g, '');
        const targetJid = to.includes('@') ? to : `${cleanRecipient}@s.whatsapp.net`;

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

// Single session details / status
app.get(['/api/sessions/:sessionId', '/api/instance/:sessionId'], (req, res) => {
    const rawId = req.params.sessionId;
    const sessionId = String(rawId).startsWith('session_') ? String(rawId) : `session_${rawId}`;
    const session = activeSessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: `Session ${sessionId} not found.` });
    }

    res.json({
        session_id: session.sessionId,
        business_id: session.businessId,
        status: session.status,
        phone_number: session.phoneNumber,
        qr_code: session.qrImage || session.qr,
        qr_image: session.qrImage
    });
});

// Dedicated QR code endpoint
app.get(['/api/sessions/:sessionId/qr', '/api/instance/:sessionId/qr'], async (req, res) => {
    const rawId = req.params.sessionId;
    const sessionId = String(rawId).startsWith('session_') ? String(rawId) : `session_${rawId}`;
    const session = activeSessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: `Session ${sessionId} not found.` });
    }

    if (session.qr && !session.qrImage) {
        try {
            session.qrImage = await qrcode.toDataURL(session.qr, { margin: 2, scale: 6 });
        } catch (e) {}
    }

    res.json({
        session_id: session.sessionId,
        business_id: session.businessId,
        status: session.status,
        qr_code: session.qrImage || session.qr,
        qr_image: session.qrImage,
        qr_raw: session.qr
    });
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

// Start HTTP Server
const server = app.listen(PORT, () => {
    console.log(`🚀 VERTEX WhatsApp Baileys Service running on port ${PORT}`);
    autoBootSessions();
});

module.exports = { app, server, activeSessions, startSession };