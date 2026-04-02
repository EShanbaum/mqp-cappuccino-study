import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import ffmpegPath from 'ffmpeg-static';

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

type ClipRequest = {
  participantId: string;
  url: string;
};

type SummaryRequest = {
  question?: string;
  clipName?: string;
  clips?: ClipRequest[];
};

type AudioFetchResult = {
  arrayBuffer: ArrayBuffer;
  contentType: string;
};

function execFileAsync(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(cmd, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sniffMagic(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 12));
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  const asText = Array.from(bytes).map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('');
  return { hex, asText };
}

function setCorsHeaders(res: { set: (header: string, value: string) => void }) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(body: unknown): SummaryRequest {
  if (!body) return {};
  if (typeof body === 'string') {
    return JSON.parse(body) as SummaryRequest;
  }
  return body as SummaryRequest;
}

function extFromType(type: string) {
  if (type.includes('audio/webm')) return 'webm';
  if (type.includes('audio/wav')) return 'wav';
  if (type.includes('audio/mpeg')) return 'mp3';
  if (type.includes('audio/mp4')) return 'mp4';
  if (type.includes('audio/x-m4a') || type.includes('audio/m4a')) return 'm4a';
  if (type.includes('audio/ogg')) return 'ogg';
  return 'bin';
}

async function fetchFullAudio(url: string): Promise<AudioFetchResult> {
  const response = await fetch(url);
  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch audio (${response.status})`);
  }

  const contentRange = response.headers.get('content-range');
  const contentType = response.headers.get('content-type') || 'application/octet-stream';

  if (response.status !== 206 || !contentRange) {
    return {
      arrayBuffer: await response.arrayBuffer(),
      contentType,
    };
  }

  const match = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(contentRange);
  if (!match) {
    return {
      arrayBuffer: await response.arrayBuffer(),
      contentType,
    };
  }

  const total = Number(match[3]);
  const chunkSize = 5 * 1024 * 1024;
  const fetchChunk = async (start: number, chunks: Uint8Array[]): Promise<Uint8Array[]> => {
    if (start >= total) {
      return chunks;
    }

    const end = Math.min(total - 1, start + chunkSize - 1);
    const rangeResponse = await fetch(url, {
      headers: {
        Range: `bytes=${start}-${end}`,
      },
    });

    if (!rangeResponse.ok && rangeResponse.status !== 206) {
      throw new Error(`Failed to fetch audio range (${rangeResponse.status})`);
    }

    const partBuffer = new Uint8Array(await rangeResponse.arrayBuffer());
    return fetchChunk(start + partBuffer.byteLength, [...chunks, partBuffer]);
  };

  const chunks = await fetchChunk(0, []);

  const merged = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return {
    arrayBuffer: merged.buffer,
    contentType,
  };
}

async function maybeConvertWithFfmpeg(inputBuffer: ArrayBuffer, target: 'wav' | 'mp3') {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static binary is unavailable');
  }

  const inputPath = `${tmpdir()}/mic-${randomUUID()}.bin`;
  const outputPath = `${tmpdir()}/mic-${randomUUID()}.${target}`;

  try {
    await fs.writeFile(inputPath, new Uint8Array(inputBuffer));
    await execFileAsync(ffmpegPath, [
      '-y',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      outputPath,
    ]);

    const outBuffer = await fs.readFile(outputPath);
    return outBuffer.buffer.slice(outBuffer.byteOffset, outBuffer.byteOffset + outBuffer.byteLength);
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

function makeTranscriptionForm(
  model: string,
  responseFormat: 'text' | 'json',
  buffer: ArrayBuffer,
  contentType: string,
  ext: string,
) {
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', responseFormat);
  form.append(
    'file',
    new Blob([buffer], { type: contentType }),
    `clip.${ext}`,
  );
  return form;
}

async function transcribeWithModel(
  apiKey: string,
  model: string,
  responseFormat: 'text' | 'json',
  buffer: ArrayBuffer,
  contentType: string,
  ext: string,
) {
  const transcribeResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: makeTranscriptionForm(
      model,
      responseFormat,
      buffer,
      contentType,
      ext,
    ),
  });

  const bodyText = await transcribeResponse.text();
  if (!transcribeResponse.ok) {
    throw new Error(bodyText || `Transcription failed (${transcribeResponse.status})`);
  }

  if (responseFormat === 'json') {
    const parsed = JSON.parse(bodyText) as { text?: string };
    return (parsed.text || '').trim();
  }

  return bodyText.trim();
}

async function transcribeClip(
  apiKey: string,
  clip: ClipRequest,
) {
  const audio = await fetchFullAudio(clip.url);
  const magic = sniffMagic(audio.arrayBuffer);
  if (audio.arrayBuffer.byteLength > 25 * 1024 * 1024) {
    throw new Error(`Audio too large for ${clip.participantId}`);
  }

  const contentType = audio.contentType || 'application/octet-stream';
  const ext = extFromType(contentType);
  console.warn('[mic-summary] audio fetch', {
    participantId: clip.participantId,
    contentType,
    size: audio.arrayBuffer.byteLength,
    magicHex: magic.hex,
    magicText: magic.asText,
  });

  return {
    participantId: clip.participantId,
    text: await (async () => {
      try {
        return await transcribeWithModel(
          apiKey,
          'gpt-4o-mini-transcribe',
          'text',
          audio.arrayBuffer,
          contentType,
          ext,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldFallback = message.includes('unsupported_format')
          || message.includes('Audio file might be corrupted or unsupported')
          || message.includes('invalid_value')
          || message.includes('messages');

        if (!shouldFallback) {
          throw error;
        }

        console.warn('[mic-summary] primary transcription failed, retrying with ffmpeg conversion', {
          participantId: clip.participantId,
          contentType,
          ext,
          error: message,
        });

        const wavBuffer = await maybeConvertWithFfmpeg(audio.arrayBuffer, 'wav');
        return transcribeWithModel(
          apiKey,
          'whisper-1',
          'json',
          wavBuffer,
          'audio/wav',
          'wav',
        );
      }
    })(),
  };
}

async function summarizeTranscripts(
  apiKey: string,
  request: SummaryRequest,
  transcripts: Array<{ participantId: string; text: string }>,
) {
  const prompt = [
    'Summarize the participants responses for this question.',
    'Return a concise paragraph and 3-6 bullet points of themes.',
    request.question ? `Question: ${request.question}` : null,
    request.clipName ? `Clip group: ${request.clipName}` : null,
    '',
    'Transcripts:',
    ...transcripts.map((transcript) => `Participant ${transcript.participantId}: ${transcript.text}`),
  ].filter(Boolean).join('\n');

  const summaryResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert research assistant who summarizes qualitative study responses.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!summaryResponse.ok) {
    const errorText = await summaryResponse.text();
    throw new Error(`Summary failed: ${errorText}`);
  }

  const summaryData = await summaryResponse.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return summaryData.choices?.[0]?.message?.content?.trim() || '';
}

export const micGroupSummary = onRequest(
  {
    region: 'us-central1',
    timeoutSeconds: 540,
    memory: '1GiB',
    secrets: [OPENAI_API_KEY],
  },
  async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey) {
        throw new Error('Missing OPENAI_API_KEY secret');
      }

      const body = parseBody(req.body);
      const clips = body.clips ?? [];
      if (clips.length === 0) {
        res.status(400).json({ error: 'No clips provided' });
        return;
      }

      const transcripts = await Promise.all(clips.map((clip) => transcribeClip(apiKey, clip)));
      const summary = await summarizeTranscripts(apiKey, body, transcripts);

      res.status(200).json({
        summary,
        transcriptsCount: transcripts.length,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);
