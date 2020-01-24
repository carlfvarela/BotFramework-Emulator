//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.
//
// Microsoft Bot Framework: http://botframework.com
//
// Bot Framework Emulator Github:
// https://github.com/Microsoft/BotFramwork-Emulator
//
// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License:
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
import { join } from 'path';

import { TunnelStatus, TunnelError } from '@bfemulator/app-shared';

import './fetchProxy';
import { intervals, NgrokInstance } from './ngrok';

const mockExistsSync = jest.fn(() => true);

const headersMap: Map<string, string> = new Map();
headersMap.set('Server', 'Emulator');
const tunnelResponseGeneric = (status: number, errorBody: string, headers = headersMap) => {
  return {
    text: async () => errorBody,
    status,
    headers,
  };
};

const mockTunnelStatusResponse = jest.fn(() => tunnelResponseGeneric(200, 'success'));

const connectToNgrokInstance = async (ngrok: NgrokInstance) => {
  try {
    const result = await ngrok.connect({
      addr: 61914,
      path: 'Applications/ngrok',
      name: 'c87d3e60-266e-11e9-9528-5798e92fee89',
      proto: 'http',
    });
    return result;
  } catch (e) {
    throw e;
  }
};
const mockSpawn = {
  on: () => {},
  stdin: { on: () => void 0 },
  stdout: {
    pause: () => void 0,
    on: (type, cb) => {
      if (type === 'data') {
        cb('t=2019-02-01T14:10:08-0800 lvl=info msg="starting web service" obj=web addr=127.0.0.1:4041');
      }
    },
    removeListener: () => void 0,
  },
  stderr: { on: () => void 0, pause: () => void 0 },
  kill: () => void 0,
};

let mockOk = 0;
jest.mock('child_process', () => ({
  spawn: () => mockSpawn,
}));

jest.mock('fs', () => ({
  existsSync: () => mockExistsSync(),
  createWriteStream: () => ({
    write: jest.fn(),
    end: jest.fn(),
  }),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));
jest.mock('./utils/ensureStoragePath', () => ({ ensureStoragePath: () => '' }));
jest.mock('node-fetch', () => {
  const ngrokPublicUrl = 'https://d1a2bf16.ngrok.io';
  const mockJson = {
    name: 'e2cfb800-266f-11e9-bc59-e5847cdee2d1',
    uri: '/api/tunnels/e2cfb800-266f-11e9-bc59-e5847cdee2d1',
    proto: 'https',
  };
  Object.defineProperty(mockJson, 'public_url', {
    value: ngrokPublicUrl,
  });
  return async (input, params) => {
    switch (input) {
      case ngrokPublicUrl:
        if (params.method === 'DELETE') {
          return {
            ok: ++mockOk > 0,
            json: async () => mockJson,
            text: async () => 'oh noes!',
          };
        }
        return mockTunnelStatusResponse();
      default:
        return {
          ok: ++mockOk > 0,
          json: async () => mockJson,
          text: async () => 'oh noes!',
        };
    }
  };
});

describe('the ngrok ', () => {
  let ngrok: NgrokInstance;

  beforeEach(() => {
    ngrok = new NgrokInstance();
    mockOk = 0;
  });

  afterEach(() => {
    ngrok.kill();
    jest.useRealTimers();
  });

  describe('ngrok connect/disconnect operations', () => {
    it('should spawn ngrok successfully when the happy path is followed', async () => {
      const result = await connectToNgrokInstance(ngrok);
      expect(result).toEqual({
        inspectUrl: 'http://127.0.0.1:4041',
        url: 'https://d1a2bf16.ngrok.io',
      });
    });

    it('should retry if the request to retrieve the ngrok url fails the first time', async () => {
      mockOk = -5;
      await connectToNgrokInstance(ngrok);
      expect(mockOk).toBe(1);
    });

    it('should disconnect', async done => {
      let disconnected = false;
      ngrok.ngrokEmitter.on('disconnect', () => {
        disconnected = true;
        expect(disconnected).toBe(true);
        done();
      });

      await connectToNgrokInstance(ngrok);
      await ngrok.disconnect();
    });

    it('should throw when the number of reties to retrieve the ngrok url are exhausted.', async () => {
      mockOk = -101;
      let threw = false;
      intervals.retry = 1;
      try {
        await connectToNgrokInstance(ngrok);
      } catch (e) {
        threw = e;
      }
      expect(threw.toString()).toBe('Error: oh noes!');
    });

    it('should throw if it failed to find an ngrok executable at the specified path.', async () => {
      mockExistsSync.mockReturnValueOnce(false);

      const path = join('Applications', 'ngrok');
      let thrown;
      try {
        await connectToNgrokInstance(ngrok);
      } catch (e) {
        thrown = e;
      }
      expect(thrown.toString()).toBe(
        `Error: Could not find ngrok executable at path: ${path}. Make sure that the correct path to ngrok is configured in the Emulator app settings. Ngrok is required to receive a token from the Bot Framework token service.`
      );
    });
  });

  describe('ngrok tunnel heath status check operations', () => {
    it('should emit ngrok error - Too many connections.', async done => {
      mockTunnelStatusResponse.mockReturnValueOnce(
        tunnelResponseGeneric(
          429,
          'The tunnel session has violated the rate-limit policy of 20 connections per minute.'
        )
      );
      ngrok.ngrokEmitter.on('onTunnelError', (error: TunnelError) => {
        expect(error.statusCode).toBe(429);
        done();
      });
      await connectToNgrokInstance(ngrok);
    });

    it('should emit ngrok error - Tunnel Expired.', async done => {
      mockTunnelStatusResponse.mockReturnValueOnce(tunnelResponseGeneric(402, 'Tunnel has expired beyond the 8 hrs.'));
      ngrok.ngrokEmitter.on('onTunnelError', (error: TunnelError) => {
        expect(error.statusCode).toBe(402);
        done();
      });
      await connectToNgrokInstance(ngrok);
    });

    it('should emit ngrok error - No server header present in the response headers.', async done => {
      mockTunnelStatusResponse.mockReturnValueOnce(tunnelResponseGeneric(404, 'Tunnel not found.', new Map()));
      ngrok.ngrokEmitter.on('onTunnelError', (error: TunnelError) => {
        expect(error.statusCode).toBe(404);
        done();
      });
      await connectToNgrokInstance(ngrok);
    });

    it('should emit ngrok error - Tunnel has errored out.', async done => {
      mockTunnelStatusResponse.mockReturnValueOnce(tunnelResponseGeneric(500, 'Tunnel has errored out.'));
      ngrok.ngrokEmitter.on('onTunnelError', (error: TunnelError) => {
        expect(error.statusCode).toBe(500);
        done();
      });
      await connectToNgrokInstance(ngrok);
    });

    it('should emit ngrok error - Too many connections.', async done => {
      mockTunnelStatusResponse.mockReturnValueOnce(
        tunnelResponseGeneric(
          429,
          'The tunnel session has violated the rate-limit policy of 20 connections per minute.'
        )
      );
      ngrok.ngrokEmitter.on('onTunnelError', (error: TunnelError) => {
        expect(error.statusCode).toBe(429);
        done();
      });
      await connectToNgrokInstance(ngrok);
    });

    it('should check tunnel status every minute and report error', async done => {
      jest.useFakeTimers();
      ngrok.ngrokEmitter.on('onTunnelError', (error: TunnelError) => {
        expect(error.statusCode).toBe(429);
        done();
      });
      await connectToNgrokInstance(ngrok);
      mockTunnelStatusResponse.mockReturnValueOnce(
        tunnelResponseGeneric(
          429,
          'The tunnel session has violated the rate-limit policy of 20 connections per minute.'
        )
      );
      jest.advanceTimersByTime(60001);
    });

    it('should emit onTunnelStatusPing with an error status', async done => {
      jest.useFakeTimers();
      await connectToNgrokInstance(ngrok);
      mockTunnelStatusResponse.mockReturnValueOnce(
        tunnelResponseGeneric(
          429,
          'The tunnel session has violated the rate-limit policy of 20 connections per minute.'
        )
      );
      ngrok.ngrokEmitter.on('onTunnelStatusPing', (val: TunnelStatus) => {
        expect(val).toBe(TunnelStatus.Error);
        done();
      });
      jest.advanceTimersByTime(60001);
    });

    it('should check tunnel status every minute.', async done => {
      jest.useFakeTimers();
      await connectToNgrokInstance(ngrok);
      ngrok.ngrokEmitter.on('onTunnelStatusPing', (msg: TunnelStatus) => {
        expect(msg).toEqual(TunnelStatus.Active);
        done();
      });
      jest.advanceTimersByTime(60001);
    });
  });
});
