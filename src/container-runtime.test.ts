import { resolveDockerRuntime, getRuntimeCapabilities, runtimeNeedsStaticDns, runtimeUsesComposeAgent } from './container-runtime';

describe('container-runtime', () => {
  describe('resolveDockerRuntime', () => {
    it('translates gvisor to runsc', () => {
      expect(resolveDockerRuntime('gvisor')).toBe('runsc');
    });

    it('returns undefined for sbx (no OCI runtime)', () => {
      expect(resolveDockerRuntime('sbx')).toBeUndefined();
    });

    it('passes through unknown runtime names unchanged', () => {
      expect(resolveDockerRuntime('kata')).toBe('kata');
      expect(resolveDockerRuntime('runsc')).toBe('runsc');
      expect(resolveDockerRuntime('custom-runtime')).toBe('custom-runtime');
    });
  });

  describe('getRuntimeCapabilities', () => {
    it('returns capabilities for gvisor', () => {
      const caps = getRuntimeCapabilities('gvisor');
      expect(caps).toBeDefined();
      expect(caps!.dockerRuntime).toBe('runsc');
      expect(caps!.needsStaticDns).toBe(true);
      expect(caps!.executionModel).toBe('compose');
    });

    it('returns capabilities for sbx', () => {
      const caps = getRuntimeCapabilities('sbx');
      expect(caps).toBeDefined();
      expect(caps!.dockerRuntime).toBeUndefined();
      expect(caps!.needsStaticDns).toBe(false);
      expect(caps!.executionModel).toBe('microvm');
    });

    it('returns undefined for unknown runtimes', () => {
      expect(getRuntimeCapabilities('kata')).toBeUndefined();
      expect(getRuntimeCapabilities('runsc')).toBeUndefined();
    });
  });

  describe('runtimeNeedsStaticDns', () => {
    it('returns true for gvisor', () => {
      expect(runtimeNeedsStaticDns('gvisor')).toBe(true);
    });

    it('returns false for sbx', () => {
      expect(runtimeNeedsStaticDns('sbx')).toBe(false);
    });

    it('returns false for unknown runtimes', () => {
      expect(runtimeNeedsStaticDns('kata')).toBe(false);
      expect(runtimeNeedsStaticDns('runsc')).toBe(false);
    });

    it('returns false for undefined/empty', () => {
      expect(runtimeNeedsStaticDns(undefined)).toBe(false);
      expect(runtimeNeedsStaticDns('')).toBe(false);
    });
  });

  describe('runtimeUsesComposeAgent', () => {
    it('returns true when no runtime is configured', () => {
      expect(runtimeUsesComposeAgent(undefined)).toBe(true);
    });

    it('returns true for compose-model runtimes (gvisor)', () => {
      expect(runtimeUsesComposeAgent('gvisor')).toBe(true);
    });

    it('returns false for microvm-model runtimes (sbx)', () => {
      expect(runtimeUsesComposeAgent('sbx')).toBe(false);
    });

    it('returns true for unknown runtimes (assumed compose)', () => {
      expect(runtimeUsesComposeAgent('kata')).toBe(true);
      expect(runtimeUsesComposeAgent('runsc')).toBe(true);
    });
  });
});
