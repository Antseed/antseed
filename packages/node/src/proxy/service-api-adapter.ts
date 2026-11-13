// Re-export everything from @antseed/api-adapter for backward compatibility.
// The adapter source now lives in packages/api-adapter.
export {
  createStreamingAdapter,
  dataServiceRoute,
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  renderRequestBodyAsOpenAIChat,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
  type DataServiceRoute,
  type TargetProtocolSelection,
  type ServiceApiRequestTransformOptions,
  type ServiceApiRequestTransformResult,
  type ServiceApiResponseTransformOptions,
  type ServiceApiStreamTransformOptions,
  type StreamingResponseAdapter,
} from '@antseed/api-adapter';
