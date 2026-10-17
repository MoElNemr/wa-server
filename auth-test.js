const assert = require('assert');
const http = require('http');

process.env.PORT = '3098';
process.env.API_KEY = 'test_secret_key_vertex_789';

const { app, server } = require('./server');

function makeRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3098,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
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

async function runAuthTests() {
    console.log('🧪 Starting API Key Auth Test Suite...\n');
    try {
        // 1. Health should be accessible without key
        console.log('1. GET /health without key (public whitelist)');
        const health = await makeRequest('GET', '/health');
        assert.strictEqual(health.statusCode, 200);
        console.log('   ✅ Public health allowed.');

        // 2. GET /api/sessions without key -> 401
        console.log('2. GET /api/sessions without key (should 401)');
        const unauth = await makeRequest('GET', '/api/sessions');
        assert.strictEqual(unauth.statusCode, 401);
        assert.strictEqual(unauth.data.status, 'unauthorized');
        console.log('   ✅ Unauthorized request blocked.');

        // 3. GET /api/sessions with invalid key -> 401
        console.log('3. GET /api/sessions with wrong key (should 401)');
        const wrongKey = await makeRequest('GET', '/api/sessions', null, { 'x-api-key': 'wrong_key' });
        assert.strictEqual(wrongKey.statusCode, 401);
        console.log('   ✅ Wrong key blocked.');

        // 4. GET /api/sessions with valid x-api-key -> 200
        console.log('4. GET /api/sessions with valid x-api-key header');
        const validHeader = await makeRequest('GET', '/api/sessions', null, { 'x-api-key': 'test_secret_key_vertex_789' });
        assert.strictEqual(validHeader.statusCode, 200);
        console.log('   ✅ Valid x-api-key allowed.');

        // 5. GET /api/sessions with valid Bearer token -> 200
        console.log('5. GET /api/sessions with valid Bearer Authorization header');
        const validBearer = await makeRequest('GET', '/api/sessions', null, { 'authorization': 'Bearer test_secret_key_vertex_789' });
        assert.strictEqual(validBearer.statusCode, 200);
        console.log('   ✅ Valid Bearer token allowed.');

        console.log('\n🎉 ALL AUTH TESTS PASSED SUCCESSFULLY!');
    } catch (err) {
        console.error('❌ Auth test failure:', err);
        process.exitCode = 1;
    } finally {
        server.close();
    }
}

runAuthTests();
