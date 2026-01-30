import {
  Box, Button, Flex, Text,
} from '@mantine/core';

import React, {
  useEffect, useMemo, useState, useCallback, useRef,
} from 'react';
import { useNavigate } from 'react-router';
import { Registry, initializeTrrack } from '@trrack/core';
import { PREFIX } from '../../utils/Prefix';

import {
  IndividualComponent,
  ResponseBlockLocation,
  Response,
} from '../../parser/types';
import { useCurrentIdentifier, useCurrentStep } from '../../routes/utils';
import {
  useStoreDispatch, useStoreSelector, useStoreActions,
} from '../../store/store';

import { NextButton } from '../NextButton';
import { generateInitFields, useAnswerField } from './utils';
import { ResponseSwitcher } from './ResponseSwitcher';
import { FeedbackAlert } from './FeedbackAlert';
import { FormElementProvenance, StoredAnswer, ValidationStatus } from '../../store/types';
import { useStorageEngine } from '../../storage/storageEngineHooks';
import { useStudyConfig } from '../../store/hooks/useStudyConfig';
import { useStoredAnswer } from '../../store/hooks/useStoredAnswer';
import { responseAnswerIsCorrect } from '../../utils/correctAnswer';
import { RecordingAudioWaveform } from '../interface/RecordingAudioWaveform';

// Styles for recording animation
const recordingStyles = `
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.05); opacity: 0.8; }
}

.recording-active {
  animation: pulse 1.5s ease-in-out infinite;
  box-shadow: 0 0 0 4px rgba(250, 82, 82, 0.3);
  border-radius: 50%;
}

.responseBlock .mantine-Slider-root {
  padding: 0 8px;
}
`;

type Props = {
  status?: StoredAnswer;
  config: IndividualComponent;
  location: ResponseBlockLocation;
  style?: React.CSSProperties;
};

function findMatchingStrings(arr1: string[], arr2: string[]): string[] {
  const matches: string[] = [];
  for (const str1 of arr1) {
    if (arr2.includes(str1)) {
      matches.push(str1);
    }
  }
  return matches;
}

// Helper function to format recording duration
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function ResponseBlock({
  config,
  location,
  status,
  style,
}: Props) {
  const { storageEngine } = useStorageEngine();
  const storeDispatch = useStoreDispatch();
  const {
    updateResponseBlockValidation, saveIncorrectAnswer,
  } = useStoreActions();

  const currentStep = useCurrentStep();
  const currentProvenance = useStoreSelector((state) => state.analysisProvState[location]) as FormElementProvenance | undefined;

  const storedAnswer = useMemo(() => currentProvenance?.form || status?.answer, [currentProvenance, status]);
  const storedAnswerData = useStoredAnswer();
  const formOrders: Record<string, string[]> = useMemo(() => storedAnswerData?.formOrder || {}, [storedAnswerData]);

  const audioStream = useRef<MediaRecorder | null>(null);
  const recordingIntervalRef = useRef<Record<string, NodeJS.Timeout | null>>({});

  const navigate = useNavigate();

  const allResponses = useMemo(() => (formOrders?.response
    ? formOrders.response
      .map((id) => config?.response?.find((r) => r.id === id))
      .filter((r): r is Response => r !== undefined)
    : []
  ), [config?.response, formOrders]);

  const responses = useMemo(() => allResponses.filter((r) => (r.location ? r.location === location : location === 'belowStimulus')), [allResponses, location]);

  const responsesWithDefaults = useMemo(() => responses.map((response) => {
    if (response.type !== 'textOnly') {
      return {
        ...response,
        required: response.required === undefined ? true : response.required,
      };
    }
    return response;
  }), [responses]);

  const allResponsesWithDefaults = useMemo(() => allResponses.map((response) => {
    if (response.type !== 'textOnly') {
      return {
        ...response,
        required: response.required === undefined ? true : response.required,
      };
    }
    return response;
  }), [allResponses]);

  // Set up trrack to store provenance graph of the answerValidator status
  const { actions, trrack } = useMemo(() => {
    const reg = Registry.create();

    const updateFormAction = reg.register('update', (state, payload: StoredAnswer['answer']) => {
      state.form = payload;
      return state;
    });

    const trrackInst = initializeTrrack({
      registry: reg,
      initialState: {
        form: null,
      },
    });

    return {
      actions: {
        updateFormAction,
      },
      trrack: trrackInst,
    };
  }, []);

  const reactiveAnswers = useStoreSelector((state) => state.reactiveAnswers);

  const matrixAnswers = useStoreSelector((state) => state.matrixAnswers);
  const rankingAnswers = useStoreSelector((state) => state.rankingAnswers);

  const trialValidation = useStoreSelector((state) => state.trialValidation);

  const studyConfig = useStudyConfig();

  const provideFeedback = useMemo(() => config?.provideFeedback ?? studyConfig.uiConfig.provideFeedback, [config, studyConfig]);
  const hasCorrectAnswerFeedback = provideFeedback && ((config?.correctAnswer?.length || 0) > 0);
  const allowFailedTraining = useMemo(() => config?.allowFailedTraining ?? studyConfig.uiConfig.allowFailedTraining ?? true, [config, studyConfig]);
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const trainingAttempts = useMemo(() => config?.trainingAttempts ?? studyConfig.uiConfig.trainingAttempts ?? 2, [config, studyConfig]);
  const [enableNextButton, setEnableNextButton] = useState(false);
  const [hasCorrectAnswer, setHasCorrectAnswer] = useState(false);
  const usedAllAttempts = attemptsUsed >= trainingAttempts && trainingAttempts >= 0;
  const disabledAttempts = usedAllAttempts || hasCorrectAnswer;
  const showBtnsInLocation = useMemo(() => location === (config?.nextButtonLocation ?? studyConfig.uiConfig.nextButtonLocation ?? 'belowStimulus'), [config, studyConfig, location]);
  const identifier = useCurrentIdentifier();

  const [recordingStates, setRecordingStates] = useState<Record<string, boolean>>({});
  const [recordingDurations, setRecordingDurations] = useState<Record<string, number>>({});

  const [audioUrls, setAudioUrls] = useState<Record<string, string | null>>({});

  const [isRecording, setIsRecording] = useState(
    () => !!studyConfig.uiConfig.recordAudio,
  );

  const answerValidator = useAnswerField(responsesWithDefaults, currentStep, storedAnswer || {});
  useEffect(() => {
    if (storedAnswer) {
      answerValidator.setInitialValues(generateInitFields(responses, storedAnswer));
      answerValidator.reset();
      updateResponseBlockValidation({
        location,
        identifier,
        status: answerValidator.isValid(),
        values: structuredClone(answerValidator.values),
        provenanceGraph: trrack.graph.backend,
      });
    }
    // Disable exhaustive-deps because we only want this to run when there is a new storedAnswer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responses, storedAnswer]);
  useEffect(() => {
    const ReactiveResponse = responsesWithDefaults.find((r) => r.type === 'reactive');
    if (reactiveAnswers && ReactiveResponse) {
      const answerId = ReactiveResponse.id;
      answerValidator.setValues({ ...answerValidator.values, [answerId]: reactiveAnswers[answerId] as string[] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactiveAnswers]);

  useEffect(() => {
    // Checks if there are any matrix or ranking responses.
    const matrixResponse = responsesWithDefaults.filter((r) => r.type === 'matrix-radio' || r.type === 'matrix-checkbox');
    // Create blank object with current values
    const rankingResponse = responsesWithDefaults.filter((r) => r.type === 'ranking-sublist' || r.type === 'ranking-categorical' || r.type === 'ranking-pairwise');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updatedValues: Record<string, any> = { ...answerValidator.values };
    // Adjust object to have new matrix response values
    matrixResponse.forEach((r) => {
      const { id } = r;
      updatedValues[id] = {
        ...answerValidator.getInputProps(id).value,
        ...matrixAnswers[id],
      };
    });

    rankingResponse.forEach((r) => {
      const { id } = r;
      updatedValues[id] = {
        ...answerValidator.getInputProps(id).value,
        ...rankingAnswers[id],
      };
    });

    // update answerValidator
    answerValidator.setValues(updatedValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrixAnswers, rankingAnswers]);

  useEffect(() => {
    trrack.apply('update', actions.updateFormAction(structuredClone(answerValidator.values)));

    storeDispatch(
      updateResponseBlockValidation({
        location,
        identifier,
        status: answerValidator.isValid(),
        values: structuredClone(answerValidator.values),
        provenanceGraph: trrack.graph.backend,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerValidator.values, identifier, location, storeDispatch, updateResponseBlockValidation]);
  const [alertConfig, setAlertConfig] = useState(Object.fromEntries(allResponsesWithDefaults.map((response) => ([response.id, {
    visible: false,
    title: 'Correct Answer',
    message: 'The correct answer is: ',
    color: 'green',
  }]))));
  const updateAlertConfig = (id: string, visible: boolean, title: string, message: string, color: string) => {
    setAlertConfig((conf) => ({
      ...conf,
      [id]: {
        visible,
        title,
        message,
        color,
      },
    }));
  };
  const checkAnswerProvideFeedback = useCallback(() => {
    const newAttemptsUsed = attemptsUsed + 1;
    setAttemptsUsed(newAttemptsUsed);

    const trialValidationCopy = structuredClone(trialValidation[identifier]);
    const allAnswers = (trialValidationCopy ? Object.values(trialValidationCopy).reduce((acc, curr) => {
      if (Object.hasOwn(curr, 'values')) {
        return { ...acc, ...(curr as ValidationStatus).values };
      }
      return acc;
    }, {}) : {}) as StoredAnswer['answer'];

    const correctAnswers = Object.fromEntries(allResponsesWithDefaults.map((response) => {
      const configCorrectAnswer = config?.correctAnswer?.find((answer) => answer.id === response.id)?.answer;
      const suppliedAnswer = allAnswers[response.id];

      return [response.id, responseAnswerIsCorrect(suppliedAnswer, configCorrectAnswer)];
    }));

    if (hasCorrectAnswerFeedback) {
      allResponsesWithDefaults.forEach((response) => {
        if (correctAnswers[response.id] && !alertConfig[response.id]?.message.includes('You\'ve failed to answer this question correctly')) {
          updateAlertConfig(response.id, true, 'Correct Answer', 'You have answered the question correctly.', 'green');
        } else {
          storeDispatch(saveIncorrectAnswer({ question: identifier, identifier: response.id, answer: allAnswers[response.id] }));
          let message = '';
          if (trainingAttempts === -1) {
            message = 'Please try again.';
          } else if (newAttemptsUsed >= trainingAttempts) {
            message = `You didn't answer this question correctly after ${trainingAttempts} attempts. ${allowFailedTraining ? 'You can continue to the next question.' : 'Unfortunately you have not met the criteria for continuing this study.'}`;

            // If the user has failed the training, wait 5 seconds and redirect to a fail page
            if (!allowFailedTraining && storageEngine) {
              storageEngine.rejectCurrentParticipant('Failed training')
                .then(() => {
                  setTimeout(() => {
                    navigate('./../__trainingFailed');
                  }, 5000);
                })
                .catch(() => {
                  console.error('Failed to reject participant who failed training');
                  setTimeout(() => {
                    navigate('./../__trainingFailed');
                  }, 5000);
                });
            }
          } else if (trainingAttempts - newAttemptsUsed === 1) {
            message = 'Please try again. You have 1 attempt left.';
          } else {
            message = `Please try again. You have ${trainingAttempts - newAttemptsUsed} attempts left.`;
          }
          if (response.type === 'checkbox') {
            const correct = config?.correctAnswer?.find((answer) => answer.id === response.id)?.answer;

            const suppliedAnswer = allAnswers[response.id] as string[];
            const matches = findMatchingStrings(suppliedAnswer, correct);

            const tooManySelected = correct.length === matches.length && suppliedAnswer.length > correct.length ? 'However, you have selected too many boxes. ' : '';

            message = `You have successfully checked ${matches.length}/${correct.length} correct boxes. ${tooManySelected}${message}`;
          }
          updateAlertConfig(response.id, true, 'Incorrect Answer', message, 'red');
        }
      });

      setHasCorrectAnswer(Object.values(correctAnswers).every((isCorrect) => isCorrect));
      setEnableNextButton(
        (
          allowFailedTraining && newAttemptsUsed >= trainingAttempts
        ) || (
          Object.values(correctAnswers).every((isCorrect) => isCorrect)
          && newAttemptsUsed <= trainingAttempts
        ),
      );
    }
  }, [attemptsUsed, allResponsesWithDefaults, config, hasCorrectAnswerFeedback, trainingAttempts, allowFailedTraining, storageEngine, navigate, identifier, storeDispatch, alertConfig, saveIncorrectAnswer, trialValidation]);

  const nextOnEnter = config?.nextOnEnter ?? studyConfig.uiConfig.nextOnEnter;

  useEffect(() => {
    if (nextOnEnter) {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          checkAnswerProvideFeedback();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }
    return () => {};
  }, [checkAnswerProvideFeedback, nextOnEnter]);

  useEffect(() => {
    setRecordingStates((prev) => {
      const next: Record<string, boolean> = { ...prev };

      allResponsesWithDefaults.forEach((response) => {
        if (response.withMicrophone) {
          next[response.id] = isRecording;
        }
      });

      return next;
    });
  }, [isRecording, allResponsesWithDefaults]);

  useEffect(() => {
    setIsRecording(!!studyConfig.uiConfig.recordAudio);
  }, [studyConfig.uiConfig.recordAudio, studyConfig]);

  const participantId = useStoreSelector((state) => state.participantId);

  const toggleRecording = useCallback(async (responseId: string): Promise<void> => {
    // If already recording for this response -> stop
    if (recordingStates[responseId] && audioStream.current) {
      // Clear the duration interval
      if (recordingIntervalRef.current[responseId]) {
        clearInterval(recordingIntervalRef.current[responseId]!);
        recordingIntervalRef.current[responseId] = null;
      }

      try {
        audioStream.current.stop();
      } catch {
        //
      }

      // stop tracks if present
      try {
        const { stream } = audioStream.current;
        if (stream) {
          stream.getAudioTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
        }
      } catch {
        //
      }

      setRecordingStates((prevStates) => ({ ...prevStates, [responseId]: false }));
      return;
    }

    // Start new recording
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      const mediaRecorder = new MediaRecorder(micStream);
      audioStream.current = mediaRecorder;

      let chunks: Blob[] = [];
      mediaRecorder.addEventListener('dataavailable', (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      });

      mediaRecorder.addEventListener('start', () => {
        chunks = [];
        setRecordingStates((prevStates) => ({ ...prevStates, [responseId]: true }));
        setRecordingDurations((prev) => ({ ...prev, [responseId]: 0 }));

        // Start duration counter
        recordingIntervalRef.current[responseId] = setInterval(() => {
          setRecordingDurations((prev) => ({
            ...prev,
            [responseId]: (prev[responseId] || 0) + 1,
          }));
        }, 1000);
      });

      mediaRecorder.addEventListener('stop', async () => {
        // Clear the duration interval
        if (recordingIntervalRef.current[responseId]) {
          clearInterval(recordingIntervalRef.current[responseId]!);
          recordingIntervalRef.current[responseId] = null;
        }

        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const taskName = `${identifier}_${responseId}`;

        try {
          const currentPid = await storageEngine?.getCurrentParticipantId(participantId) || participantId;

          await storageEngine?.saveAudioRecording(blob, taskName);

          const urlFromStorage = await storageEngine?.getAudioUrl(taskName, currentPid as string);
          const finalUrl = urlFromStorage || URL.createObjectURL(blob);
          setAudioUrls((prev) => ({ ...prev, [responseId]: finalUrl }));
        } catch (error) {
          // fall back to a local URL so user can play immediately
          console.error('Failed saving or retrieving audio from storage engine', error);
          const url = URL.createObjectURL(blob);
          setAudioUrls((prev) => ({ ...prev, [responseId]: url }));
        }

        try {
          micStream.getAudioTracks().forEach((t) => { t.stop(); micStream.removeTrack(t); });
        } catch {
          //
        }

        audioStream.current = null;
        setRecordingStates((prevStates) => ({ ...prevStates, [responseId]: false }));
      });

      mediaRecorder.start(1000);
    } catch (error) {
      console.error('Could not start audio recording', error);
      setRecordingStates((prevStates) => ({ ...prevStates, [responseId]: false }));
    }
  }, [identifier, recordingStates, storageEngine, participantId]);

  // Cleanup intervals on unmount
  useEffect(() => () => {
    Object.values(recordingIntervalRef.current).forEach((interval) => {
      if (interval) clearInterval(interval);
    });
  }, []);

  const nextButtonText = useMemo(() => config?.nextButtonText ?? studyConfig.uiConfig.nextButtonText ?? 'Next', [config, studyConfig]);

  let index = 0;
  return (
    <>
      {/* Inject styles for recording animation and slider fix */}
      <style>{recordingStyles}</style>

      <Box className={`responseBlock responseBlock-${location}`} style={style}>
        {allResponsesWithDefaults.map((response) => {
          const configCorrectAnswer = config.correctAnswer?.find((answer) => answer.id === response.id)?.answer;
          const correctAnswer = Array.isArray(configCorrectAnswer) && configCorrectAnswer.length > 0 ? JSON.stringify(configCorrectAnswer) : configCorrectAnswer;
          // Check if this response is in the current location
          const isInCurrentLocation = responses.some((r) => r.id === response.id);

          if (isInCurrentLocation) {
            // Increment index for each response, unless it is a textOnly response
            if (response.type !== 'textOnly') {
              index += 1;
            } else if (response.restartEnumeration) {
              index = 0;
            }
          }

          return (
            <React.Fragment key={`${response.id}-${currentStep}`}>
              {isInCurrentLocation ? (
                response.hidden ? '' : (
                  <>
                    <ResponseSwitcher
                      storedAnswer={storedAnswer}
                      form={{
                        ...answerValidator.getInputProps(response.id, {
                          type: response.type === 'checkbox' ? 'checkbox' : 'input',
                        }),
                      }}
                      dontKnowCheckbox={{
                        ...answerValidator.getInputProps(`${response.id}-dontKnow`, { type: 'checkbox' }),
                      }}
                      otherInput={{
                        ...answerValidator.getInputProps(`${response.id}-other`),
                      }}
                      response={response}
                      index={index}
                      config={config}
                      disabled={disabledAttempts}
                    />

                    {/* Microphone recording UI - positioned AFTER the question/input */}
                    {response.withMicrophone && (
                      <Box
                        style={{
                          marginTop: 12,
                          marginBottom: 16,
                          width: '100%',
                          overflow: 'visible',
                        }}
                      >
                        <Flex align="center" gap="sm" wrap="wrap">
                          {/* Mic button with recording animation */}
                          <img
                            src={
                              recordingStates[response.id]
                                ? `${PREFIX}mic_images/stop_icon.png`
                                : `${PREFIX}mic_images/mic_icon.png`
                            }
                            alt={recordingStates[response.id] ? 'Stop recording' : 'Start recording'}
                            className={recordingStates[response.id] ? 'recording-active' : ''}
                            style={{
                              width: 45,
                              height: 45,
                              cursor: 'pointer',
                              display: 'block',
                              flexShrink: 0,
                            }}
                            onClick={() => toggleRecording(response.id)}
                          />

                          {/* Live waveform visualization when recording */}
                          {recordingStates[response.id] && (
                            <RecordingAudioWaveform
                              width={100}
                              height={40}
                              barColor="#FA5252"
                              barWidth={2}
                            />
                          )}

                          {/* Recording duration timer */}
                          {recordingStates[response.id] && (
                            <Text
                              size="sm"
                              c="red"
                              fw={500}
                              style={{ minWidth: 40, fontVariantNumeric: 'tabular-nums' }}
                            >
                              {formatDuration(recordingDurations[response.id] || 0)}
                            </Text>
                          )}
                        </Flex>

                        {/* Audio playback - constrained width for sidebar compatibility */}
                        {audioUrls[response.id] && (
                          <audio
                            controls
                            src={audioUrls[response.id] as string}
                            style={{
                              display: 'block',
                              marginTop: 10,
                              width: '100%',
                              minWidth: 150,
                              maxWidth: 300,
                            }}
                          />
                        )}
                      </Box>
                    )}

                    <FeedbackAlert
                      response={response}
                      correctAnswer={correctAnswer}
                      alertConfig={alertConfig}
                      identifier={identifier}
                      attemptsUsed={attemptsUsed}
                      trainingAttempts={trainingAttempts}
                    />
                  </>
                )
              ) : (
                <FeedbackAlert
                  response={response}
                  correctAnswer={correctAnswer}
                  alertConfig={alertConfig}
                  identifier={identifier}
                  attemptsUsed={attemptsUsed}
                  trainingAttempts={trainingAttempts}
                />
              )}
            </React.Fragment>
          );
        })}
      </Box>

      {showBtnsInLocation && (
      <NextButton
        disabled={(hasCorrectAnswerFeedback && !enableNextButton) || !answerValidator.isValid()}
        label={nextButtonText}
        config={config}
        location={location}
        checkAnswer={showBtnsInLocation && hasCorrectAnswerFeedback ? (
          <Button
            disabled={hasCorrectAnswer || (attemptsUsed >= trainingAttempts && trainingAttempts >= 0)}
            onClick={() => checkAnswerProvideFeedback()}
            px={location === 'sidebar' ? 8 : undefined}
          >
            Check Answer
          </Button>
        ) : null}
      />
      )}
    </>
  );
}
