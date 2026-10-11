const assert = require('assert');
const http = require('http');

process.env.PORT = '3088';
const { app, server, activeSessions } = require('./server');

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
    console.log('🧪 Starting Baileys Server Integration Test...\n');

    try {
        // 1. Health
        console.log('1. GET /health');
        const h = await makeReq('GET', '/health');
        assert.strictEqual(h.status, 200);
        console.log('   ✅ Health OK:', h.data);

        // 2. Start mock session
        console.log('2. POST /api/sessions/start');
        const s = await makeReq('POST', '/api/sessions/start', {
            session_id: 'session_999',
            business_id: 999,
            webhook_url: 'http://127.0.0.1:8000/webhooks/whatsapp/999'
        });
        assert.strictEqual(s.status, 200);
        assert.ok(['qr_ready', 'connecting', 'connected'].includes(s.data.status));
        console.log('   ✅ Session Start response:', s.data.status, s.data.session_id);

        // 3. Inspect active session
        console.log('3. GET /api/sessions/session_999');
        const info = await makeReq('GET', '/api/sessions/session_999');
        assert.strictEqual(info.status, 200);
        assert.strictEqual(info.data.session_id, 'session_999');
        console.log('   ✅ Active Session Status:', info.data.status);

        // 4. Send message to disconnected session -> 404
        console.log('4. POST /api/sessions/session_999/messages (unconnected)');
        const send = await makeReq('POST', '/api/sessions/session_999/messages', {
            to: '201012345678',
            text: 'Hello test message'
        });
        assert.strictEqual(send.status, 404);
        console.log('   ✅ Handled non-connected send correctly.');

        // 5. Cleanup session
        console.log('5. DELETE /api/sessions/session_999');
        const del = await makeReq('DELETE', '/api/sessions/session_999');
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.data.success, true);
        console.log('   ✅ Cleaned up session.');

        console.log('\n🎉 ALL INTEGRATION CHECKS PASSED!');
    } catch (e) {
        console.error('❌ Test failed:', e);
        process.exitCode = 1;
    } finally {
        server.close();
    }
}

run();
