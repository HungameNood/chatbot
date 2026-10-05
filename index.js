const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Cho phép trang web (GitHub Pages) gọi tới server này
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Key của service account: dán nguyên nội dung file .json vào biến môi trường GOOGLE_CREDENTIALS_JSON trên Render
let creds = {};
try { creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || '{}'); }
catch (e) { console.error('GOOGLE_CREDENTIALS_JSON không phải JSON hợp lệ'); }
if (!creds.client_email) console.error('Thiếu biến môi trường GOOGLE_CREDENTIALS_JSON.');

// Lấy access token từ service account (tự ký JWT, không cần thư viện ngoài)
let cached = { token: null, exp: 0 };
async function getToken() {
    if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
        iss: creds.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    });
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key, 'base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: unsigned + '.' + sig,
        }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || 'Không lấy được token');
    cached = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
    return cached.token;
}

app.get('/', (req, res) => res.send('Dialogflow proxy is running.'));

app.post('/chat', async (req, res) => {
    try {
        const text = String(req.body.text || '').slice(0, 500);
        const sid = String(req.body.sessionId || 'web').replace(/[^\w-]/g, '').slice(0, 36) || 'web';
        const token = await getToken();
        const url = `https://dialogflow.googleapis.com/v2/projects/${creds.project_id}/agent/sessions/${sid}:detectIntent`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ queryInput: { text: { text, languageCode: 'vi' } } }),
        });
        const data = await r.json();
        if (!r.ok) {
            console.error('Dialogflow lỗi:', JSON.stringify(data).slice(0, 400));
            return res.status(502).json({ error: (data.error && data.error.message) || 'Dialogflow error' });
        }
        const qr = data.queryResult || {};
        const texts = [], chips = [];
        for (const m of qr.fulfillmentMessages || []) {
            if (m.text && m.text.text) texts.push(...m.text.text);
            const rc = m.payload && m.payload.richContent;
            if (rc) for (const group of rc) for (const el of group) {
                if (el.type === 'chips') chips.push(...el.options.map((o) => o.text));
            }
        }
        res.json({ text: texts.join('\n') || qr.fulfillmentText || '', chips });
    } catch (e) {
        console.error('Lỗi /chat:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(// Endpoint nhận Webhook callback từ Dialogflow Fulfillment
app.post('/webhook', (req, res) => {
    const intentName = req.body.queryResult?.intent?.displayName;

    // Ví dụ: Xử lý phản hồi tùy chỉnh cho từng Intent
    let replyText = "Đã nhận phản hồi từ Webhook Backend!";

    if (intentName === 'LS_BachDang938') {
        replyText = "Trận Bạch Đằng năm 938 do Ngô Quyền lãnh đạo đã đánh tan quân Nam Hán!";
    }

    // Trả về định dạng JSON chuẩn của Dialogflow Fulfillment
    return res.json({
        fulfillmentText: replyText
    });
});
