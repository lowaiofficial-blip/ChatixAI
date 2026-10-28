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

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// CHATIX-LITE (Gemini) - SİSTEM TALİMATI
// ----------------------------------------------------
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

// ----------------------------------------------------
// GEMİNİ İÇİN GEÇMİŞ HAZIRLAMA
// ----------------------------------------------------
function buildContents(messages) {
  // Görsel (base64) kayıtlarını metin geçmişine sokma
  const textMessages = (messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.type !== 'image' && m.content)
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', text: String(m.content) }));

  // Aynı roldeki art arda mesajları birleştir (Gemini bunu gerektirir)
  const contents = [];
  for (const m of textMessages) {
    const last = contents[contents.length - 1];
    if (last && last.role === m.role) {
      last.parts[0].text += '\n\n' + m.text;
    } else {
      contents.push({ role: m.role, parts: [{ text: m.text }] });
    }
  }

  // İlk mesaj mutlaka user olmalı
  while (contents.length && contents[0].role !== 'user') contents.shift();

  return contents;
}

// ----------------------------------------------------
// 1) SOHBET - GEMİNİ (Non-streaming, karalı)
// ----------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const { messages, userTokens } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    console.error('[Chat] GEMINI_API_KEY eksik!');
    return res.status(500).json({ error: 'GEMINI_API_KEY yapılandırılmamış' });
  }

  const contents = buildContents(messages);
  if (contents.length === 0) {
    return res.status(400).json({ error: 'Geçerli bir mesaj yok' });
  }

  try {
    console.log('[Chat] Gemini çağrılıyor...');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT + '\nKullanıcının bakiyesi: ' + (userTokens || 0) + ' token.' }] },
          contents,
          generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('[Chat] Gemini hatası:', response.status, JSON.stringify(data).substring(0, 400));
      return res.status(response.status).json({
        error: data?.error?.message || 'Gemini API hatası'
      });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = parts.map(p => p.text || '').join('').trim();

    if (!content) {
      console.warn('[Chat] Boş yanıt döndü:', JSON.stringify(data).substring(0, 300));
      return res.json({ success: true, content: 'Bu konu hakkında yanıt veremiyorum. Başka bir soru sorabilir misin?' });
    }

    console.log('[Chat] Yanıt alındı:', content.substring(0, 80));
    res.json({ success: true, content });

  } catch (error) {
    console.error('[Chat] Beklenmeyen hata:', error.message);
    res.status(500).json({ error: 'Bağlantı kurulamadı: ' + error.message });
  }
});

// ----------------------------------------------------
// 2) GÖRSEL ÜRETME - GEMİNİ IMAGE
// ----------------------------------------------------
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY yapılandırılmamış' });
  }
  if (!prompt) return res.status(400).json({ error: 'Görsel açıklaması gerekli' });

  // Kullanım hakkı olan görsel modeller sırayla denenir
  const models = [
    process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-exp-image-generation',
    'gemini-2.0-flash-preview-image-generation'
  ];

  let lastError = 'Görsel oluşturulamadı';

  for (const model of models) {
    try {
      console.log('[Image] Denenen model:', model);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
        lastError = data?.error?.message || 'Görsel API hatası';
        console.error('[Image] Model hatası:', response.status, lastError);
        continue;
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData?.data);

      if (imagePart) {
        const mime = imagePart.inlineData.mimeType || 'image/png';
        const imageUrl = `data:${mime};base64,${imagePart.inlineData.data}`;
        console.log('[Image] Başarılı');
        return res.json({ success: true, imageUrl });
      }

      lastError = 'Model görsel yerine metin döndürdü. Daha basit bir görsel tarifi dene.';
    } catch (e) {
      lastError = e.message;
      console.error('[Image] İstisna:', e.message);
    }
  }

  res.status(500).json({ error: lastError });
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
  if (!process.env.MANUS_API_KEY) {
    return res.status(500).json({ error: 'MANUS_API_KEY yapılandırılmamış' });
  }

  try {
    const fullPrompt = url ? `${url} adresine git ve şunu yap: ${prompt}` : prompt;

    const response = await fetch('https://api.manus.ai/v1/tasks', {
      method: 'POST',
      headers: {
        'API_KEY': process.env.MANUS_API_KEY,
        'Content-Type': 'application/json'
      },
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
  if (!taskId || !process.env.MANUS_API_KEY) {
    return res.status(400).json({ status: 'error', error: 'Geçersiz istek' });
  }

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
// 6) TEST - GEMİNİ ÇALIŞIYOR MU?
// ----------------------------------------------------
app.get('/api/test-gemini', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.json({ ok: false, reason: 'GEMINI_API_KEY tanımlı değil. Render > Environment > ekle.' });
  }
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 ChatixAI çalışıyor: port ${PORT}`);
  console.log(`🔑 GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'VAR ✓' : 'YOK ✗'}`);
  console.log(`🧪 Test: /api/test-gemini`);
});
