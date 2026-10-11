const assert = require('assert');
const http = require('http');

// Set custom test port so we don't conflict
process.env.PORT = '3099';

const { app, server, activeSessions } = require('./server');

function makeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: '127.0.0.1',
            port: 3099,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = data;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {}
                resolve({ statusCode: res.statusCode, data: parsed });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTests() {
    console.log('🧪 Starting WhatsApp Service Test Suite...\n');

    try {
        // Test 1: Health check
        console.log('1. Testing GET /health');
        const health = await makeRequest('GET', '/health');
        assert.strictEqual(health.statusCode, 200);
        assert.strictEqual(health.data.status, 'ok');
        console.log('   ✅ Health check passed.');

        // Test 2: List sessions
        console.log('2. Testing GET /api/sessions');
        const sessions = await makeRequest('GET', '/api/sessions');
        assert.strictEqual(sessions.statusCode, 200);
        assert.ok(Array.isArray(sessions.data.sessions));
        assert.ok(Array.isArray(sessions.data.active_instances));
        console.log('   ✅ Sessions list passed.');

        // Test 3: Legacy GET /api/instances/active
        console.log('3. Testing GET /api/instances/active');
        const legacyActive = await makeRequest('GET', '/api/instances/active');
        assert.strictEqual(legacyActive.statusCode, 200);
        assert.ok(Array.isArray(legacyActive.data.active_instances));
        console.log('   ✅ Legacy active instances passed.');

        // Test 4: Validation on /api/sessions/start
        console.log('4. Testing validation on POST /api/sessions/start');
        const invalidStart = await makeRequest('POST', '/api/sessions/start', {});
        assert.strictEqual(invalidStart.statusCode, 400);
        console.log('   ✅ Validation on start passed.');

        // Test 5: Validation on message send
        console.log('5. Testing validation on POST /api/sessions/session_test/messages');
        const invalidSend = await makeRequest('POST', '/api/sessions/session_test/messages', {});
        assert.strictEqual(invalidSend.statusCode, 400);
        console.log('   ✅ Missing params check passed.');

        // Test 6: Inactive session send
        console.log('6. Testing send to inactive session (expect 404)');
        const inactiveSend = await makeRequest('POST', '/api/sessions/session_non_existent/messages', {
            to: '201012345678',
            text: 'Hello test'
        });
        assert.strictEqual(inactiveSend.statusCode, 404);
        console.log('   ✅ Inactive session check passed.');

        // Test 7: Logout / cleanup endpoint
        console.log('7. Testing DELETE /api/sessions/session_temp_test');
        const logout = await makeRequest('DELETE', '/api/sessions/session_temp_test');
        assert.strictEqual(logout.statusCode, 200);
        assert.strictEqual(logout.data.success, true);
        console.log('   ✅ Logout endpoint passed.');

        console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
    } catch (err) {
        console.error('\n❌ Test failure:', err);
        process.exitCode = 1;
    } finally {
        server.close();
    }
}

runTests();
