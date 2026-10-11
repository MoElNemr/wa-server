const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());

const LOGGER = pino({ level: 'silent' });
// الرابط المباشر لـ API الـ Webhook في اللارافيل
const LARAVEL_API = 'http://127.0.0.1:8000/api/whatsapp/webhook';

// القاموس السحري اللي بيشيل الـ Sockets الشغالة في الذاكرة
const activeInstances = {};

async function startInstance(instanceId) {
    // 💡 منع التكرار: لو الجلسة قايمة بالفعل في الذاكرة وشغالة، استخدمها بدلاً من فتح سوكيت جديد
    if (activeInstances[instanceId]) {
        console.log(`ℹ️ [Instance ${instanceId}] Already active in memory. Reusing existing socket.`);
        return activeInstances[instanceId];
    }

    // حفظ بيانات كل رقم في فولدر منفصل بناءً على الـ ID لضمان عدم التداخل
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info/instance_${instanceId}`);

    const sock = makeWASocket({
        auth: state,
        logger: LOGGER,
        printQRInTerminal: false, // بنبعته للارافيل يظهره في الداشبورد
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    activeInstances[instanceId] = sock;

    // 💡 ربط حدث استقبال الرسايل فوراً مع الـ Initialization لضمان عدم سقوط أي رسالة
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            // تجاهل الرسايل المرسلة مني، أو الرسايل الفاضية بدون نص
            if (msg.key.fromMe || !msg.message) continue;

            const from = msg.key.remoteJid;
            
            // 💡 دعم قراءة النصوص والتعليقات المصاحبة للصور والفيديوهات والمستندات
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         msg.message.videoMessage?.caption || 
                         msg.message.documentMessage?.caption;

            if (text) {
                console.log(`📩 [Instance ${instanceId}] Received: "${text}" from [${from}]`);

                // تمرير الرسالة فوراً للارافيل عشان يرميها في الـ Queue ويشغل الـ AI
                axios.post(`${LARAVEL_API}/message`, {
                    instance_id: instanceId,
                    from: from,
                    text: text
                }).catch(err => console.error(`❌ Laravel offline or error syncing message for Instance ${instanceId}`));
            }
        }
    });

    // مراقبة حالة الاتصال (QR، فتح، قفل)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 1. لو في QR Code طلع، ابعته فوراً للارافيل عشان يظهر في داشبورد العميل
        if (qr) {
            console.log(`[Instance ${instanceId}] QR Generated`);
            try {
                await axios.post(`${LARAVEL_API}/qr`, { instance_id: instanceId, qr: qr });
                console.log(`🔹 QR Sent to Laravel successfully for Instance ${instanceId}`);
            } catch (err) {
                console.error(`❌ Failed to send QR to Laravel:`, err.response?.data || err.message);
            }
        }

        // 2. لو الاتصال اتقفل لأي سبب
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[Instance ${instanceId}] Connection closed. Reconnecting: ${shouldReconnect}`);
            
            delete activeInstances[instanceId]; // شيله من الذاكرة مؤقتاً
            
            if (!shouldReconnect) {
                // 💡 مسح مجلد الجلسة عند تسجيل الخروج التام لمنع تكرار محاولة الاتصال التلقائي اللانهائي
                const sessionPath = path.join(__dirname, 'auth_info', `instance_${instanceId}`);
                if (fs.existsSync(sessionPath)) {
                    try {
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                        console.log(`🗑️ [Instance ${instanceId}] Cleaned up logged out session credentials from disk.`);
                    } catch (err) {
                        console.error(`❌ Failed to clean up session files:`, err.message);
                    }
                }
            } else {
                startInstance(instanceId); // إعادة محاولة الاتصال تلقائياً
            }
        } 
        // 3. لو الرقم فتح وبقى جاهز ومسجل دخول
        else if (connection === 'open') {
            console.log(`🚀 [Instance ${instanceId}] Connected and Ready in Memory!`);
            try {
                // جلب رقم الموبايل الحقيقي وتجهيزه من الـ JID
                const rawJid = sock.user.id;
                const formattedNumber = rawJid.split(':')[0] || rawJid.split('@')[0];

                // نبلغ لارافيل إن الحالة متصل ونبعتله الرقم يسيفه
                await axios.post(`${LARAVEL_API}/status`, { 
                    instance_id: instanceId, 
                    status: 'connected',
                    phone_number: formattedNumber
                });
                console.log(`🔹 Connected status and phone [${formattedNumber}] sent to Laravel.`);
            } catch (err) {
                console.error(`❌ Failed to send connected status to Laravel:`, err.message);
            }
        }
    });

    // حفظ ملفات الجلسة وتحديثها تلقائياً عند التغيير
    sock.ev.on('creds.update', saveCreds);
    return sock;
}

// ميزة الـ Auto-Boot: أول ما سيرفر النود يقوم، يصحّي كل الأرقام المسجلة سابقاً تلقائياً
function autoBootInstances() {
    const authDir = path.join(__dirname, 'auth_info');
    if (!fs.existsSync(authDir)) return;

    const folders = fs.readdirSync(authDir);
    folders.forEach(folder => {
        if (folder.startsWith('instance_')) {
            const instanceId = folder.replace('instance_', '');
            console.log(`⚙️ [Auto-Boot] Found saved session for Instance ID: ${instanceId}. Starting...`);
            startInstance(instanceId);
        }
    });
}

// endpoint to check the numbers that are currently active in memory to update the dashboard in laravel
// الـ Endpoint اللي لارافيل بيعرف منها مين قايم في الذاكرة حالياً
app.get('/api/instances/active', (request, response) => {
    // تحويل الـ Keys لأرقام برضه زيادة تأكيد
    const activeInstanceIds = Object.keys(activeInstances).map(Number);
    return response.json({ active_instances: activeInstanceIds });
});

// [Endpoint 1] لارافيل بيكلمها لما العميل يدوس "إضافة رقم جديد" من الداشبورد
app.post('/api/instance/init', async (request, response) => {
    console.log(`📥 [Incoming Request] Received init for Instance ID:`, request.body.instance_id);

    const { instance_id } = request.body;
    if (!instance_id) return response.status(400).json({ error: 'Missing instance_id' });

    try {
        startInstance(instance_id);
        return response.json({ success: true, message: `Instance ${instance_id} initialization started.` });
    } catch (error) {
        console.error('❌ Error inside init endpoint:', error.message);
        return response.status(500).json({ error: error.message });
    }
});

// [Endpoint 2] لارافيل بيكلمها عشان يبعت الرد النهائي للعميل بعد معالجة الـ AI
app.post('/api/instance/send', async (request, response) => {
    const { instance_id, to, text } = request.body;

    if (!instance_id || !to || !text) {
        return response.status(400).json({ error: 'Missing parameters (instance_id, to, or text)' });
    }

    try {
        // جلب الـ socket الخاص بالرقم ده من الذاكرة
        const sock = activeInstances[instance_id];
        
        if (!sock) {
            return response.status(404).json({ error: `Instance ${instance_id} is not active in memory.` });
        }

        // إرسال الرسالة للعميل على الواتساب
        await sock.sendMessage(to, { text: text });
        console.log(`📤 [Instance ${instance_id}] AI Reply Sent to [${to}]`);

        return response.json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error(`❌ Error sending message for Instance ${instance_id}:`, error.message);
        return response.status(500).json({ error: error.message });
    }
});

// [Endpoint 3] لتسجيل خروج الجلسة وفصلها من سيرفر نود والداتابيز
app.post('/api/instance/logout', async (request, response) => {
    const { instance_id } = request.body;
    if (!instance_id) return response.status(400).json({ error: 'Missing instance_id' });

    console.log(`📥 [Incoming Request] Logging out Instance ID: ${instance_id}`);

    try {
        const sock = activeInstances[instance_id];
        if (sock) {
            try {
                await sock.logout();
            } catch (err) {
                console.log(`[Instance ${instance_id}] Baileys logout error (might be already disconnected): ${err.message}`);
                sock.end();
            }
            delete activeInstances[instance_id];
        }

        // مسح مجلد الجلسة
        const sessionPath = path.join(__dirname, 'auth_info', `instance_${instance_id}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🗑️ [Instance ${instance_id}] Session files removed via logout API.`);
        }

        return response.json({ success: true, message: `Instance ${instance_id} logged out successfully.` });
    } catch (error) {
        console.error('❌ Error inside logout endpoint:', error.message);
        return response.status(500).json({ error: error.message });
    }
});

// تشغيل السيرفر على البورت 3000
app.listen(3000, () => {
    console.log('🌐 Multi-Instance WhatsApp Service running on port 3000');
    // تشغيل الـ Auto-Boot فور قيام السيرفر لتشغيل الجلسات المخزنة
    autoBootInstances();
});