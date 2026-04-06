import {
  Accordion,
  Box,
  Button,
  Group,
  LoadingOverlay,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { StudyConfig } from '../../../parser/types';
import { ReactMarkdownWrapper } from '../../../components/ReactMarkdownWrapper';
import { useStorageEngine } from '../../../storage/storageEngineHooks';
import { ParticipantData } from '../../../storage/types';
import { studyComponentToIndividualComponent } from '../../../utils/handleComponentInheritance';

const localSummaryEndpoint = '/api/mic-group-summary';
const configuredSummaryEndpoint = import.meta.env.VITE_MIC_GROUP_SUMMARY_API_URL?.trim();
const summaryEndpoint = configuredSummaryEndpoint
  || (import.meta.env.DEV ? localSummaryEndpoint : '');

type ParticipantClips = {
  participantId: string;
  clips: Array<{ name: string; url: string }>;
};

type GroupedClipEntry = {
  participantId: string;
  url: string;
  selectedChoice?: string;
};

type SummaryClipEntry = {
  participantId: string;
  url: string;
  selectedChoice?: string;
};

type ClipQuestionContext = {
  clipName: string;
  responseId: string;
  componentId: string;
  componentPrompt: string;
  questionPrompt: string;
  questionType: string;
  condition: 'Obscured' | 'Unobscured' | 'Unknown';
  answerOptions?: string[];
  answerFormatDescription: string;
};

type ParsedParticipantSummary = {
  id: string;
  title: string;
  content: string;
};

type ParsedSummary = {
  overall: string;
  participants: ParsedParticipantSummary[];
};

function normalizeJoinKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatSelectedChoice(value: string | number | boolean | string[] | undefined) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === undefined) {
    return undefined;
  }
  return String(value);
}

function getConditionLabel(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes('unobscured')) return 'Unobscured';
  if (normalized.includes('obscured')) return 'Obscured';
  return 'Unknown';
}

function formatStringOptions(options: Array<string | { label: string; value: string }>) {
  return options.map((option) => (typeof option === 'string' ? option : `${option.label} (${option.value})`));
}

function parseSummarySections(summary: string): ParsedSummary {
  const normalized = summary.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return { overall: '', participants: [] };
  }

  const sections = normalized.split(/^##\s+/m).filter(Boolean);
  let overall = '';
  const participants: ParsedParticipantSummary[] = [];

  sections.forEach((section) => {
    const [rawTitle = '', ...bodyLines] = section.split('\n');
    const title = rawTitle.trim();
    const content = bodyLines.join('\n').trim();

    if (/^Overall Summary$/i.test(title)) {
      overall = content;
      return;
    }

    if (/^Participant\b/i.test(title)) {
      const participantId = title.replace(/^Participant\s*/i, '').trim() || title;
      participants.push({
        id: participantId,
        title,
        content,
      });
    }
  });

  if (!overall && participants.length === 0) {
    return { overall: normalized, participants: [] };
  }

  return { overall, participants };
}

function getQuestionMetadata(response: {
  type: string;
  options?: Array<string | { label: string; value: string } | { label: string; value: number }>;
  minSelections?: number;
  maxSelections?: number;
  leftLabel?: string;
  rightLabel?: string;
  numItems?: number;
  start?: number;
  spacing?: number;
  answerOptions?: string[] | string;
  questionOptions?: string[];
}) {
  switch (response.type) {
    case 'radio':
    case 'dropdown':
    case 'checkbox':
    case 'buttons': {
      const options = formatStringOptions((response.options || []) as Array<string | { label: string; value: string }>);
      const selectionRule = response.type === 'checkbox'
        ? `Select one or more options${response.minSelections ? `, minimum ${response.minSelections}` : ''}${response.maxSelections ? `, maximum ${response.maxSelections}` : ''}.`
        : 'Select exactly one option.';
      return {
        answerOptions: options,
        answerFormatDescription: `${selectionRule} Available options: ${options.join(', ')}.`,
      };
    }
    case 'slider': {
      const sliderOptions = ((response.options || []) as Array<{ label: string; value: number }>)
        .map((option) => `${option.label} (${option.value})`);
      return {
        answerOptions: sliderOptions,
        answerFormatDescription: `Answer on a slider scale${sliderOptions.length ? ` with anchors ${sliderOptions.join(', ')}` : ''}.`,
      };
    }
    case 'likert': {
      const start = response.start ?? 1;
      const spacing = response.spacing ?? 1;
      const end = start + ((response.numItems || 1) - 1) * spacing;
      return {
        answerOptions: undefined,
        answerFormatDescription: `Answer on a Likert scale from ${start} to ${end}${response.leftLabel ? `, left label "${response.leftLabel}"` : ''}${response.rightLabel ? `, right label "${response.rightLabel}"` : ''}.`,
      };
    }
    case 'numerical':
      return { answerOptions: undefined, answerFormatDescription: 'Answer by entering a numeric value.' };
    case 'shortText':
    case 'longText':
      return { answerOptions: undefined, answerFormatDescription: 'Answer by entering free text.' };
    case 'matrix-radio':
    case 'matrix-checkbox':
      return {
        answerOptions: Array.isArray(response.answerOptions) ? response.answerOptions : undefined,
        answerFormatDescription: `Answer in a matrix format across prompts${response.questionOptions?.length ? `: ${response.questionOptions.join(', ')}` : ''}${Array.isArray(response.answerOptions) ? `. Available answer columns: ${response.answerOptions.join(', ')}` : '.'}`,
      };
    default:
      return { answerOptions: undefined, answerFormatDescription: `Answer using a ${response.type} input.` };
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;

  const runNextBatch = async (): Promise<void> => {
    const batch = items.slice(i, i + limit);
    if (batch.length === 0) return;

    const batchResults = await Promise.all(
      batch.map((item, batchIndex) => fn(item, i + batchIndex)),
    );
    results.push(...batchResults);
    i += limit;
    await runNextBatch();
  };

  await runNextBatch();
  return results;
}

export function QuestionMicAudioPage({ studyConfig }: { studyConfig?: StudyConfig }) {
  const { studyId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { storageEngine } = useStorageEngine();
  const isFirebase = storageEngine?.getEngine() === 'firebase';

  const [participants, setParticipants] = useState<ParticipantData[]>([]);
  const [loadingParticipants, setLoadingParticipants] = useState(false);

  const selectedQuestion = useMemo(() => searchParams.get('question') || '', [searchParams]);

  const questionOptions = useMemo(() => {
    const allKeys = new Set<string>();
    participants.forEach((p) => {
      Object.keys(p.answers || {}).forEach((k) => allKeys.add(k));
    });
    return Array.from(allKeys)
      .sort((a, b) => a.localeCompare(b));
  }, [participants]);

  const [loadingClips, setLoadingClips] = useState(false);
  const [clipsByParticipant, setClipsByParticipant] = useState<ParticipantClips[]>([]);
  const [summaryByClip, setSummaryByClip] = useState<Record<string, string>>({});
  const [summaryStatusByClip, setSummaryStatusByClip] = useState<Record<string, { loading: boolean; error?: string }>>({});
  const parsedSummaryByClip = useMemo(
    () => Object.fromEntries(
      Object.entries(summaryByClip).map(([clipName, summary]) => [clipName, parseSummarySections(summary)]),
    ),
    [summaryByClip],
  );

  const clipQuestionContextByName = useMemo(() => {
    const contextByName = new Map<string, ClipQuestionContext>();
    const contextByNormalizedName = new Map<string, ClipQuestionContext>();

    if (!studyConfig) {
      return {
        exact: contextByName,
        normalized: contextByNormalizedName,
      };
    }

    Object.entries(studyConfig.components).forEach(([componentId, componentConfig]) => {
      const component = studyComponentToIndividualComponent(componentConfig, studyConfig);
      const responses = 'response' in component && Array.isArray(component.response) ? component.response : [];
      const componentPrompt = 'instruction' in component && typeof component.instruction === 'string'
        ? component.instruction
        : '';

      responses.forEach((response: Parameters<typeof getQuestionMetadata>[0] & { id: string; prompt: string }) => {
        const clipName = response.id.split('/').pop() || response.id;
        const questionMetadata = getQuestionMetadata(response as Parameters<typeof getQuestionMetadata>[0]);
        const context: ClipQuestionContext = {
          clipName,
          responseId: response.id,
          componentId,
          componentPrompt,
          questionPrompt: response.prompt,
          questionType: response.type,
          condition: getConditionLabel(clipName || componentId),
          answerOptions: questionMetadata.answerOptions,
          answerFormatDescription: questionMetadata.answerFormatDescription,
        };

        contextByName.set(clipName, context);
        contextByNormalizedName.set(normalizeJoinKey(clipName), context);
        contextByNormalizedName.set(normalizeJoinKey(response.id), context);
      });
    });

    return {
      exact: contextByName,
      normalized: contextByNormalizedName,
    };
  }, [studyConfig]);

  const selectedTrialContext = useMemo(() => {
    if (!selectedQuestion || !participants.length) {
      return null;
    }

    const sampleAnswer = participants
      .map((participant) => participant.answers?.[selectedQuestion])
      .find(Boolean);

    const componentId = sampleAnswer?.componentName || selectedQuestion.split('_').slice(0, -1).join('_') || selectedQuestion;
    if (!studyConfig?.components[componentId]) {
      return null;
    }

    const component = studyComponentToIndividualComponent(studyConfig.components[componentId], studyConfig);
    const componentPrompt = 'instruction' in component && typeof component.instruction === 'string'
      ? component.instruction
      : '';

    return {
      componentId,
      componentPrompt,
    };
  }, [participants, selectedQuestion, studyConfig]);

  const groupedByClipName = useMemo(() => {
    const map = new Map<string, GroupedClipEntry[]>();
    clipsByParticipant.forEach((row) => {
      row.clips.forEach((clip) => {
        const clipContext = clipQuestionContextByName.exact.get(clip.name)
          || clipQuestionContextByName.normalized.get(normalizeJoinKey(clip.name))
          || null;
        const participant = participants.find((p) => p.participantId === row.participantId);
        const trialAnswer = participant?.answers?.[selectedQuestion];
        const selectedChoice = clipContext?.responseId
          ? formatSelectedChoice(trialAnswer?.answer?.[clipContext.responseId])
          : undefined;
        const existing = map.get(clip.name) || [];
        existing.push({ participantId: row.participantId, url: clip.url, selectedChoice });
        map.set(clip.name, existing);
      });
    });

    return Array.from(map.entries())
      .map(([clipName, entries]) => ({
        clipName,
        clipContext: clipQuestionContextByName.exact.get(clipName)
          || clipQuestionContextByName.normalized.get(normalizeJoinKey(clipName))
          || null,
        entries: entries.sort((a, b) => a.participantId.localeCompare(b.participantId)),
      }))
      .sort((a, b) => a.clipName.localeCompare(b.clipName));
  }, [clipQuestionContextByName, clipsByParticipant, participants, selectedQuestion]);

  const summaryUnavailableReason = useMemo(() => {
    if (summaryEndpoint) return '';
    if (!import.meta.env.PROD) return 'Summarization endpoint is not configured.';
    return 'Summarization is not available in this deployment. GitHub Pages is a static host, so configure VITE_MIC_GROUP_SUMMARY_API_URL to point at a server endpoint that can call OpenAI.';
  }, []);

  const summarizeGroup = async (group: { clipName: string; entries: GroupedClipEntry[] }) => {
    const clipContext = clipQuestionContextByName.exact.get(group.clipName)
      || clipQuestionContextByName.normalized.get(normalizeJoinKey(group.clipName))
      || null;
    const clips: SummaryClipEntry[] = group.entries.map((entry) => ({
      participantId: entry.participantId,
      url: entry.url,
      selectedChoice: entry.selectedChoice,
    }));
    const requestBody = {
      trialKey: selectedQuestion,
      clipName: group.clipName,
      responseId: clipContext?.responseId,
      questionPrompt: clipContext?.questionPrompt,
      componentId: clipContext?.componentId ?? selectedTrialContext?.componentId,
      componentPrompt: clipContext?.componentPrompt ?? selectedTrialContext?.componentPrompt,
      questionType: clipContext?.questionType,
      condition: clipContext?.condition,
      answerOptions: clipContext?.answerOptions,
      answerFormatDescription: clipContext?.answerFormatDescription,
      clips,
    };

    setSummaryStatusByClip((prev) => ({
      ...prev,
      [group.clipName]: { loading: true },
    }));

    try {
      if (!summaryEndpoint) {
        throw new Error(summaryUnavailableReason || 'Summarization endpoint is not configured.');
      }

      console.warn('[ReVISit][MicSummary][Browser] Sending summary request', {
        endpoint: summaryEndpoint,
        mode: import.meta.env.DEV ? 'dev' : 'prod',
        requestBody,
      });
      const response = await fetch(summaryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const raw = await response.text();
      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      const payload = raw && isJson ? JSON.parse(raw) : {};
      console.warn('[ReVISit][MicSummary][Browser] Summary response received', {
        endpoint: summaryEndpoint,
        mode: import.meta.env.DEV ? 'dev' : 'prod',
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        payload,
        rawPreview: isJson ? undefined : raw.slice(0, 500),
      });
      if (!isJson) {
        const compactBody = raw.replace(/\s+/g, ' ').slice(0, 120);
        throw new Error(
          response.ok
            ? `Summarization endpoint returned ${contentType || 'non-JSON content'} instead of JSON.`
            : `Summarization endpoint returned ${response.status} ${response.statusText}${compactBody ? `: ${compactBody}` : ''}`,
        );
      }
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to summarize');
      }

      setSummaryByClip((prev) => ({ ...prev, [group.clipName]: payload.summary || '' }));
      setSummaryStatusByClip((prev) => ({ ...prev, [group.clipName]: { loading: false } }));
    } catch (error) {
      console.error('[ReVISit][MicSummary][Browser] Summary request failed', {
        endpoint: summaryEndpoint,
        mode: import.meta.env.DEV ? 'dev' : 'prod',
        clipName: group.clipName,
        error,
      });
      setSummaryStatusByClip((prev) => ({
        ...prev,
        [group.clipName]: {
          loading: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      }));
    }
  };

  // Load participants once
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!studyId || !storageEngine) return;
      setLoadingParticipants(true);
      try {
        await storageEngine.initializeStudyDb(studyId);
        const data = await storageEngine.getAllParticipantsData(studyId);
        if (!cancelled) setParticipants(data);
      } catch (e) {
        if (!cancelled) setParticipants([]);
        console.warn('Failed to load participants for mic audio page', e);
      } finally {
        if (!cancelled) setLoadingParticipants(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [studyId, storageEngine]);

  // Load clips for selected question
  useEffect(() => {
    let cancelled = false;
    async function loadClips() {
      if (!storageEngine || !selectedQuestion || participants.length === 0) {
        setClipsByParticipant([]);
        return;
      }
      setLoadingClips(true);
      try {
        const results = await mapLimit(
          participants,
          8,
          async (p) => {
            const clips = await storageEngine.getQuestionMicFiles(selectedQuestion, p.participantId);
            return { participantId: p.participantId, clips };
          },
        );
        if (!cancelled) {
          setClipsByParticipant(
            results.filter((r) => r.clips.length > 0),
          );
        }
      } catch (e) {
        if (!cancelled) setClipsByParticipant([]);
        console.warn('Failed to load mic clips', e);
      } finally {
        if (!cancelled) setLoadingClips(false);
      }
    }
    loadClips();
    return () => { cancelled = true; };
  }, [participants, selectedQuestion, storageEngine]);

  return (
    <Box style={{ position: 'relative' }}>
      <LoadingOverlay visible={loadingParticipants || loadingClips} />
      <Stack gap="md">
        <Group justify="space-between" align="flex-end">
          <Box>
            <Title order={4}>Question mic audio (all participants)</Title>
            <Text size="sm" c="dimmed">
              Select a trial key to load all mic-user-study clips across participants, then summarize each recorded response with its matching study question.
            </Text>
            {!isFirebase && (
              <Text size="sm" c="red">
                This page currently requires Firebase storage.
              </Text>
            )}
            {summaryUnavailableReason && (
              <Text size="sm" c="orange">
                {summaryUnavailableReason}
              </Text>
            )}
          </Box>

          <Select
            label="Question"
            placeholder={loadingParticipants ? 'Loading…' : 'Select question'}
            searchable
            w={360}
            value={selectedQuestion || null}
            onChange={(v) => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                if (v) next.set('question', v);
                else next.delete('question');
                return next;
              });
            }}
            data={questionOptions.map((q) => ({ value: q, label: q }))}
          />
        </Group>

        {selectedQuestion && (
          <Stack gap={4}>
            <Text size="sm">
              Showing
              {' '}
              <Text span fw={600}>{groupedByClipName.length}</Text>
              {' '}
              clip groups across
              {' '}
              <Text span fw={600}>{clipsByParticipant.length}</Text>
              {' '}
              participants for
              {' '}
              <Text span fw={600} ff="monospace">{selectedQuestion}</Text>
              .
            </Text>
            {selectedTrialContext?.componentId && (
              <Text size="sm" c="dimmed">
                Component:
                {' '}
                <Text span ff="monospace">{selectedTrialContext.componentId}</Text>
                {selectedTrialContext.componentPrompt ? ` • ${selectedTrialContext.componentPrompt}` : ''}
              </Text>
            )}
          </Stack>
        )}

        <Stack gap="lg">
          {groupedByClipName.map((group) => (
            <Box key={group.clipName} p="sm" style={{ background: 'var(--mantine-color-gray-0)', borderRadius: 8 }}>
              <Group justify="space-between" wrap="nowrap">
                <Text fw={700} ff="monospace">{group.clipName}</Text>
                <Group gap="sm" wrap="nowrap">
                  <Text size="sm" c="dimmed">
                    {group.entries.length}
                    {' '}
                    participant
                    {group.entries.length === 1 ? '' : 's'}
                  </Text>
                  <Button
                    size="xs"
                    variant="light"
                    loading={summaryStatusByClip[group.clipName]?.loading}
                    disabled={Boolean(summaryUnavailableReason)}
                    onClick={() => summarizeGroup(group)}
                  >
                    Summarize responses
                  </Button>
                </Group>
              </Group>

              {group.clipContext?.questionPrompt && (
                <Stack gap={2} mt={4}>
                  <Text size="sm">
                    {group.clipContext.questionPrompt}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Answer type:
                    {' '}
                    <Text span ff="monospace">{group.clipContext.questionType}</Text>
                  </Text>
                </Stack>
              )}

              <Stack gap="xs" mt="xs">
                {group.entries.map((entry) => (
                  <Group key={`${group.clipName}-${entry.participantId}`} justify="space-between" wrap="nowrap" align="flex-start">
                    <Box style={{ width: 420, overflow: 'hidden' }}>
                      <Text size="sm" ff="monospace" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {entry.participantId}
                      </Text>
                      <Text size="xs" c="dimmed" mt={2}>
                        Answer:
                        {' '}
                        {entry.selectedChoice ?? 'No recorded answer'}
                      </Text>
                    </Box>
                    <audio controls src={entry.url} style={{ width: 360 }} />
                  </Group>
                ))}
              </Stack>

              {summaryStatusByClip[group.clipName]?.error && (
                <Text size="sm" c="red" mt="xs">
                  {summaryStatusByClip[group.clipName]?.error}
                </Text>
              )}

              {summaryByClip[group.clipName] && (
                <Box
                  mt="xs"
                  p="md"
                  style={{
                    background: 'var(--mantine-color-white)',
                    borderRadius: 10,
                    border: '1px solid var(--mantine-color-gray-3)',
                    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06)',
                  }}
                >
                  <Text size="sm" fw={600}>Summary</Text>
                  <Box mt="xs">
                    <Accordion multiple defaultValue={['overall-summary', 'participant-summaries']} variant="separated">
                      <Accordion.Item value="overall-summary">
                        <Accordion.Control>
                          <Text fw={600}>Overall Summary</Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <ReactMarkdownWrapper
                            text={parsedSummaryByClip[group.clipName]?.overall || summaryByClip[group.clipName]}
                          />
                        </Accordion.Panel>
                      </Accordion.Item>

                      <Accordion.Item value="participant-summaries">
                        <Accordion.Control>
                          <Text fw={600}>
                            Per Participant Summary
                            {' '}
                            {parsedSummaryByClip[group.clipName]?.participants.length
                              ? `(${parsedSummaryByClip[group.clipName].participants.length})`
                              : ''}
                          </Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                          {parsedSummaryByClip[group.clipName]?.participants.length ? (
                            <Accordion multiple variant="contained">
                              {parsedSummaryByClip[group.clipName].participants.map((participantSummary) => (
                                <Accordion.Item
                                  key={`${group.clipName}-${participantSummary.id}`}
                                  value={participantSummary.id}
                                >
                                  <Accordion.Control>
                                    <Text fw={500}>{participantSummary.title}</Text>
                                  </Accordion.Control>
                                  <Accordion.Panel>
                                    <ReactMarkdownWrapper text={participantSummary.content} />
                                  </Accordion.Panel>
                                </Accordion.Item>
                              ))}
                            </Accordion>
                          ) : (
                            <Text size="sm" c="dimmed">No per-participant sections found.</Text>
                          )}
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  </Box>
                </Box>
              )}
            </Box>
          ))}

          {selectedQuestion && !loadingClips && clipsByParticipant.length === 0 && (
            <Text size="sm" c="dimmed">No mic clips found for that question.</Text>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
