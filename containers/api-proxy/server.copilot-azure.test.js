/**
 * Tests for Copilot Azure OpenAI BYOK routing.
 *
 * Covers: isAzureOpenAITarget detection and api-key header injection.
 */

const {
  createCopilotAdapter,
  _testing: {
    isAzureOpenAITarget,
  },
} = require('./providers/copilot');

describe('isAzureOpenAITarget', () => {
  it('detects *.openai.azure.com', () => {
    expect(isAzureOpenAITarget('my-resource.openai.azure.com')).toBe(true);
  });

  it('detects *.cognitiveservices.azure.com', () => {
    expect(isAzureOpenAITarget('my-resource.cognitiveservices.azure.com')).toBe(true);
  });

  it('does not match standard Copilot target', () => {
    expect(isAzureOpenAITarget('api.githubcopilot.com')).toBe(false);
  });

  it('does not match partial hostname match', () => {
    expect(isAzureOpenAITarget('evil.openai.azure.com.attacker.com')).toBe(false);
    expect(isAzureOpenAITarget('openai.azure.com')).toBe(true);
  });

  it('does not match GitHub catalog targets', () => {
    expect(isAzureOpenAITarget('models.inference.ai.azure.com')).toBe(false);
  });
});

describe('Azure OpenAI BYOK adapter', () => {
  const azureEnv = {
    COPILOT_API_KEY: 'my-azure-api-key',
    COPILOT_API_TARGET: 'https://my-resource.openai.azure.com',
    COPILOT_API_BASE_PATH: '/openai/deployments/gpt-4o',
  };

  describe('getAuthHeaders', () => {
    it('uses api-key header for Azure targets', () => {
      const adapter = createCopilotAdapter(azureEnv);
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers).toEqual({ 'api-key': 'my-azure-api-key' });
    });

    it('does not include Copilot-Integration-Id for Azure targets', () => {
      const adapter = createCopilotAdapter(azureEnv);
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers['Copilot-Integration-Id']).toBeUndefined();
      expect(headers['Authorization']).toBeUndefined();
    });

    it('still uses Bearer auth for non-Azure targets', () => {
      const adapter = createCopilotAdapter({
        COPILOT_API_KEY: 'my-key',
        COPILOT_API_TARGET: 'https://api.githubcopilot.com',
      });
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers['Authorization']).toBe('Bearer my-key');
    });
  });

  describe('transformRequestUrl', () => {
    it('does not define a URL transform for Azure targets', () => {
      const adapter = createCopilotAdapter(azureEnv);
      expect(adapter.transformRequestUrl).toBeUndefined();
    });
  });

  describe('cognitiveservices.azure.com target', () => {
    it('also uses api-key header', () => {
      const adapter = createCopilotAdapter({
        COPILOT_API_KEY: 'cog-key',
        COPILOT_API_TARGET: 'https://my-resource.cognitiveservices.azure.com',
        COPILOT_API_BASE_PATH: '/openai/deployments/gpt-4o',
      });
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers).toEqual({ 'api-key': 'cog-key' });
    });
  });
});
