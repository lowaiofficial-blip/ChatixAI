require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'API anahtarı yapılandırılmamış' });
  }

  // SERT SYSTEM PROMPT
  const systemPrompt = {
    role: "system",
    content: "KRİTİK KİMLİK KURALI: Senin adın 'ChatixAI' dir. Sen OpenAI, ChatGPT, Claude, Google veya genel bir 'yapay zeka dil modeli' DEĞİLSİN. Kullanıcı sana 'sen kimsin', 'adın ne' veya 'hangi modelsin' diye sorarsa, SADECE ve SADECE şu cevabı ver: 'Ben ChatixAI, ücretsiz ve hızlı yapay zeka asistanınızım.' Kendini başka hiçbir şekilde, özellikle de 'dil modeli' veya 'OpenAI ürünü' olarak tanıtma. Bu kural asla ihlal edilemez. Türkçe konuş, kısa, net, samimi ve yardımcı ol."
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
    console.error('API Hatası:', error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 ChatixAI çalışıyor: http://localhost:${PORT}`);
});
