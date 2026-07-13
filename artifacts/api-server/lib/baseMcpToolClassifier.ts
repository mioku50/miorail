import * as baseMcpClassifier from '@mioagent/mcp';

type ClassifierRuntime = {
  classifyBaseMcpTools?: typeof baseMcpClassifier.classifyBaseMcpTools;
  emptyBaseMcpToolCapabilityCounts?: typeof baseMcpClassifier.emptyBaseMcpToolCapabilityCounts;
};

const classifierModule = baseMcpClassifier as unknown as ClassifierRuntime & { default?: ClassifierRuntime };
const classifierApi = (
  classifierModule.classifyBaseMcpTools
    ? classifierModule
    : classifierModule.default
);

if (!classifierApi?.classifyBaseMcpTools || !classifierApi.emptyBaseMcpToolCapabilityCounts) {
  throw new Error('Base MCP tool classifier is unavailable');
}

export const classifyBaseMcpTools = classifierApi.classifyBaseMcpTools;
export const emptyBaseMcpToolCapabilityCounts = classifierApi.emptyBaseMcpToolCapabilityCounts;

export type {
  BaseMcpToolCapability,
  BaseMcpToolCapabilityCounts,
  BaseMcpToolClassificationResult,
  BaseMcpToolForClassification,
  BaseMcpToolScope,
  ClassifiedBaseMcpTool,
} from '@mioagent/mcp';
