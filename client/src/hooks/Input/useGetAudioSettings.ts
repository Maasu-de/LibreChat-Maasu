import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';

const useGetAudioSettings = () => {
  const engineSTT = useRecoilValue<string>(store.engineSTT);
  const engineTTS = useRecoilValue<string>(store.engineTTS);

  const { data: startupConfig } = useGetStartupConfig();
  const speechToTextEndpoint = startupConfig?.governancePilotEnabled ? 'disabled' : engineSTT;
  const textToSpeechEndpoint = startupConfig?.governancePilotEnabled ? 'disabled' : engineTTS;

  return useMemo(
    () => ({ speechToTextEndpoint, textToSpeechEndpoint }),
    [speechToTextEndpoint, textToSpeechEndpoint],
  );
};

export default useGetAudioSettings;
