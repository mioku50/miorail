// Compatibility export for legacy API-server imports. Route-intelligence code
// must select an explicit namespace with loadSkillExecutor(namespace), never
// infer a provider from generic quote language.
export {
  SkillPathNotAllowedError,
  loadSkillExecutor,
  loadSkillExecutorForMessage,
  type BaseMcpSkillExecutor,
} from '@mioagent/runtime-skills';
