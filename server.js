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

app.post('/api/execute-agent', async (req, res) => {
  const { userId, prompt, url, cost } = req.body;
  if (!process.env.MANUS_API_KEY) {
    return res.status(500).json({ error: 'Manus API anahtarı yapılandırılmamış' });
  }
  try {
    const fullPrompt = url ? `${url} adresine git ve şunu yap: ${prompt}` : prompt;
    const startResponse = await fetch('https://api.manus.ai/v1/tasks', {
      method: 'POST',
      headers: {
        'API_KEY': process.env.MANUS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: fullPrompt })
    });
    if (!startResponse.ok) {
      const errText = await startResponse.text();
      throw new Error(`Manus Başlatma Hatası: ${errText}`);
    }
    const startData = await startResponse.json();
    const taskId = startData.task_id || startData.id;
    if (!taskId) throw new Error('Manus görev kimliği alınamadı.');

    let status = 'pending';
    let result = null;
    let attempts = 0;
    const maxAttempts = 40;

    while (status === 'pending' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const statusResponse = await fetch(`https://api.manus.ai/v1/tasks/${taskId}`, {
        method: 'GET',
        headers: { 'API_KEY': process.env.MANUS_API_KEY, 'Content-Type': 'application/json' }
      });
      const statusData = await statusResponse.json();
      status = statusData.status;
      if (status === 'completed') {
        result = statusData.result || statusData.output || "Görev başarıyla tamamlandı.";
      } else if (status === 'failed') {
        throw new Error(statusData.error || "Manus görevi başarısız oldu.");
      }
      attempts++;
    }
    if (status !== 'completed') {
      throw new Error('Görev zaman aşımına uğradı (2 dakika).');
    }
    if (admin.apps.length > 0) {
      await admin.firestore().collection('users').doc(userId).update({
        tokens: admin.firestore.FieldValue.increment(-cost)
      });
    }
    res.json({ success: true, message: result, tokensDeducted: cost });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Otomasyon sırasında bir hata oluştu.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages, userTokens } = req.body;
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'API anahtarı yapılandırılmamış' });
  }

  const systemPrompt = {
    role: "system",
    content: `KRİTİK KİMLİK KURALI: Senin adın 'ChatixAI' dir. Sen OpenAI, ChatGPT, Claude veya genel bir 'yapay zeka dil modeli' DEĞİLSİN. Türkçe konuş, kısa, net, samimi ve yardımcı ol.

WEB OTOMASYONU VE AKILLI TOKEN KURALI (ÇOK ÖNEMLİ):
Eğer kullanıcı senden bir web sitesine gidip işlem yapmasını isterse (form doldur, kayıt ol, tıkla, mesaj at, satın al vs.):
1. Asla doğrudan "yapıyorum" deme.
2. İŞLEMİN AĞIRLIĞINA GÖRE TOKEN MALİYETİ BELİRLE:
   - BASİT İŞLEM (5 token): Sadece siteyi okuma, fiyat bulma, bilgi çekme
   - ORTA İŞLEM (20 token): Butona tıklama, form doldurma, arama yapma
   - ZOR İŞLEM (50 token): Kayıt olma, giriş yapma, mesaj atma, satın alma, CAPTCHA çözme
3. Tam olarak şu formatta yanıt ver (sayı, işlemin ağırlığına göre değişecek):
[TOKEN_REQUEST:X]
🪙 Hesabınızda şu an ${userTokens || 0} token var. Bu işlem yaklaşık X token tüketecek. Kabul ediyor musunuz?
4. Kullanıcı "Evet" derse işlemi başlat.`
  };

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.SITE_URL || 'http://localhost:3000',
        'X-Title': 'ChatixAI'
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages: [systemPrompt, ...messages],
        stream: true
      })
    });
    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error: error });
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
          const data = line.slice(6);
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content || '';
            if (content) {
              res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
          } catch (e) {}
        }
      }
    }
    res.end();
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 ChatixAI çalışıyor: http://localhost:${PORT}`);
});
