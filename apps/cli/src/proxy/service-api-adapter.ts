export {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  extractRequestBodyFields,
  inferProviderDefaultServiceApiProtocols,
  isNativeVideoProtocol,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
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
