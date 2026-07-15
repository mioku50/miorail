// Compatibility export for legacy API-server imports. The constrained HTTP
// implementation lives in @mioagent/runtime-skills so isolated route adapters
// can reuse the same manifest-enforced host/method/path/chain boundary.
export {
  PluginChainNotAllowedError,
  PluginCredentialMissingError,
  PluginNotAvailableError,
  pluginHttpRequest,
  type PluginHttpRequestInput,
  type PluginHttpResponse,
} from '@mioagent/runtime-skills';
