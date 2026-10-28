require('dotenv').config();
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 10000;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (e) {
    console.error('[Firebase Admin] Başlatılamadı:', e.message);
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// MODEL İSİMLERİ (TAM İSTEDİĞİN GİBİ)
// ----------------------------------------------------
const TEXT_MODEL = 'gemini-3.5-flash-lite';
const IMAGE_MODEL = 'gemini-3.1-flash-lite-image';

const SYSTEM_PROMPT = `KRİTİK KİMLİK KURALI:
Senin adın 'ChatixAI' dir. Sen OpenAI, ChatGPT, Claude, Gemini, Google veya genel bir 'yapay zeka dil modeli' DEĞİLSİN.
Kullanıcı "sen kimsin" derse şu cevabı ver: "Ben ChatixAI, ücretsiz ve hızlı yapay zeka asistanınızım."
Türkçe konuş. Kısa, net, samimi ve yardımcı ol. Kod yazarken kod bloğu kullan.

WEB OTOMASYONU KURALI:
Eğer kullanıcı bir siteye gidip kayıt olmanı, form doldurmanı, tıklamanı veya mesaj atmanı isterse:
1. Doğrudan "yapıyorum" deme.
2. İşlem ağırlığına göre token belirle:
   - BASİT (5 token): site okuma, bilgi çekme
   - ORTA (20 token): butona tıklama, arama, form doldurma
   - ZOR (50 token): kayıt olma, giriş yapma, mesaj atma, CAPTCHA
3. Şu formatta yanıt ver:
[TOKEN_REQUEST:X]
🪙 Bu işlem yaklaşık X token tüketecek. Kabul ediyor musunuz?`;

function buildContents(messages) {
  const textMessages = (messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.type !== 'image' && m.content)
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', text: String(m.content) }));

  const contents = [];
  for (const m of textMessages) {
    const last = contents[contents.length - 1];
    if (last && last.role === m.role) {
      last.parts[0].text += '\n\n' + m.text;
    } else {
      contents.push({ role: m.role, parts: [{ text: m.text }] });
    }
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

// ----------------------------------------------------
// 1) SOHBET - YAZI MODELİ
// ----------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const { messages, userTokens } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY yapılandırılmamış' });
  }

  const contents = buildContents(messages);
  if (contents.length === 0) {
    return res.status(400).json({ error: 'Geçerli bir mesaj yok' });
  }

  try {
    console.log('[Chat] Model:', TEXT_MODEL);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT + '\nKullanıcının bakiyesi: ' + (userTokens || 0) + ' token.' }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('[Chat] Hata:', response.status, JSON.stringify(data).substring(0, 400));
      return res.status(response.status).json({ error: data?.error?.message || 'Gemini API hatası' });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = parts.map(p => p.text || '').join('').trim();

    if (!content) {
      return res.json({ success: true, content: 'Bu konu hakkında yanıt veremiyorum.' });
    }

    res.json({ success: true, content });
  } catch (error) {
    console.error('[Chat] Beklenmeyen hata:', error.message);
    res.status(500).json({ error: 'Bağlantı kurulamadı: ' + error.message });
  }
});

// ----------------------------------------------------
// 2) GÖRSEL ÜRETME - GÖRSEL MODELİ
// ----------------------------------------------------
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY yapılandırılmamış' });
  }
  if (!prompt) return res.status(400).json({ error: 'Görsel açıklaması gerekli' });

  try {
    console.log('[Image] Model:', IMAGE_MODEL);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('[Image] Hata:', response.status, JSON.stringify(data).substring(0, 400));
      return res.status(response.status).json({ error: data?.error?.message || 'Görsel API hatası' });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.data);

    if (imagePart) {
      const mime = imagePart.inlineData.mimeType || 'image/png';
      const imageUrl = `data:${mime};base64,${imagePart.inlineData.data}`;
      return res.json({ success: true, imageUrl });
    }

    res.status(404).json({ error: 'Model görsel yerine metin döndürdü.' });
  } catch (error) {
    console.error('[Image] İstisna:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// 3) WEB ARAMA - JINA READER
// ----------------------------------------------------
app.post('/api/web-search', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error(`Web içeriği alınamadı: ${response.status}`);
    const content = await response.text();
    res.json({ content: content.length > 8000 ? content.slice(0, 8000) + '... [kısaltıldı]' : content });
  } catch (error) {
    res.status(500).json({ error: 'Web içeriği okunamadı: ' + error.message });
  }
});

// ----------------------------------------------------
// 4) MANUS - GÖREV BAŞLAT
// ----------------------------------------------------
app.post('/api/execute-agent', async (req, res) => {
  const { prompt, url } = req.body;
  if (!process.env.MANUS_API_KEY) return res.status(500).json({ error: 'MANUS_API_KEY yapılandırılmamış' });
  try {
    const fullPrompt = url ? `${url} adresine git ve şunu yap: ${prompt}` : prompt;
    const response = await fetch('https://api.manus.ai/v1/tasks', {
      method: 'POST',
      headers: { 'API_KEY': process.env.MANUS_API_KEY, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ prompt: fullPrompt })
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const taskId = data.task_id || data.id;
    if (!taskId) throw new Error('task_id alınamadı');
    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// 5) MANUS - DURUM SORGULA
// ----------------------------------------------------
app.get('/api/check-task-status', async (req, res) => {
  const { taskId, userId, cost } = req.query;
  if (!taskId || !process.env.MANUS_API_KEY) return res.status(400).json({ status: 'error', error: 'Geçersiz istek' });
  try {
    const response = await fetch(`https://api.manus.ai/v1/tasks/${taskId}`, {
      headers: { 'API_KEY': process.env.MANUS_API_KEY },
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    const status = data.status;

    if (status === 'completed') {
      const result = data.result || data.output || 'Görev tamamlandı.';
      if (admin.apps.length > 0 && userId && cost) {
        try {
          await admin.firestore().collection('users').doc(userId)
            .update({ tokens: admin.firestore.FieldValue.increment(-parseInt(cost)) });
        } catch (e) { console.error('[Token] Güncelleme hatası:', e.message); }
      }
      return res.json({ status: 'completed', result, tokensDeducted: parseInt(cost) || 0 });
    }
    if (status === 'failed' || status === 'cancelled') {
      return res.json({ status: 'failed', error: data.error || 'Görev başarısız oldu.' });
    }
    res.json({ status: 'running', message: 'İşlem devam ediyor...' });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ----------------------------------------------------
// 6) TEST ENDPOINT
// ----------------------------------------------------
app.get('/api/test-gemini', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.json({ ok: false, reason: 'GEMINI_API_KEY tanımlı değil.' });
  }
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Merhaba' }] }] })
      }
    );
    const d = await r.json();
    res.json({
      ok: r.ok,
      status: r.status,
      model_used: TEXT_MODEL,
      reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || null,
      error: d?.error || null
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ----------------------------------------------------
// ROUTES
// ----------------------------------------------------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`🚀 ChatixAI çalışıyor: port ${PORT}`);
  console.log(`📝 Text Model: ${TEXT_MODEL}`);
  console.log(`🎨 Image Model: ${IMAGE_MODEL}`);
});
