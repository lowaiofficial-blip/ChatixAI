require('dotenv').config();
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (e) { console.error('Firebase Admin başlatılamadı:', e.message); }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🌟 GÖRSEL OLUŞTURMA ENDPOINT'İ (Gemini API)
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY yapılandırılmamış' });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error: `Gemini Görsel API Hatası: ${error}` });
    }

    const data = await response.json();
    let imageUrl = null;
    
    if (data.candidates && data.candidates[0]?.content?.parts) {
      for (const part of data.candidates[0].content.parts) {
        if (part.inlineData && part.inlineData.data) {
          imageUrl = `data:image/png;base64,${part.inlineData.data}`;
          break;
        }
      }
    }

    if (!imageUrl) return res.status(404).json({ error: 'Görsel oluşturulamadı.' });

    res.json({ success: true, imageUrl: imageUrl });

  } catch (error) {
    console.error('Görsel Üretim Hatası:', error);
    res.status(500).json({ error: 'Görsel oluşturulurken sunucu hatası' });
  }
});

// 1. WEB ARAMA ENDPOINT'İ (Jina AI)
app.post('/api/web-search', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' }
    });
    if (!response.ok) throw new Error(`Web içeriği alınamadı: ${response.status}`);
    const content = await response.text();
    const maxLength = 8000;
    res.json({ content: content.length > maxLength ? content.substring(0, maxLength) + '... [kısaltıldı]' : content });
  } catch (error) {
    res.status(500).json({ error: 'Web içeriği okunamadı' });
  }
});

// 2. MANUS.AI GÖREV BAŞLATMA
app.post('/api/execute-agent', async (req, res) => {
  const { userId, prompt, url, cost } = req.body;
  if (!process.env.MANUS_API_KEY) return res.status(500).json({ error: 'Manus API anahtarı yapılandırılmamış' });

  try {
    const fullPrompt = url ? `${url} adresine git ve şunu yap: ${prompt}` : prompt;
    const startResponse = await fetch('https://api.manus.ai/v1/tasks', {
      method: 'POST',
      headers: { 'API_KEY': process.env.MANUS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fullPrompt })
    });

    if (!startResponse.ok) throw new Error(`Manus Başlatma Hatası: ${await startResponse.text()}`);
    const startData = await startResponse.json();
    const taskId = startData.task_id || startData.id;
    if (!taskId) throw new Error('Manus görev kimliği alınamadı.');

    res.json({ success: true, taskId: taskId, message: 'Görev başarıyla başlatıldı.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Görev başlatılamadı.' });
  }
});

// 3. MANUS.AI DURUM SORGULAMA
app.get('/api/check-task-status', async (req, res) => {
  const { taskId, userId, cost } = req.query;
  if (!taskId) return res.status(400).json({ error: 'Task ID gerekli' });
  if (!process.env.MANUS_API_KEY) return res.status(500).json({ error: 'Manus API anahtarı yapılandırılmamış' });

  try {
    const statusResponse = await fetch(`https://api.manus.ai/v1/tasks/${taskId}`, {
      method: 'GET',
      headers: { 'API_KEY': process.env.MANUS_API_KEY, 'Content-Type': 'application/json' }
    });
    const statusData = await statusResponse.json();
    const status = statusData.status;

    if (status === 'completed' && userId && cost) {
      const result = statusData.result || statusData.output || "Görev başarıyla tamamlandı.";
      if (admin.apps.length > 0) {
        try {
          await admin.firestore().collection('users').doc(userId).update({
            tokens: admin.firestore.FieldValue.increment(-parseInt(cost))
          });
        } catch (err) { console.error('Token düşme hatası:', err); }
      }
      res.json({ status: 'completed', result: result, tokensDeducted: parseInt(cost) });
    } else if (status === 'failed') {
      res.json({ status: 'failed', error: statusData.error || "Görev başarısız oldu." });
    } else {
      res.json({ status: status, message: statusData.message || 'İşlem devam ediyor...' });
    }
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message || 'Durum sorgulanamadı.' });
  }
});

// 4. CHAT API (Tamamen Gemini API üzerinden)
app.post('/api/chat', async (req, res) => {
  const { messages, userTokens } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY yapılandırılmamış' });
  }

  const systemInstructionText = `KRİTİK KİMLİK KURALI: Senin adın 'ChatixAI' dir. Sen OpenAI, ChatGPT, Claude, Google veya genel bir 'yapay zeka dil modeli' DEĞİLSİN. Türkçe konuş, kısa, net, samimi ve yardımcı ol.

WEB OTOMASYONU VE AKILLI TOKEN KURALI:
Eğer kullanıcı senden bir web sitesine gidip işlem yapmasını isterse:
1. Asla doğrudan "yapıyorum" deme.
2. İŞLEMİN AĞIRLIĞINA GÖRE TOKEN MALİYETİ BELİRLE:
   - BASİT (5 token): Siteyi okuma, bilgi çekme
   - ORTA (20 token): Butona tıklama, form doldurma
   - ZOR (50 token): Kayıt olma, mesaj atma, CAPTCHA
3. Tam olarak şu formatta yanıt ver:
[TOKEN_REQUEST:X]
🪙 Hesabınızda şu an ${userTokens || 0} token var. Bu işlem yaklaşık X token tüketecek. Kabul ediyor musunuz?`;

  // Frontend'den gelen mesajları Gemini formatına çevir
  const geminiContents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstructionText }] },
        contents: geminiContents
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error: `Gemini API Hatası: ${error}` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim() !== '');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            // Gemini'den gelen metni frontend'in beklediği formata çevir
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text) {
              res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
            }
          } catch (e) {}
        }
      }
    }
    res.end();
  } catch (error) {
    console.error('Gemini Chat Hatası:', error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// 5. ROUTES
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 ChatixAI çalışıyor: http://localhost:${PORT}`);
});
