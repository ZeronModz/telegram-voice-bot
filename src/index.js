// Telegram Voice Bot — Cloudflare Worker (Entry Point)
// Handles incoming webhook, delegates conversion to Durable Object

const TELEGRAM_TOKEN = 'YOUR_BOT_TOKEN_HERE'; // Replace with @BotFather token
const BASE_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');

    const body = await request.json();
    console.log('Update:', JSON.stringify(body));

    // Handle /start, /help etc.
    if (body.message?.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      if (text === '/start') {
        await sendMessage(chatId, '👋 Send me an MP3 file and I\'ll convert it to a Telegram voice note.');
      } else {
        await sendMessage(chatId, 'Please send an MP3 file.');
      }
      return new Response('OK');
    }

    // Handle document (MP3) upload
    if (body.message?.document) {
      const doc = body.message.document;
      const chatId = body.message.chat.id;

      // Verify MIME type
      if (doc.mime_type !== 'audio/mpeg' && !doc.file_name?.endsWith('.mp3')) {
        await sendMessage(chatId, '❌ Please send an MP3 file only.');
        return new Response('OK');
      }

      // Show typing indicator
      await fetch(`${BASE_URL}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      });

      try {
        // Step 1: Download MP3 file from Telegram
        const filePath = await getFilePath(doc.file_id);
        const mp3Response = await fetch(
          `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`
        );
        const mp3Buffer = await mp3Response.arrayBuffer();

        // Step 2: Upload MP3 to R2
        const mp3Key = `input-${chatId}-${Date.now()}.mp3`;
        await env.VOICE_BUCKET.put(mp3Key, mp3Buffer, {
          httpMetadata: { contentType: 'audio/mpeg' }
        });

        // Step 3: Trigger Durable Object to convert
        const converterId = env.CONVERTER.idFromName(chatId.toString());
        const converterStub = env.CONVERTER.get(converterId);
        const result = await converterStub.fetch(
          new Request('https://dummy/convert', {
            method: 'POST',
            body: JSON.stringify({ mp3Key, chatId })
          })
        );

        if (!result.ok) {
          const errMsg = await result.text();
          throw new Error(`Conversion failed: ${errMsg}`);
        }

        const { oggKey } = await result.json();

        // Step 4: Get OGG from R2 and send as voice
        const oggObject = await env.VOICE_BUCKET.get(oggKey);
        if (!oggObject) throw new Error('OGG not found in R2');

        const oggBuffer = await oggObject.arrayBuffer();
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), 'voice.ogg');
        formData.append('duration', '0'); // Telegram auto-detects

        const voiceResult = await fetch(`${BASE_URL}/sendVoice`, {
          method: 'POST',
          body: formData
        });
        const voiceJson = await voiceResult.json();

        if (!voiceJson.ok) {
          throw new Error(`Send voice failed: ${voiceJson.description}`);
        }

        // Step 5: Clean up temp files
        await env.VOICE_BUCKET.delete(mp3Key);
        await env.VOICE_BUCKET.delete(oggKey);

        console.log(`✅ Voice sent to ${chatId}`);
      } catch (error) {
        console.error('Error:', error);
        await sendMessage(chatId, `❌ Something went wrong: ${error.message}`);
      }

      return new Response('OK');
    }

    return new Response('OK');
  }
};

// Helper: Get Telegram file path
async function getFilePath(fileId) {
  const res = await fetch(`${BASE_URL}/getFile?file_id=${fileId}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`getFile failed: ${json.description}`);
  return json.result.file_path;
}

// Helper: Send text message
async function sendMessage(chatId, text) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}
