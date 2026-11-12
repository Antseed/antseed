export { createMp4Inspector, type Mp4Facts } from './mp4.js';
export { isSpeechAudio, inlineAudioSeconds } from './speech-audio.js';
export { detectNativeVideoProtocol, nativeVideoRoute, nativeVideoAcceptance, nativeVideoDelivered, nativeVideoFacts, videoSourceLengthProblem, audioSourceLengthProblem, VIDEO_MIN_DURATION_RATIO, sendsReferenceVideo, referenceVideoPriceProblem, nativeVideoAttributes, REFERENCE_VIDEO_FIELDS, VIDEO_CREATE_FIELDS, VIDEO_SOURCE_FIELDS, type NativeVideoPricedOptions, requestService, type NativeVideoRoute, type NativeVideoFacts } from './native-video.js';

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
  IMAGE_PRICE_ATTRIBUTES,
  IMAGE_REQUEST_FIELDS,
  MAX_MULTIPART_TEXT_FIELD_BYTES,
  SPEECH_REQUEST_FIELDS,
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
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  NATIVE_VIDEO_PROTOCOLS,
  ROUTING_PROTOCOLS,
  AUDIO_SPEECH_PROTOCOLS,
  isKnownServiceApiProtocol,
  isNativeVideoProtocol,
  isRoutingProtocol,
  isAudioSpeechProtocol,
} from './types.js';
