/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import react from '@vitejs/plugin-react-swc';

function normalizeBasePath(path: string): string {
  if (!path) return '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function resolveBasePath(command: string, env: Record<string, string>): string {
  if (command !== 'build') {
    return '/';
  }

  if (env.VITE_BASE_PATH) {
    return normalizeBasePath(env.VITE_BASE_PATH);
  }

  const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
  if (repositoryName && !repositoryName.endsWith('.github.io')) {
    return normalizeBasePath(repositoryName);
  }

  return '/';
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const openAiPlugin = () => ({
    name: 'local-openai-mic-summary',
    configureServer(server: import('vite').ViteDevServer) {
      /* eslint-disable no-await-in-loop */
      const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

      const json = (res: import('http').ServerResponse, status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };

      const readBody = (req: import('http').IncomingMessage) => new Promise<string>((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });

      const execFileAsync = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
        execFile(cmd, args, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      const sniffMagic = (buffer: ArrayBuffer) => {
        const bytes = new Uint8Array(buffer.slice(0, 12));
        const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const asText = Array.from(bytes).map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
        return { hex, asText };
      };

      const maybeConvertWithFfmpeg = async (inputBuffer: ArrayBuffer, target: 'wav' | 'mp3') => {
        const inputPath = `${tmpdir()}/mic-${randomUUID()}.bin`;
        const outputPath = `${tmpdir()}/mic-${randomUUID()}.${target}`;
        try {
          await fs.writeFile(inputPath, new Uint8Array(inputBuffer));
          await execFileAsync('ffmpeg', [
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
      };

      server.middlewares.use('/api/mic-group-summary', async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'Method not allowed' });
          return;
        }

        if (!apiKey) {
          json(res, 500, { error: 'Missing OPENAI_API_KEY in server env' });
          return;
        }

        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as {
            trialKey?: string;
            clipName?: string;
            responseId?: string;
            questionPrompt?: string;
            componentId?: string;
            componentPrompt?: string;
            questionType?: string;
            condition?: string;
            answerOptions?: string[];
            answerFormatDescription?: string;
            clips?: Array<{ participantId: string; url: string; selectedChoice?: string }>;
          };

          const clips = body.clips ?? [];
          if (clips.length === 0) {
            json(res, 400, { error: 'No clips provided' });
            return;
          }

          const fetchFullAudio = async (url: string) => {
            const response = await fetch(url);
            if (!response.ok && response.status !== 206) {
              throw new Error(`Failed to fetch audio (${response.status})`);
            }

            const contentRange = response.headers.get('content-range');
            if (response.status !== 206 || !contentRange) {
              return {
                arrayBuffer: await response.arrayBuffer(),
                contentType: response.headers.get('content-type') || 'application/octet-stream',
                debug: {
                  status: response.status,
                  contentRange,
                  contentLength: response.headers.get('content-length'),
                },
              };
            }

            const match = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(contentRange);
            if (!match) {
              return {
                arrayBuffer: await response.arrayBuffer(),
                contentType: response.headers.get('content-type') || 'application/octet-stream',
                debug: {
                  status: response.status,
                  contentRange,
                  contentLength: response.headers.get('content-length'),
                },
              };
            }

            const total = Number(match[3]);
            const chunkSize = 5 * 1024 * 1024;
            const chunks: Uint8Array[] = [];
            let fetched = 0;

            while (fetched < total) {
              const start = fetched;
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
              chunks.push(partBuffer);
              fetched += partBuffer.byteLength;
            }

            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.byteLength;
            }

            return {
              arrayBuffer: merged.buffer,
              contentType: response.headers.get('content-type') || 'application/octet-stream',
              debug: {
                status: response.status,
                contentRange,
                contentLength: response.headers.get('content-length'),
              },
            };
          };

          const extFromType = (type: string) => {
            if (type.includes('audio/webm')) return 'webm';
            if (type.includes('audio/wav')) return 'wav';
            if (type.includes('audio/mpeg')) return 'mp3';
            if (type.includes('audio/mp4')) return 'mp4';
            if (type.includes('audio/x-m4a') || type.includes('audio/m4a')) return 'm4a';
            if (type.includes('audio/ogg')) return 'ogg';
            return 'bin';
          };

          const makeForm = (
            model: string,
            responseFormat: 'text' | 'json',
            buffer: ArrayBuffer,
            contentType: string,
            ext: string,
          ) => {
            const form = new FormData();
            form.append('model', model);
            form.append('response_format', responseFormat);
            form.append(
              'file',
              new Blob([buffer], { type: contentType }),
              `clip-${randomUUID()}.${ext}`,
            );
            return form;
          };

          const transcribeWithModel = async (
            model: string,
            responseFormat: 'text' | 'json',
            buffer: ArrayBuffer,
            contentType: string,
            ext: string,
          ) => {
            const trRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
              body: makeForm(model, responseFormat, buffer, contentType, ext),
            });
            const bodyText = await trRes.text();
            if (!trRes.ok) {
              throw new Error(bodyText || `Transcription failed (${trRes.status})`);
            }
            if (responseFormat === 'json') {
              const parsed = JSON.parse(bodyText) as { text?: string };
              return (parsed.text || '').trim();
            }
            return bodyText.trim();
          };

          const transcripts = await Promise.all(clips.map(async (clip) => {
            const audio = await fetchFullAudio(clip.url);
            const magic = sniffMagic(audio.arrayBuffer);
            server.config.logger.warn('[mic-summary] audio fetch', {
              participantId: clip.participantId,
              ...audio.debug,
              contentType: audio.contentType,
              magicHex: magic.hex,
              magicText: magic.asText,
            });

            const { arrayBuffer } = audio;
            if (arrayBuffer.byteLength > 25 * 1024 * 1024) {
              throw new Error(`Audio too large for ${clip.participantId}`);
            }

            const contentType = audio.contentType || 'application/octet-stream';
            const ext = extFromType(contentType);

            try {
              const text = await transcribeWithModel(
                'gpt-4o-mini-transcribe',
                'text',
                arrayBuffer,
                contentType,
                ext,
              );
              return { participantId: clip.participantId, selectedChoice: clip.selectedChoice, text };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const shouldFallback = msg.includes('unsupported_format') || msg.includes('messages');
              const wavBuffer = await maybeConvertWithFfmpeg(arrayBuffer, 'wav');
              const text = await transcribeWithModel('whisper-1', 'json', wavBuffer, 'audio/wav', 'wav');
              if (!shouldFallback && !text) {
                throw new Error(`Transcription failed: ${msg}`);
              }
              return { participantId: clip.participantId, selectedChoice: clip.selectedChoice, text };
            }
          }));

          const prompt = [
            'Task',
            '',
            'You are analyzing individual recordings of participants answering questions in a data visualization study on the platform.',
            'Each recording corresponds to one response to one question.',
            'Your goal is to summarize the participant\'s decision-making and reasoning within that single response, while enabling comparison across conditions later.',
            'Use only observable speech and interaction.',
            'Do not infer intent beyond what is explicitly stated.',
            '',
            'Output Requirements (Per Recording)',
            'Before the per-recording analysis, provide an "Overall Summary" section for the researcher/study owner.',
            'That overall summary should briefly synthesize the main patterns across all recordings in this clip group so they can grasp the overall direction of responses quickly.',
            'Include 3 short bullet points covering recurring claims, common reasoning patterns, and notable uncertainty/bias patterns if present.',
            '',
            'Then, for each recording below, provide the following fields:',
            'Condition',
            'Claim / Answer',
            'Reasoning Process',
            'Confidence Level',
            'Uncertainty & Hesitation Signals',
            'Bias / Heuristic Indicators (if present)',
            'Visualization Influence (if observable)',
            '',
            'Codebook to Apply',
            '1. Forming Assumptions',
            'Making guesses about creator attributes.',
            'Speculative reasoning from limited cues.',
            'Filling gaps when information is missing.',
            '2. Evidence-Based Reasoning',
            'Referencing specific chart elements, labels, colors, structure, or comparisons within the chart.',
            '3. Confidence & Uncertainty',
            'High confidence, low confidence, hesitations, and self-corrections.',
            '4. Bias & Heuristics',
            'Stereotype-based reasoning, overgeneralizing from minimal cues, inferring identity from style/design.',
            '5. Visualization-Driven Reasoning',
            'Direct use of chart content to justify claims, ignoring available data, or misinterpreting visual elements.',
            '',
            'What to Look For',
            'Speech: explicit answers and justifications, think-aloud reasoning, confidence markers, uncertainty, revisions.',
            'Behavior (if visible in speech/transcript metadata only): pauses, hesitation, quick conclusions, or re-examining chart elements if stated.',
            '',
            'Important Rules',
            'Treat each recording independently.',
            'Do not assume knowledge of previous responses.',
            'Do not compare across conditions in this step.',
            'Focus strictly on the reasoning within the single response.',
            'Ground everything in observable evidence only.',
            'Format the result in Markdown.',
            'Use this structure:',
            '## Overall Summary',
            '- bullet 1',
            '- bullet 2',
            '- bullet 3',
            '',
            '## Participant <id>',
            '- Condition: ...',
            '- Claim / Answer: ...',
            '- Reasoning Process: ...',
            '- Confidence Level: ...',
            '- Uncertainty & Hesitation Signals: ...',
            '- Bias / Heuristic Indicators: ...',
            '- Visualization Influence: ...',
            '',
            'Question Context',
            body.condition ? `Condition: ${body.condition}` : null,
            body.questionPrompt ? `Question: ${body.questionPrompt}` : null,
            body.componentPrompt ? `Study instruction: ${body.componentPrompt}` : null,
            body.questionType ? `Response type: ${body.questionType}` : null,
            body.answerOptions?.length ? `Answer options: ${body.answerOptions.join(', ')}` : null,
            body.answerFormatDescription ? `Answer format: ${body.answerFormatDescription}` : null,
            body.componentId ? `Component: ${body.componentId}` : null,
            body.responseId ? `Response id: ${body.responseId}` : null,
            body.trialKey ? `Trial key: ${body.trialKey}` : null,
            body.clipName ? `Clip group: ${body.clipName}` : null,
            '',
            'Recordings to Analyze:',
            ...transcripts.map((t) => [
              `Participant ${t.participantId}`,
              t.selectedChoice ? `Selected response: ${t.selectedChoice}` : null,
              `Transcript: ${t.text}`,
            ].filter(Boolean).join('\n')),
          ].filter(Boolean).join('\n');

          const summaryRes = await fetch('https://api.openai.com/v1/chat/completions', {
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

          if (!summaryRes.ok) {
            const errText = await summaryRes.text();
            throw new Error(`Summary failed: ${errText}`);
          }

          const summaryData = await summaryRes.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const summary = summaryData.choices?.[0]?.message?.content?.trim() || '';

          json(res, 200, { summary, transcriptsCount: transcripts.length });
        } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : 'Unknown error' });
        }
      });
    },
  });

  return {
    base: resolveBasePath(command, env),
    plugins: [
      react({ devTarget: 'es2022' }),
      openAiPlugin(),
    ],
    resolve: {
      alias: {
        // /esm/icons/index.mjs only exports the icons statically, so no separate chunks are created
        '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
      },
    },
    test: {
      exclude: ['./tests/**', 'node_modules/**'],
      setupFiles: ['vitest-localstorage-mock'],
      fileParallelism: false,
    },
  };
});
