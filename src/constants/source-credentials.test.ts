import {
  AWF_PRIMARY_SOURCE_CREDENTIALS,
  AWF_SOURCE_CREDENTIAL_ALIASES,
  AWF_SOURCE_CREDENTIAL_VARS,
  AWF_ENGINE_ENV_SECRET_VARS,
} from './source-credentials';

describe('AWF source credentials (§9.1 of the AWF config spec)', () => {
  describe('AWF_PRIMARY_SOURCE_CREDENTIALS', () => {
    it('includes all five primary source credentials defined in §9.1', () => {
      expect(AWF_PRIMARY_SOURCE_CREDENTIALS).toContain('OPENAI_API_KEY');
      expect(AWF_PRIMARY_SOURCE_CREDENTIALS).toContain('ANTHROPIC_API_KEY');
      expect(AWF_PRIMARY_SOURCE_CREDENTIALS).toContain('COPILOT_GITHUB_TOKEN');
      expect(AWF_PRIMARY_SOURCE_CREDENTIALS).toContain('COPILOT_PROVIDER_API_KEY');
      expect(AWF_PRIMARY_SOURCE_CREDENTIALS).toContain('GEMINI_API_KEY');
    });

    it('contains exactly 5 primary credentials', () => {
      expect(AWF_PRIMARY_SOURCE_CREDENTIALS.length).toBe(5);
    });
  });

  describe('AWF_SOURCE_CREDENTIAL_ALIASES', () => {
    it('includes all three secondary aliases defined in §9.1', () => {
      expect(AWF_SOURCE_CREDENTIAL_ALIASES).toContain('OPENAI_KEY');
      expect(AWF_SOURCE_CREDENTIAL_ALIASES).toContain('CODEX_API_KEY');
      expect(AWF_SOURCE_CREDENTIAL_ALIASES).toContain('CLAUDE_API_KEY');
    });

    it('contains exactly 3 aliases', () => {
      expect(AWF_SOURCE_CREDENTIAL_ALIASES.length).toBe(3);
    });
  });

  describe('AWF_SOURCE_CREDENTIAL_VARS', () => {
    it('is the union of primary credentials and aliases', () => {
      for (const v of AWF_PRIMARY_SOURCE_CREDENTIALS) {
        expect(AWF_SOURCE_CREDENTIAL_VARS).toContain(v);
      }
      for (const v of AWF_SOURCE_CREDENTIAL_ALIASES) {
        expect(AWF_SOURCE_CREDENTIAL_VARS).toContain(v);
      }
    });

    it('contains exactly 8 entries (5 primary + 3 aliases)', () => {
      expect(AWF_SOURCE_CREDENTIAL_VARS.length).toBe(8);
    });

    it('has no duplicates', () => {
      const asSet = new Set(AWF_SOURCE_CREDENTIAL_VARS);
      expect(asSet.size).toBe(AWF_SOURCE_CREDENTIAL_VARS.length);
    });
  });

  describe('AWF_ENGINE_ENV_SECRET_VARS', () => {
    it('is a superset of AWF_SOURCE_CREDENTIAL_VARS', () => {
      for (const v of AWF_SOURCE_CREDENTIAL_VARS) {
        expect(AWF_ENGINE_ENV_SECRET_VARS).toContain(v);
      }
    });

    it('includes COPILOT_PROVIDER_BASE_URL as an allowed engine.env secret', () => {
      expect(AWF_ENGINE_ENV_SECRET_VARS).toContain('COPILOT_PROVIDER_BASE_URL');
    });

    it('has no duplicates', () => {
      const asSet = new Set(AWF_ENGINE_ENV_SECRET_VARS);
      expect(asSet.size).toBe(AWF_ENGINE_ENV_SECRET_VARS.length);
    });
  });
});
