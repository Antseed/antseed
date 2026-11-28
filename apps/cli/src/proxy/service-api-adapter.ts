export {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  errorEventStreamAsJson,
  extractRequestBodyFields,
  inferProviderDefaultServiceApiProtocols,
  isNativeVideoProtocol,
  isReasoningUsageProtocol,
  reportedReasoningTokens,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
  withoutAdapterReasoningItems,
} from '@antseed/api-adapter'

export type {
  ServiceApiRequestTransformOptions,
  ServiceApiRequestTransformResult,
  ServiceApiResponseTransformOptions,
  ServiceApiStreamTransformOptions,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
  ReasoningUsageProtocol,
  ServiceApiProtocol,
  StreamingResponseAdapter,
  TargetProtocolSelection,
} from '@antseed/api-adapter'
