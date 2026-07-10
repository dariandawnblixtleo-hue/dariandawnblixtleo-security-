import { createSandbox, removeSandbox } from './sbx-manager';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedLogger = jest.mocked(logger);

describe('sbx-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createSandbox', () => {
    it('uses shell agent, configured mounts, and daemon proxy restart', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not running' }) // daemon status
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'started', stderr: '' }) // daemon start
        .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' }) // daemon status verify
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // sbx create

      await createSandbox({
        name: 'awf-agent-test',
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
        extraMounts: ['/tmp/gh-aw:/tmp/gh-aw:ro'],
      });

      expect(mockExecaFn).toHaveBeenCalledWith('sbx', [
        'create',
        '--name', 'awf-agent-test',
        'shell',
        '/workspace',
        '/tmp/gh-aw:/tmp/gh-aw:ro',
      ], expect.any(Object));

      expect(mockExecaFn).toHaveBeenCalledWith('sbx', ['daemon', 'start'], expect.objectContaining({
        env: expect.objectContaining({
          DOCKER_SANDBOXES_PROXY: 'http://172.30.0.10:3128',
        }),
      }));
    });
  });

  describe('removeSandbox', () => {
    it('warns when sbx rm exits non-zero', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // stop
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'still running' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove sandbox "awf-agent-test"'),
      );
    });
  });
});
