const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.AUTO_BOOT = 'false';
process.env.PORT = '3088';
process.env.SHARED_SECRET = process.env.SHARED_SECRET || 'vertex_wa_secure_secret_key_2026';

const TEST_AUTH_DIR = path.join(os.tmpdir(), `vertex_wa_integ_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
if (!fs.existsSync(TEST_AUTH_DIR)) {
    fs.mkdirSync(TEST_AUTH_DIR, { recursive: true });
}
process.env.AUTH_BASE_DIR = TEST_AUTH_DIR;

const { app, server, generateServerToken } = require('./server');
const testToken = generateServerToken();

function makeReq(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3088,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Server-Token': testToken,
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data });
                }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function run() {
    console.log('🧪 Starting Baileys Server Integration Test (Isolated Auth Mode)...\n');

    try {
        // 1. Health
        console.log('1. GET /health');
        const h = await makeReq('GET', '/health');
        assert.strictEqual(h.status, 200);
        console.log('   ✅ Health OK:', h.data);

        // 2. Validate empty sessions in isolated dir
        console.log('2. GET /api/sessions');
        const sess = await makeReq('GET', '/api/sessions');
        assert.strictEqual(sess.status, 200);
        assert.strictEqual(sess.data.sessions.length, 0);
        console.log('   ✅ Clean isolation: 0 sessions.');

        // 3. Send message to disconnected session -> 404
        console.log('3. POST /api/sessions/session_999/messages (unconnected)');
        const send = await makeReq('POST', '/api/sessions/session_999/messages', {
            to: '201012345678',
            text: 'Hello test message'
        });
        assert.strictEqual(send.status, 404);
        console.log('   ✅ Handled non-connected send correctly.');

        // 4. Cleanup session
        console.log('4. DELETE /api/sessions/session_999');
        const del = await makeReq('DELETE', '/api/sessions/session_999');
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.data.success, true);
        console.log('   ✅ Cleaned up session.');

        console.log('\n🎉 ALL INTEGRATION CHECKS PASSED WITHOUT REAL WHATSAPP CONNECTION!');
    } catch (e) {
        console.error('❌ Test failed:', e);
        process.exitCode = 1;
    } finally {
        server.close();
        if (TEST_AUTH_DIR && TEST_AUTH_DIR.includes(os.tmpdir()) && fs.existsSync(TEST_AUTH_DIR)) {
            try {
                fs.rmSync(TEST_AUTH_DIR, { recursive: true, force: true });
            } catch (err) {}
        }
    }
}

run();
