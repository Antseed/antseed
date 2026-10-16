// Re-export everything from @antseed/api-adapter for backward compatibility.
// The adapter source now lives in packages/api-adapter.
export {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
  type TargetProtocolSelection,
  type ServiceApiRequestTransformOptions,
  type ServiceApiRequestTransformResult,
  type ServiceApiResponseTransformOptions,
  type ServiceApiStreamTransformOptions,
  type StreamingResponseAdapter,
} from '@antseed/api-adapter';
