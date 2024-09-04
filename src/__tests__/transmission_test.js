/* eslint-env node, jest */
import "babel-polyfill";

import { Transmission, ValidatedEvent } from "../transmission";

import http from "http";
import net from "net";

describe("base transmission", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // This checks that the code connects to a proxy
  // NOTE: this fork doesn't support `proxy` option as we don't need it
  it.skip("will hit a proxy", done => {
    let server = net.createServer(socket => {
      // if we get here, we got data, so the test passes -- otherwise,
      // the test will never end and will timeout, which is a failure.
      socket.destroy();
      server.close(() => {
        done();
      });
    });

    server.listen(9998, "127.0.0.1");

    let transmission = new Transmission({
      // NOTE: proxy not supported
      // proxy: "http://127.0.0.1:9998",
      batchTimeTrigger: 10000, // larger than the mocha timeout
      batchSizeTrigger: 0
    });

    transmission.sendEvent(
      new ValidatedEvent({
        apiHost: "http://localhost:9999",
        writeKey: "123456789",
        dataset: "test-transmission",
        sampleRate: 1,
        timestamp: new Date(),
        postData: { a: 1, b: 2 }
      })
    );
  });

  it("should handle batchSizeTrigger of 0", async () => {
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    const transmission = new Transmission({
      batchTimeTrigger: 10000, // larger than the mocha timeout
      batchSizeTrigger: 0,
    });

    transmission.sendEvent(
      new ValidatedEvent({
        apiHost: "http://localhost:9999",
        writeKey: "123456789",
        dataset: "test-transmission",
        sampleRate: 1,
        timestamp: new Date(),
        postData: { a: 1, b: 2 }
      })
    );

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
  });

  it("should send a batch when batchSizeTrigger is met, not exceeded", async () => {
    let responseCount = 0;
    let batchSize = 5;

    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 10000, // larger than the mocha timeout
      batchSizeTrigger: 5,
      responseCallback(queue) {
        responseCount += queue.length;
        queue.splice(0, queue.length);
      }
    });

    for (let i = 0; i < batchSize; i++) {
      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    await transmission.flush();
    expect(responseCount).toEqual(batchSize);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
  });

  it("should handle apiHosts with trailing slashes", async () => {
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 0,
    });

    transmission.sendEvent(
      new ValidatedEvent({
        apiHost: "http://localhost:9999/",
        writeKey: "123456789",
        dataset: "test-transmission",
        sampleRate: 1,
        timestamp: new Date(),
        postData: { a: 1, b: 2 }
      })
    );

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
  });

  it("should eventually send a single event (after the timeout)", async () => {
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 10,
    });

    transmission.sendEvent(
      new ValidatedEvent({
        apiHost: "http://localhost:9999",
        writeKey: "123456789",
        dataset: "test-transmission",
        sampleRate: 1,
        timestamp: new Date(),
        postData: { a: 1, b: 2 }
      })
    );

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
  });

  it("should respect sample rate and accept the event", async () => {
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 10,
    });

    transmission._randomFn = function () {
      return 0.09;
    };
    transmission.sendEvent(
      new ValidatedEvent({
        apiHost: "http://localhost:9999",
        writeKey: "123456789",
        dataset: "test-transmission",
        sampleRate: 10,
        timestamp: new Date(),
        postData: { a: 1, b: 2 }
      })
    );

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
  });

  it("should respect sample rate and drop the event", async () => {
    let transmission = new Transmission({ batchTimeTrigger: 10 });

    transmission._randomFn = function () {
      return 0.11;
    };
    transmission._droppedCallback = jest.fn();

    transmission.sendEvent(
      new ValidatedEvent({
        apiHost: "http://localhost:9999",
        writeKey: "123456789",
        dataset: "test-transmission",
        sampleRate: 10,
        timestamp: new Date(),
        postData: { a: 1, b: 2 }
      })
    );

    await transmission.flush();
    expect(transmission._droppedCallback).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should drop events beyond the pendingWorkCapacity", async () => {
    let eventDropped;
    let droppedExpected = 5;
    let responseCount = 0;
    let responseExpected = 5;

    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 50,
      pendingWorkCapacity: responseExpected,
      responseCallback(queue) {
        responseCount += queue.length;
        queue.splice(0, queue.length);
      }
    });

    transmission._droppedCallback = function () {
      eventDropped = true;
    };

    // send the events we expect responses for
    for (let i = 0; i < responseExpected; i++) {
      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    // send the events we expect to drop.  Since JS is single threaded we can
    // verify that droppedCount behaves the way we want.
    for (let i = 0; i < droppedExpected; i++) {
      eventDropped = false;
      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
      expect(eventDropped).toBe(true);
    }

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(responseCount).toEqual(responseExpected);
  });

  it("should send the right number events even if it requires multiple concurrent batches", async () => {
    let responseCount = 0;
    let responseExpected = 10;

    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 50,
      batchSizeTrigger: 5,
      pendingWorkCapacity: responseExpected,
      responseCallback(queue) {
        responseCount += queue.length;
        queue.splice(0, queue.length);
      }
    });

    for (let i = 0; i < responseExpected; i++) {
      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(1, "http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(global.fetch).toHaveBeenNthCalledWith(2, "http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(responseCount).toEqual(responseExpected);
  });

  it("should send the right number of events even if they all fail", async () => {
    let responseCount = 0;
    let responseExpected = 10;

    global.fetch.mockImplementation(() => {
      return Promise.resolve({ ok: false, status: 404 });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 50,
      batchSizeTrigger: 5,
      maxConcurrentBatches: 1,
      pendingWorkCapacity: responseExpected,
      responseCallback(queue) {
        let responses = queue.splice(0, queue.length);
        responses.forEach(({ error, status_code: statusCode }) => {
          expect(error.status).toEqual(404);
          expect(statusCode).toEqual(404);
          responseCount++;
        });
      }
    });

    for (let i = 0; i < responseExpected; i++) {
      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(1, "http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(global.fetch).toHaveBeenNthCalledWith(2, "http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(responseCount).toEqual(responseExpected);
  });

  it("should send the right number of events even it requires more batches than maxConcurrentBatch", async () => {
    let responseCount = 0;
    let responseExpected = 50;
    let batchSize = 2;
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 50,
      batchSizeTrigger: batchSize,
      pendingWorkCapacity: responseExpected,
      responseCallback(queue) {
        responseCount += queue.length;
        queue.splice(0, queue.length);
      }
    });

    for (let i = 0; i < responseExpected; i++) {
      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(25);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(responseCount).toEqual(responseExpected);
  });

  it("should send 100% of presampled events", async () => {
    let responseCount = 0;
    let responseExpected = 10;
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      responseCallback(queue) {
        let responses = queue.splice(0, queue.length);
        responses.forEach(resp => {
          if (resp.error) {
            console.log(resp.error);
            return;
          }
          responseCount++;
        });
      }
    });

    for (let i = 0; i < responseExpected; i++) {
      transmission.sendPresampledEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 10,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(responseCount).toEqual(responseExpected);
  });

  it("should deal with encoding errors", async () => {
    let responseCount = 0;
    let responseExpected = 11;
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      responseCallback(queue) {
        responseCount = queue.length;
      }
    });

    for (let i = 0; i < 5; i++) {
      transmission.sendPresampledEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 10,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }
    {
      // send an event that fails to encode
      let b = {};
      b.b = b;
      transmission.sendPresampledEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 10,
          timestamp: new Date(),
          postData: b
        })
      );
    }
    for (let i = 0; i < 5; i++) {
      transmission.sendPresampledEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 10,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(responseCount).toEqual(responseExpected);
  });

  it("should block on flush", async () => {
    let responseCount = 0;
    let responseExpected = 50;
    let batchSize = 2;
    global.fetch.mockImplementation((_url, options) => {
      const reqEvents = JSON.parse(options.body);
      return Promise.resolve({ ok: true, json: async () => reqEvents.map(() => ({ status: 202 })) });
    });

    let transmission = new Transmission({
      batchTimeTrigger: 50,
      batchSizeTrigger: batchSize,
      pendingWorkCapacity: responseExpected,
      responseCallback(queue) {
        responseCount += queue.length;
        queue.splice(0, queue.length);
      }
    });

    for (let i = 0; i < responseExpected; i++) {
      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );
    }

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(25);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/test-transmission", expect.any(Object));
    expect(responseCount).toBe(responseExpected);
  });

  it("should allow user-agent additions", async () => {
    let userAgents = [
      {
        dataset: "test-transmission1",
        addition: "",
        probe: userAgent =>
          userAgent.indexOf("libhoney") === 0 &&
          userAgent.indexOf("addition") === -1
      },
      {
        dataset: "test-transmission2",
        addition: "user-agent addition",
        probe: userAgent =>
          userAgent.indexOf("libhoney") === 0 &&
          userAgent.indexOf("addition") !== -1
      }
    ];

    let responseCount = 0;
    let responseExpected = 2;

    for (const userAgent of userAgents) {
      global.fetch.mockClear();
      global.fetch.mockImplementation((_url, options) => {
        expect(userAgent.probe(options.headers["user-agent"])).toBeTruthy();
        return Promise.resolve({});
      });

      // send our events through separate transmissions with different user
      // agent additions.
      let transmission = new Transmission({
        batchSizeTrigger: 1, // so we'll send individual events
        responseCallback(queue) {
          let responses = queue.splice(0, queue.length);
          responseCount += responses.length;
        },
        userAgentAddition: userAgent.addition
      });

      transmission.sendPresampledEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:9999",
          writeKey: "123456789",
          dataset: userAgent.dataset,
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 }
        })
      );

      await transmission.flush();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(`http://localhost:9999/1/batch/${userAgent.dataset}`, expect.any(Object));
    }

    expect(responseCount).toEqual(responseExpected);
  });

  it("should use X-Honeycomb-UserAgent in browser", async () => {
    // terrible hack to get our "are we running in node" check to return false
    process.env.LIBHONEY_TARGET = "browser";

    let transmission = new Transmission({
      batchTimeTrigger: 10000, // larger than the mocha timeout
      batchSizeTrigger: 0
    });

    global.fetch.mockImplementation((_url, options) => {
      expect(options.headers["user-agent"]).toBeUndefined();
      expect(options.headers["x-honeycomb-useragent"]).toBeDefined();
      return Promise.resolve({});
    });

    transmission.sendPresampledEvent(
      new ValidatedEvent({
        apiHost: "http://localhost:9999",
        writeKey: "123456789",
        dataset: "browser-test",
        sampleRate: 1,
        timestamp: new Date(),
        postData: { a: 1, b: 2 }
      })
    );

    await transmission.flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:9999/1/batch/browser-test", expect.any(Object));
    process.env.LIBHONEY_TARGET = "";
  });
});

describe("special-case transmission", () => {
  it("should respect options.timeout and fail sending the batch", done => {
    // This number needs to be less than the global test timeout of 5000 so that the server closes in time
    // before jest starts complaining.
    const serverTimeout = 2500; // milliseconds

    const server = http.createServer((_req, res) => {
      setTimeout(
        () => {
          // this part doesn't really matter
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("[{ status: 666 }]");
        },
        serverTimeout
      );
    });
    server.listen(6666, "localhost", () => {
      let errResult;
      let transmission = new Transmission({
        batchTimeTrigger: 10,
        timeout: serverTimeout - 500,
        responseCallback: async function (respQueue) {
          if (respQueue.length !== 1) {
            errResult = new Error(`expected response queue length = 1, got ${respQueue.length}`);
          }

          const resp = respQueue[0];

          if (!(resp.error && resp.error.timeout)) {
            errResult = new Error(`expected a timeout error, instead got ${JSON.stringify(resp.error)}`);
          }

          server.close(() => {
            done(errResult);
          });
        }
      });

      transmission.sendEvent(
        new ValidatedEvent({
          apiHost: "http://localhost:6666",
          writeKey: "123456789",
          dataset: "test-transmission",
          sampleRate: 1,
          timestamp: new Date(),
          postData: { a: 1, b: 2 },
          metadata: "my metadata"
        })
      );
    });
  });
});
