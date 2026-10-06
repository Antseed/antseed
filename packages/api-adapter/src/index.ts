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
  toNonNegativeInt,
  type StreamingResponseAdapter,
} from './utils.js';

export {
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
  type ServiceApiProtocol,
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  isKnownServiceApiProtocol,
} from './types.js';
