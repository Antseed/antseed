export {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  errorEventStreamAsJson,
  extractRequestBodyFields,
  inferProviderDefaultServiceApiProtocols,
  isNativeVideoProtocol,
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
  ServiceApiProtocol,
  StreamingResponseAdapter,
  TargetProtocolSelection,
} from '@antseed/api-adapter'
