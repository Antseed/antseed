export { createMp4Inspector, type Mp4Facts } from './mp4.js';
export { isSpeechAudio, inlineAudioSeconds } from './speech-audio.js';
export { detectNativeVideoProtocol, nativeVideoRoute, nativeVideoAcceptance, nativeVideoDelivered, nativeVideoFacts, videoSourceLengthProblem, audioSourceLengthProblem, VIDEO_MIN_DURATION_RATIO, sendsReferenceVideo, referenceVideoPriceProblem, nativeVideoAttributes, REFERENCE_VIDEO_FIELDS, type NativeVideoPricedOptions, requestService, type NativeVideoRoute, type NativeVideoFacts } from './native-video.js';

export {
  renderRequestBodyAsOpenAIChat,
  transformRequest,
  type ServiceApiRequestTransformOptions,
  type ServiceApiRequestTransformResult,
} from './request-transform.js';

export {
  transformResponse,
  type ServiceApiResponseTransformOptions,
} from './response-transform.js';

export {
  createStreamingAdapter,
  type ServiceApiStreamTransformOptions,
} from './stream-transform.js';

export {
  DEFAULT_ANTHROPIC_MAX_TOKENS,
} from './canonical.js';

export {
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  type TargetProtocolSelection,
} from './detect.js';

export {
  extractImageRequestFacts,
  extractProviderResponseFacts,
  extractUsage,
  type ImageRequestFacts,
  type ProviderResponseFacts,
  type TokenUsage,
  extractRequestBodyFields,
  parseJsonObject,
  parseMultipartFormFields,
  extractSpeechRequestFacts,
  speechAudioDelivered,
  type SpeechRequestFacts,
  toNonNegativeInt,
  type StreamingResponseAdapter,
} from './utils.js';

export {
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
  type ServiceApiProtocol,
  type NativeVideoProtocol,
  type RoutingProtocol,
  type AudioSpeechProtocol,
  type DataServiceProtocol,
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  NATIVE_VIDEO_PROTOCOLS,
  ROUTING_PROTOCOLS,
  AUDIO_SPEECH_PROTOCOLS,
  DATA_SERVICE_PROTOCOLS,
  isKnownServiceApiProtocol,
  isNativeVideoProtocol,
  isRoutingProtocol,
  isAudioSpeechProtocol,
  isDataServiceProtocol,
} from './types.js';

export {
  DATA_SERVICE_PATH_PREFIX,
  DATA_SERVICE_DOCUMENT_PATH,
  DATA_PROVIDER_RESPONSE_HEADER,
  isDataProviderResponse,
  markDataProviderResponse,
  dataServiceRoute,
  dataServiceDelivered,
  withDataService,
  type DataServiceRoute,
} from './data-service.js';
