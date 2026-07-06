// AudioConverter — Durable Object running ffmpeg.wasm
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export class AudioConverter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ffmpeg = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/convert') {
      const { mp3Key, chatId } = await request.json();
      try {
        const oggKey = await this.convertMp3ToOgg(mp3Key, chatId);
        return new Response(JSON.stringify({ oggKey }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(error.message, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }

  async convertMp3ToOgg(mp3Key, chatId) {
    // Lazy-load ffmpeg.wasm (one-time per DO instance)
    if (!this.ffmpeg) {
      this.ffmpeg = new FFmpeg();
      
      // Load ffmpeg core from CDN
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      console.log('ffmpeg loaded');
    }

    // Fetch MP3 from R2
    const mp3Object = await this.env.VOICE_BUCKET.get(mp3Key);
    if (!mp3Object) throw new Error('MP3 not found in R2');
    const mp3Data = await mp3Object.arrayBuffer();

    // Write MP3 to ffmpeg virtual FS
    const inputName = 'input.mp3';
    const outputName = `voice-${chatId}-${Date.now()}.ogg`;
    await this.ffmpeg.writeFile(inputName, new Uint8Array(mp3Data));

    // Run ffmpeg: MP3 -> OGG Opus (optimized for Telegram voice)
    await this.ffmpeg.exec([
      '-i', inputName,
      '-c:a', 'libopus',       // Opus codec
      '-b:a', '16k',            // 16 kbps (voice quality)
      '-ac', '1',               // Mono
      '-ar', '16000',           // 16kHz sample rate
      '-application', 'voip',   // Optimized for speech
      '-vbr', 'off',            // Constant bitrate
      '-frame_duration', '20',  // 20ms frames
      outputName
    ]);

    // Read OGG output
    const oggData = await this.ffmpeg.readFile(outputName);

    // Clean up ffmpeg virtual FS
    await this.ffmpeg.deleteFile(inputName);
    await this.ffmpeg.deleteFile(outputName);

    // Upload OGG to R2
    const oggKey = `output-${chatId}-${Date.now()}.ogg`;
    await this.env.VOICE_BUCKET.put(oggKey, oggData, {
      httpMetadata: { contentType: 'audio/ogg' }
    });

    return oggKey;
  }
}
