import { EventEmitter } from 'events';

// Copyright 2016 Hound Technology, Inc. All rights reserved.
// Use of this source code is governed by the Apache License 2.0
// license that can be found in the LICENSE file.

/* global global, process */

const USER_AGENT = "libhoney-js/3.1.1";

const _global =
  typeof window !== "undefined"
    ? window
    : typeof global !== "undefined"
    ? global
    : undefined;

// how many events to collect in a batch
const batchSizeTrigger = 50; // either when the eventQueue is > this length
const batchTimeTrigger = 100; // or it's been more than this many ms since the first push

// how many batches to maintain in parallel
const maxConcurrentBatches = 10;

// how many events to queue up for busy batches before we start dropping
const pendingWorkCapacity = 10000;

// how long (in ms) to give a single POST before we timeout
const deadlineTimeoutMs = 60000;

const emptyResponseCallback = function() {};

const eachPromise = (arr, iteratorFn) =>
  arr.reduce((p, item) => {
    return p.then(() => {
      return iteratorFn(item);
    });
  }, Promise.resolve());

const partition = (arr, keyfn, createfn, addfn) => {
  let result = Object.create(null);
  arr.forEach(v => {
    let key = keyfn(v);
    if (!result[key]) {
      result[key] = createfn(v);
    } else {
      addfn(result[key], v);
    }
  });
  return result;
};

class BatchEndpointAggregator {
  constructor(events) {
    this.batches = partition(
      events,
      /* keyfn */
      ev => `${ev.apiHost}_${ev.writeKey}_${ev.dataset}`,
      /* createfn */
      ev => ({
        apiHost: ev.apiHost,
        writeKey: ev.writeKey,
        dataset: ev.dataset,
        events: [ev]
      }),
      /* addfn */
      (batch, ev) => batch.events.push(ev)
    );
  }

  encodeBatchEvents(events) {
    let first = true;
    let numEncoded = 0;
    let encodedEvents = events.reduce((acc, ev) => {
      try {
        let encodedEvent = JSON.stringify(ev);
        numEncoded++;
        let newAcc = acc + (!first ? "," : "") + encodedEvent;
        first = false;
        return newAcc;
      } catch (e) {
        ev.encodeError = e;
        return acc;
      }
    }, "");

    let encoded = "[" + encodedEvents + "]";
    return { encoded, numEncoded };
  }
}

/**
 * @private
 */
class ValidatedEvent {
  constructor({
    timestamp,
    apiHost,
    postData,
    writeKey,
    dataset,
    sampleRate,
    metadata
  }) {
    this.timestamp = timestamp;
    this.apiHost = apiHost;
    this.postData = postData;
    this.writeKey = writeKey;
    this.dataset = dataset;
    this.sampleRate = sampleRate;
    this.metadata = metadata;
  }

  toJSON() {
    let json = {};
    if (this.timestamp) {
      json.time = this.timestamp;
    }
    if (this.sampleRate) {
      json.samplerate = this.sampleRate;
    }
    if (this.postData) {
      json.data = this.postData;
    }
    return json;
  }

  /** @deprecated Used by the deprecated WriterTransmission. Use ConsoleTransmission instead. */
  toBrokenJSON() {
    let fields = [];
    if (this.timestamp) {
      fields.push(`"time":${JSON.stringify(this.timestamp)}`);
    }
    if (this.sampleRate) {
      fields.push(`"samplerate":${JSON.stringify(this.sampleRate)}`);
    }
    if (this.postData) {
      fields.push(`"data":${JSON.stringify(this.postData)}`);
    }
    return `{${fields.join(",")}}`;
  }
}

class MockTransmission {
  constructor(options) {
    this.constructorArg = options;
    this.events = [];
  }

  sendEvent(ev) {
    this.events.push(ev);
  }

  sendPresampledEvent(ev) {
    this.events.push(ev);
  }

  reset() {
    this.constructorArg = null;
    this.events = [];
  }
}

/** @deprecated Use ConsoleTransmission instead. */
class WriterTransmission {
  sendEvent(ev) {
    console.log(JSON.stringify(ev.toBrokenJSON()));
  }

  sendPresampledEvent(ev) {
    console.log(JSON.stringify(ev.toBrokenJSON()));
  }
}

class ConsoleTransmission {
  sendEvent(ev) {
    console.log(JSON.stringify(ev));
  }

  sendPresampledEvent(ev) {
    console.log(JSON.stringify(ev));
  }
}

class StdoutTransmission {
  sendEvent(ev) {
    process.stdout.write(JSON.stringify(ev) + "\n");
  }

  sendPresampledEvent(ev) {
    process.stdout.write(JSON.stringify(ev) + "\n");
  }
}

class NullTransmission {
  sendEvent(_ev) {}

  sendPresampledEvent(_ev) {}
}

/**
 * @private
 */
class Transmission {
  constructor(options) {
    this._responseCallback = emptyResponseCallback;
    this._batchSizeTrigger = batchSizeTrigger;
    this._batchTimeTrigger = batchTimeTrigger;
    this._maxConcurrentBatches = maxConcurrentBatches;
    this._pendingWorkCapacity = pendingWorkCapacity;
    this._timeout = deadlineTimeoutMs;
    this._sendTimeoutId = -1;
    this._eventQueue = [];
    this._batchCount = 0;

    if (typeof options.responseCallback === "function") {
      this._responseCallback = options.responseCallback;
    }
    if (typeof options.batchSizeTrigger === "number") {
      this._batchSizeTrigger = Math.max(options.batchSizeTrigger, 1);
    }
    if (typeof options.batchTimeTrigger === "number") {
      this._batchTimeTrigger = options.batchTimeTrigger;
    }
    if (typeof options.maxConcurrentBatches === "number") {
      this._maxConcurrentBatches = options.maxConcurrentBatches;
    }
    if (typeof options.pendingWorkCapacity === "number") {
      this._pendingWorkCapacity = options.pendingWorkCapacity;
    }
    if (typeof options.timeout === "number") {
      this._timeout = options.timeout;
    }

    this._userAgentAddition = options.userAgentAddition || "";

    // Included for testing; to stub out randomness and verify that an event
    // was dropped.
    this._randomFn = Math.random;
  }

  _droppedCallback(ev, reason) {
    this._responseCallback([
      {
        metadata: ev.metadata,
        error: new Error(reason)
      }
    ]);
  }

  sendEvent(ev) {
    // bail early if we aren't sampling this event
    if (!this._shouldSendEvent(ev)) {
      this._droppedCallback(ev, "event dropped due to sampling");
      return;
    }

    this.sendPresampledEvent(ev);
  }

  sendPresampledEvent(ev) {
    if (this._eventQueue.length >= this._pendingWorkCapacity) {
      this._droppedCallback(ev, "queue overflow");
      return;
    }
    this._eventQueue.push(ev);
    if (this._eventQueue.length >= this._batchSizeTrigger) {
      this._sendBatch();
    } else {
      this._ensureSendTimeout();
    }
  }

  flush() {
    if (this._eventQueue.length === 0 && this._batchCount === 0) {
      // we're not currently waiting on anything, we're done!
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.flushCallback = () => {
        this.flushCallback = null;
        resolve();
      };
    });
  }

  async _sendBatch() {
    if (this._batchCount === maxConcurrentBatches) {
      // don't start up another concurrent batch.  the next timeout/sendEvent or batch completion
      // will cause us to send another
      return;
    }

    this._clearSendTimeout();

    this._batchCount++;

    let batchAgg = new BatchEndpointAggregator(
      this._eventQueue.splice(0, this._batchSizeTrigger)
    );

    const finishBatch = () => {
      this._batchCount--;

      let queueLength = this._eventQueue.length;
      if (queueLength > 0) {
        if (queueLength >= this._batchSizeTrigger) {
          this._sendBatch();
        } else {
          this._ensureSendTimeout();
        }
        return;
      }

      if (this._batchCount === 0 && this.flushCallback) {
        this.flushCallback();
      }
    };

    const fetchWithTimeout = (url, { signal, ...options }, ms) => {
      const controller = new AbortController();
      const promise = fetch(url, { signal: controller.signal, ...options });
      if (signal) signal.addEventListener("abort", () => controller.abort());
      const timeout = setTimeout(() => controller.abort(), ms);
      return promise.finally(() => clearTimeout(timeout));
    };

    let batches = Object.keys(batchAgg.batches).map(k => batchAgg.batches[k]);
    try {
      await eachPromise(batches, async (batch) => {
        let url = new URL(`/1/batch/${batch.dataset}`, batch.apiHost).href;
        let { encoded, numEncoded } = batchAgg.encodeBatchEvents(batch.events);

        if (numEncoded === 0) {
          this._responseCallback(
            batch.events.map(ev => ({
              metadata: ev.metadata,
              error: ev.encodeError
            }))
          );
          return;
        }

        let userAgent = USER_AGENT;
        let trimmedAddition = this._userAgentAddition.trim();
        if (trimmedAddition) {
          userAgent = `${USER_AGENT} ${trimmedAddition}`;
        }

        let start = Date.now();
        try {
          const response = await fetchWithTimeout(url, {
            method: "POST",
            headers: {
              "X-Honeycomb-Team": batch.writeKey,
              ["node" === "browser" ? "X-Honeycomb-UserAgent" : "User-Agent"]: userAgent,
              "Content-Type": "application/json"
            },
            body: encoded
          }, this._timeout);

          let end = Date.now();

          if (!response.ok) {
            const error = new Error(`HTTP error! status: ${response.status}`);

            error.status = response.status;

            throw error;
          }

          let responseData = await response.json();
          let respIdx = 0;
          this._responseCallback(
            batch.events.map(ev => {
              if (ev.encodeError) {
                return {
                  duration: end - start,
                  metadata: ev.metadata,
                  error: ev.encodeError
                };
              } else {
                let nextResponse = responseData[respIdx++];
                return {
                  // eslint-disable-next-line camelcase
                  status_code: nextResponse.status,
                  duration: end - start,
                  metadata: ev.metadata,
                  error: nextResponse.err
                };
              }
            })
          );
        } catch (error) {
          if (error.name === "AbortError") {
            error.timeout = true;
          }

          let end = Date.now();
          this._responseCallback(
            batch.events.map(ev => ({
              // eslint-disable-next-line camelcase
              status_code: ev.encodeError ? undefined : (error.status || undefined),
              duration: end - start,
              metadata: ev.metadata,
              error: ev.encodeError || error
            }))
          );
        }
      });
    } catch (error) {
      console.error("Error in batch processing:", error);
    } finally {
      finishBatch();
    }
  }

  _shouldSendEvent(ev) {
    let { sampleRate } = ev;
    if (sampleRate <= 1) {
      return true;
    }
    return this._randomFn() < 1 / sampleRate;
  }

  _ensureSendTimeout() {
    if (this._sendTimeoutId === -1) {
      this._sendTimeoutId = _global.setTimeout(
        () => this._sendBatch(),
        this._batchTimeTrigger
      );
    }
  }

  _clearSendTimeout() {
    if (this._sendTimeoutId !== -1) {
      _global.clearTimeout(this._sendTimeoutId);
      this._sendTimeoutId = -1;
    }
  }
}

// Copyright 2016 Hound Technology, Inc. All rights reserved.
// Use of this source code is governed by the Apache License 2.0
// license that can be found in the LICENSE file.

/**
 * a simple function that offers the same interface
 * for both Map and object key interation.
 * @private
 */
function foreach(col, f) {
  if (!col) {
    return;
  }
  if (col instanceof Map) {
    col.forEach(f);
  } else {
    Object.getOwnPropertyNames(col).forEach(k => f(col[k], k));
  }
}

// Copyright 2016 Hound Technology, Inc. All rights reserved.

/**
 * Represents an individual event to send to Honeycomb.
 * @class
 */
class Event {
  /**
   * @constructor
   * private
   */
  constructor(libhoney, fields, dynFields) {
    this.data = Object.create(null);
    this.metadata = null;

    /**
     * The hostname for the Honeycomb API server to which to send this event.  default:
     * https://api.honeycomb.io/
     *
     * @type {string}
     */
    this.apiHost = "";
    /**
     * The Honeycomb authentication token for this event.  Find your team write key at
     * https://ui.honeycomb.io/account
     *
     * @type {string}
     */
    this.writeKey = "";
    /**
     * The name of the Honeycomb dataset to which to send this event.
     *
     * @type {string}
     */
    this.dataset = "";
    /**
     * The rate at which to sample this event.
     *
     * @type {number}
     */
    this.sampleRate = 1;

    /**
     * If set, specifies the timestamp associated with this event. If unset,
     * defaults to Date.now();
     *
     * @type {Date}
     */
    this.timestamp = null;

    foreach(fields, (v, k) => this.addField(k, v));
    foreach(dynFields, (v, k) => this.addField(k, v()));

    // stash this away for .send()
    this._libhoney = libhoney;
  }

  /**
   * adds a group of field->values to this event.
   * @param {Object|Map} data field->value mapping.
   * @returns {Event} this event.
   * @example <caption>using an object</caption>
   *   builder.newEvent()
   *     .add ({
   *       responseTime_ms: 100,
   *       httpStatusCode: 200
   *     })
   *     .send();
   * @example <caption>using an ES2015 map</caption>
   *   let map = new Map();
   *   map.set("responseTime_ms", 100);
   *   map.set("httpStatusCode", 200);
   *   let event = honey.newEvent();
   *   event.add (map);
   *   event.send();
   */
  add(data) {
    foreach(data, (v, k) => this.addField(k, v));
    return this;
  }

  /**
   * adds a single field->value mapping to this event.
   * @param {string} name
   * @param {any} val
   * @returns {Event} this event.
   * @example
   *   builder.newEvent()
   *     .addField("responseTime_ms", 100)
   *     .send();
   */
  addField(name, val) {
    if (val === undefined) {
      this.data[name] = null;
      return this;
    }
    this.data[name] = val;
    return this;
  }

  /**
   * attaches data to an event that is not transmitted to honeycomb, but instead is available when checking the send responses.
   * @param {any} md
   * @returns {Event} this event.
   */
  addMetadata(md) {
    this.metadata = md;
    return this;
  }

  /**
   * Sends this event to honeycomb, sampling if necessary.
   */
  send() {
    this._libhoney.sendEvent(this);
  }

  /**
   * Dispatch an event to be sent to Honeycomb.  Assumes sampling has already happened,
   * and will send every event handed to it.
   */
  sendPresampled() {
    this._libhoney.sendPresampledEvent(this);
  }
}

// Copyright 2016 Hound Technology, Inc. All rights reserved.

/**
 * Allows piecemeal creation of events.
 * @class
 */
class Builder {
  /**
   * @constructor
   * @private
   */
  constructor(libhoney, fields, dynFields) {
    this._libhoney = libhoney;
    this._fields = Object.create(null);
    this._dynFields = Object.create(null);

    /**
     * The hostname for the Honeycomb API server to which to send events created through this
     * builder.  default: https://api.honeycomb.io/
     *
     * @type {string}
     */
    this.apiHost = "";
    /**
     * The Honeycomb authentication token. If it is set on a libhoney instance it will be used as the
     * default write key for all events. If absent, it must be explicitly set on a Builder or
     * Event. Find your team write key at https://ui.honeycomb.io/account
     *
     * @type {string}
     */
    this.writeKey = "";
    /**
     * The name of the Honeycomb dataset to which to send these events.  If it is specified during
     * libhoney initialization, it will be used as the default dataset for all events. If absent,
     * dataset must be explicitly set on a builder or event.
     *
     * @type {string}
     */
    this.dataset = "";
    /**
     * The rate at which to sample events. Default is 1, meaning no sampling. If you want to send one
     * event out of every 250 times send() is called, you would specify 250 here.
     *
     * @type {number}
     */
    this.sampleRate = 1;

    foreach(fields, (v, k) => this.addField(k, v));
    foreach(dynFields, (v, k) => this.addDynamicField(k, v));
  }

  /**
   * adds a group of field->values to the events created from this builder.
   * @param {Object|Map<string, any>} data field->value mapping.
   * @returns {Builder} this Builder instance.
   * @example <caption>using an object</caption>
   *   var honey = new libhoney();
   *   var builder = honey.newBuilder();
   *   builder.add ({
   *     component: "web",
   *     depth: 200
   *   });
   * @example <caption>using an ES2015 map</caption>
   *   let map = new Map();
   *   map.set("component", "web");
   *   map.set("depth", 200);
   *   builder.add (map);
   */
  add(data) {
    foreach(data, (v, k) => this.addField(k, v));
    return this;
  }

  /**
   * adds a single field->value mapping to the events created from this builder.
   * @param {string} name
   * @param {any} val
   * @returns {Builder} this Builder instance.
   * @example
   *   builder.addField("component", "web");
   */
  addField(name, val) {
    if (val === undefined) {
      this._fields[name] = null;
      return this;
    }
    this._fields[name] = val;
    return this;
  }

  /**
   * adds a single field->dynamic value function, which is invoked to supply values when events are created from this builder.
   * @param {string} name the name of the field to add to events.
   * @param {function(): any} fn the function called to generate the value for this field.
   * @returns {Builder} this Builder instance.
   * @example
   *   builder.addDynamicField("process_heapUsed", () => process.memoryUsage().heapUsed);
   */
  addDynamicField(name, fn) {
    this._dynFields[name] = fn;
    return this;
  }

  /**
   * creates and sends an event, including all builder fields/dynFields, as well as anything in the optional data parameter.
   * @param {Object|Map<string, any>} [data] field->value mapping to add to the event sent.
   * @example <caption>empty sendNow</caption>
   *   builder.sendNow(); // sends just the data that has been added via add/addField/addDynamicField.
   * @example <caption>adding data at send-time</caption>
   *   builder.sendNow({
   *     additionalField: value
   *   });
   */
  sendNow(data) {
    let ev = this.newEvent();
    ev.add(data);
    ev.send();
  }

  /**
   * creates and returns a new Event containing all fields/dynFields from this builder, that can be further fleshed out and sent on its own.
   * @returns {Event} an Event instance
   * @example <caption>adding data at send-time</caption>
   *   let ev = builder.newEvent();
   *   ev.addField("additionalField", value);
   *   ev.send();
   */
  newEvent() {
    let ev = new Event(this._libhoney, this._fields, this._dynFields);
    ev.apiHost = this.apiHost;
    ev.writeKey = this.writeKey;
    ev.dataset = this.dataset;
    ev.sampleRate = this.sampleRate;
    return ev;
  }

  /**
   * creates and returns a clone of this builder, merged with fields and dynFields passed as arguments.
   * @param {Object|Map<string, any>} fields a field->value mapping to merge into the new builder.
   * @param {Object|Map<string, any>} dynFields a field->dynamic function mapping to merge into the new builder.
   * @returns {Builder} a Builder instance
   * @example <caption>no additional fields/dyn_field</caption>
   *   let anotherBuilder = builder.newBuilder();
   * @example <caption>additional fields/dyn_field</caption>
   *   let anotherBuilder = builder.newBuilder({ requestId },
   *                                           {
   *                                             process_heapUsed: () => process.memoryUsage().heapUsed
   *                                           });
   */
  newBuilder(fields, dynFields) {
    let b = new Builder(this._libhoney, this._fields, this._dynFields);

    foreach(fields, (v, k) => b.addField(k, v));
    foreach(dynFields, (v, k) => b.addDynamicField(k, v));

    b.apiHost = this.apiHost;
    b.writeKey = this.writeKey;
    b.dataset = this.dataset;
    b.sampleRate = this.sampleRate;

    return b;
  }
}

// Copyright 2016 Hound Technology, Inc. All rights reserved.

const defaults = Object.freeze({
  apiHost: "https://api.honeycomb.io/",

  // sample rate of data.  causes us to send 1/sample-rate of events
  // i.e. `sampleRate: 10` means we only send 1/10th the events.
  sampleRate: 1,

  // transmission constructor, or a string to pick one of our builtin versions.
  // we fall back to the base impl if worker or a custom implementation throws on init.
  // string options available are:
  //  - "base": the default transmission implementation
  //  - "worker": a web-worker based transmission (not currently available, see https://github.com/honeycombio/libhoney-js/issues/22)
  //  - "mock": an implementation that accumulates all events sent
  //  - "writer": an implementation that logs to the console all events sent (deprecated.  use "console" instead)
  //  - "console": an implementation that logs correct json objects to the console for all events sent.
  //  - "stdout": an implementation that logs correct json objects to standard out, useful for environments where console.log is not ideal (e.g. AWS Lambda)
  //  - "null": an implementation that does nothing
  transmission: "base",

  // batch triggers
  batchSizeTrigger: 50, // we send a batch to the api when we have this many outstanding events
  batchTimeTrigger: 100, // ... or after this many ms has passed.

  // batches are sent serially (one event at a time), so we allow multiple concurrent batches
  // to increase parallelism while sending.
  maxConcurrentBatches: 10,

  // the maximum number of pending events we allow in our to-be-batched-and-transmitted queue before dropping them.
  pendingWorkCapacity: 10000,

  // the maximum number of responses we enqueue before we begin dropping them.
  maxResponseQueueSize: 1000,

  // how long (in ms) to give a single POST before we timeout.
  timeout: 60000,

  // if this is set to true, all sending is disabled.  useful for disabling libhoney when testing
  disabled: false,

  // If this is non-empty, append it to the end of the User-Agent header.
  userAgentAddition: "",
});

/**
 * libhoney aims to make it as easy as possible to create events and send them on into Honeycomb.
 *
 * See https://honeycomb.io/docs for background on this library.
 * @class
 */
class Libhoney extends EventEmitter {
  /**
   * Constructs a libhoney context in order to configure default behavior,
   * though each of its members (`apiHost`, `writeKey`, `dataset`, and
   * `sampleRate`) may in fact be overridden on a specific Builder or Event.
   *
   * @param {Object} [opts] overrides for the defaults
   * @param {string} [opts.apiHost=https://api.honeycomb.io] - Server host to receive Honeycomb events.
   * @param {string} opts.writeKey - Write key for your Honeycomb team. (Required)
   * @param {string} opts.dataset - Name of the dataset that should contain this event. The dataset will be created for your team if it doesn't already exist.
   * @param {number} [opts.sampleRate=1] - Sample rate of data. If set, causes us to send 1/sampleRate of events and drop the rest.
   * @param {number} [opts.batchSizeTrigger=50] - We send a batch to the API when this many outstanding events exist in our event queue.
   * @param {number} [opts.batchTimeTrigger=100] - We send a batch to the API after this many milliseconds have passed.
   * @param {number} [opts.maxConcurrentBatches=10] - We process batches concurrently to increase parallelism while sending.
   * @param {number} [opts.pendingWorkCapacity=10000] - The maximum number of pending events we allow to accumulate in our sending queue before dropping them.
   * @param {number} [opts.maxResponseQueueSize=1000] - The maximum number of responses we enqueue before dropping them.
   * @param {number} [opts.timeout=60000] - How long (in ms) to give a single POST before we timeout.
   * @param {boolean} [opts.disabled=false] - Disable transmission of events to the specified `apiHost`, particularly useful for testing or development.
   * @constructor
   * @example
   * import Libhoney from 'libhoney';
   * let honey = new Libhoney({
   *   writeKey: "YOUR_WRITE_KEY",
   *   dataset: "honeycomb-js-example",
   *   // disabled: true // uncomment when testing or in development
   * });
   */
  constructor(opts) {
    super();
    this._options = Object.assign(
      { responseCallback: this._responseCallback.bind(this) },
      defaults,
      opts
    );
    this._transmission = getAndInitTransmission(
      this._options.transmission,
      this._options
    );
    this._usable = this._transmission !== null;
    this._builder = new Builder(this);

    this._builder.apiHost = this._options.apiHost;
    this._builder.writeKey = this._options.writeKey;
    this._builder.dataset = this._options.dataset;
    this._builder.sampleRate = this._options.sampleRate;

    this._responseQueue = [];
  }

  _responseCallback(responses) {
    const [queue, limit] = [
      this._responseQueue,
      this._options.maxResponseQueueSize,
    ];

    this._responseQueue = concatWithMaxLimit(queue, responses, limit);

    this.emit("response", this._responseQueue);
  }

  /**
   * The transmission implementation in use for this libhoney instance.  Useful when mocking libhoney (specify
   * "mock" for options.transmission, and use this field to get at the list of events sent through libhoney.)
   */
  get transmission() {
    return this._transmission;
  }

  /**
   * The hostname for the Honeycomb API server to which to send events created through this libhoney
   * instance. default: https://api.honeycomb.io/
   *
   * @type {string}
   */
  set apiHost(v) {
    this._builder.apiHost = v;
  }
  /**
   * The hostname for the Honeycomb API server to which to send events created through this libhoney
   * instance. default: https://api.honeycomb.io/
   *
   * @type {string}
   */
  get apiHost() {
    return this._builder.apiHost;
  }

  /**
   * The Honeycomb authentication token. If it is set on a libhoney instance it will be used as the
   * default write key for all events. If absent, it must be explicitly set on a Builder or
   * Event. Find your team write key at https://ui.honeycomb.io/account
   *
   * @type {string}
   */
  set writeKey(v) {
    this._builder.writeKey = v;
  }
  /**
   * The Honeycomb authentication token. If it is set on a libhoney instance it will be used as the
   * default write key for all events. If absent, it must be explicitly set on a Builder or
   * Event. Find your team write key at https://ui.honeycomb.io/account
   *
   * @type {string}
   */
  get writeKey() {
    return this._builder.writeKey;
  }

  /**
   * The name of the Honeycomb dataset to which to send events through this libhoney instance.  If
   * it is specified during libhoney initialization, it will be used as the default dataset for all
   * events. If absent, dataset must be explicitly set on a builder or event.
   *
   * @type {string}
   */
  set dataset(v) {
    this._builder.dataset = v;
  }
  /**
   * The name of the Honeycomb dataset to which to send these events through this libhoney instance.
   * If it is specified during libhoney initialization, it will be used as the default dataset for
   * all events. If absent, dataset must be explicitly set on a builder or event.
   *
   * @type {string}
   */
  get dataset() {
    return this._builder.dataset;
  }

  /**
   * The rate at which to sample events. Default is 1, meaning no sampling. If you want to send one
   * event out of every 250 times send() is called, you would specify 250 here.
   *
   * @type {number}
   */
  set sampleRate(v) {
    this._builder.sampleRate = v;
  }
  /**
   * The rate at which to sample events. Default is 1, meaning no sampling. If you want to send one
   * event out of every 250 times send() is called, you would specify 250 here.
   *
   * @type {number}
   */
  get sampleRate() {
    return this._builder.sampleRate;
  }

  /**
   *  sendEvent takes events of the following form:
   *
   * {
   *   data: a JSON-serializable object, keys become colums in Honeycomb
   *   timestamp [optional]: time for this event, defaults to now()
   *   writeKey [optional]: your team's write key.  overrides the libhoney instance's value.
   *   dataset [optional]: the data set name.  overrides the libhoney instance's value.
   *   sampleRate [optional]: cause us to send 1 out of sampleRate events.  overrides the libhoney instance's value.
   * }
   *
   * Sampling is done based on the supplied sampleRate, so events passed to this method might not
   * actually be sent to Honeycomb.
   * @private
   */
  sendEvent(event) {
    let transmitEvent = this.validateEvent(event);
    if (!transmitEvent) {
      return;
    }

    this._transmission.sendEvent(transmitEvent);
  }

  /**
   *  sendPresampledEvent takes events of the following form:
   *
   * {
   *   data: a JSON-serializable object, keys become colums in Honeycomb
   *   timestamp [optional]: time for this event, defaults to now()
   *   writeKey [optional]: your team's write key.  overrides the libhoney instance's value.
   *   dataset [optional]: the data set name.  overrides the libhoney instance's value.
   *   sampleRate: the rate this event has already been sampled.
   * }
   *
   * Sampling is presumed to have already been done (at the supplied sampledRate), so all events passed to this method
   * are sent to Honeycomb.
   * @private
   */
  sendPresampledEvent(event) {
    let transmitEvent = this.validateEvent(event);
    if (!transmitEvent) {
      return;
    }

    this._transmission.sendPresampledEvent(transmitEvent);
  }

  /**
   * isClassic takes a writeKey and returns true if it is a "classic" writeKey,
   * namely, that its length is exactly 32 characters.
   * @returns {boolean} whether the key is classic
   *
   * @private
   */
  isClassic(key) {
    return key.length === 32;
  }

  /**
   * validateEvent takes an event and validates its structure and contents.
   *
   * @returns {Object} the validated libhoney Event. May return undefined if
   *                   the event was invalid in some way or unable to be sent.
   * @private
   */
  validateEvent(event) {
    if (!this._usable) return null;

    let timestamp = event.timestamp || Date.now();
    if (typeof timestamp === "string" || typeof timestamp === "number")
      timestamp = new Date(timestamp);

    if (typeof event.data !== "object" || event.data === null) {
      console.error("data must be an object");
      return null;
    }
    let postData;
    try {
      postData = JSON.parse(JSON.stringify(event.data));
    } catch (e) {
      console.error("error cloning event data: " + e);
      return null;
    }

    let apiHost = event.apiHost;
    if (typeof apiHost !== "string" || apiHost === "") {
      console.error("apiHost must be a non-empty string");
      return null;
    }

    let writeKey = event.writeKey;
    if (typeof writeKey !== "string" || writeKey === "") {
      console.error("writeKey must be a non-empty string");
      return null;
    }

    let dataset = event.dataset;
    if (typeof dataset !== "string") {
      console.error("dataset must be a string");
      return null;
    }

    if (dataset === "") {
      if (this.isClassic(writeKey)) {
        console.error("dataset must be a non-empty string");
        return null;
      } else {
        dataset = "unknown_dataset";
      }
    }

    let sampleRate = event.sampleRate;
    if (typeof sampleRate !== "number") {
      console.error("sampleRate must be a number");
      return null;
    }

    let metadata = event.metadata;
    return new ValidatedEvent({
      timestamp,
      apiHost,
      postData,
      writeKey,
      dataset,
      sampleRate,
      metadata,
    });
  }

  /**
   * adds a group of field->values to the global Builder.
   * @param {Object|Map<string, any>} data field->value mapping.
   * @returns {Libhoney} this libhoney instance.
   * @example <caption>using an object</caption>
   *   honey.add ({
   *     buildID: "a6cc38a1",
   *     env: "staging"
   *   });
   * @example <caption>using an ES2015 map</caption>
   *   let map = new Map();
   *   map.set("build_id", "a6cc38a1");
   *   map.set("env", "staging");
   *   honey.add (map);
   */
  add(data) {
    this._builder.add(data);
    return this;
  }

  /**
   * adds a single field->value mapping to the global Builder.
   * @param {string} name name of field to add.
   * @param {any} val value of field to add.
   * @returns {Libhoney} this libhoney instance.
   * @example
   *   honey.addField("build_id", "a6cc38a1");
   */
  addField(name, val) {
    this._builder.addField(name, val);
    return this;
  }

  /**
   * adds a single field->dynamic value function to the global Builder.
   * @param {string} name name of field to add.
   * @param {function(): any} fn function that will be called to generate the value whenever an event is created.
   * @returns {Libhoney} this libhoney instance.
   * @example
   *   honey.addDynamicField("process_heapUsed", () => process.memoryUsage().heapUsed);
   */
  addDynamicField(name, fn) {
    this._builder.addDynamicField(name, fn);
    return this;
  }

  /**
   * creates and sends an event, including all global builder fields/dynFields, as well as anything in the optional data parameter.
   * @param {Object|Map<string, any>} data field->value mapping.
   * @example <caption>using an object</caption>
   *   honey.sendNow ({
   *     responseTime_ms: 100,
   *     httpStatusCode: 200
   *   });
   * @example <caption>using an ES2015 map</caption>
   *   let map = new Map();
   *   map.set("responseTime_ms", 100);
   *   map.set("httpStatusCode", 200);
   *   honey.sendNow (map);
   */
  sendNow(data) {
    return this._builder.sendNow(data);
  }

  /**
   * creates and returns a new Event containing all fields/dynFields from the global Builder, that can be further fleshed out and sent on its own.
   * @returns {Event} an Event instance
   * @example <caption>adding data at send-time</caption>
   *   let ev = honey.newEvent();
   *   ev.addField("additionalField", value);
   *   ev.send();
   */
  newEvent() {
    return this._builder.newEvent();
  }

  /**
   * creates and returns a clone of the global Builder, merged with fields and dynFields passed as arguments.
   * @param {Object|Map<string, any>} fields a field->value mapping to merge into the new builder.
   * @param {Object|Map<string, any>} dynFields a field->dynamic function mapping to merge into the new builder.
   * @returns {Builder} a Builder instance
   * @example <caption>no additional fields/dyn_field</caption>
   *   let builder = honey.newBuilder();
   * @example <caption>additional fields/dyn_field</caption>
   *   let builder = honey.newBuilder({ requestId },
   *                                  {
   *                                    process_heapUsed: () => process.memoryUsage().heapUsed
   *                                  });
   */
  newBuilder(fields, dynFields) {
    return this._builder.newBuilder(fields, dynFields);
  }

  /**
   * Allows you to easily wait for everything to be sent to Honeycomb (and for responses to come back for
   * events). Also initializes a transmission instance for libhoney to use, so any events sent
   * after a call to flush will not be waited on.
   * @returns {Promise} a promise that will resolve when all currently enqueued events/batches are sent.
   */
  flush() {
    const transmission = this._transmission;

    this._transmission = getAndInitTransmission(
      this._options.transmission,
      this._options
    );

    if (!transmission) {
      return Promise.resolve();
    }

    return transmission.flush();
  }
}

const getTransmissionClass = (transmissionClassName) => {
  switch (transmissionClassName) {
    case "base":
      return Transmission;
    case "mock":
      return MockTransmission;
    case "null":
      return NullTransmission;
    case "worker":
      console.warn(
        "worker implementation not ready yet.  using base implementation"
      );
      return Transmission;
    case "writer":
      console.warn(
        "writer implementation is deprecated.  Please switch to console implementation."
      );
      return WriterTransmission;
    case "console":
      return ConsoleTransmission;
    case "stdout":
      return StdoutTransmission;
    default:
      throw new Error(
        `unknown transmission implementation "${transmissionClassName}".`
      );
  }
};

function getAndInitTransmission(transmission, options) {
  if (options.disabled) {
    return null;
  }

  if (typeof transmission === "string") {
    const transmissionClass = getTransmissionClass(transmission);
    return new transmissionClass(options);
  } else if (typeof transmission !== "function") {
    throw new Error(
      "transmission must be one of 'base'/'worker'/'mock'/'writer'/'console'/'stdout'/'null' or a constructor."
    );
  }

  try {
    return new transmission(options);
  } catch (initialisationError) {
    if (transmission === Transmission) {
      throw new Error(
        "unable to initialize base transmission implementation.",
        initialisationError
      );
    }

    console.warn(
      "failed to initialize transmission, falling back to base implementation."
    );
    try {
      return new Transmission(options);
    } catch (fallbackInitialisationError) {
      throw new Error(
        "unable to initialize base transmission implementation.",
        fallbackInitialisationError
      );
    }
  }
}

/**
 * Concatenates two arrays while keeping the length of the returned result
 * less than the limit. As many elements from arr2 will be appended onto the
 * end of arr1 as will remain under the limit. If arr1 is already too long it
 * will be truncated to match the limit. Order is preserved; arr2's contents
 * will appear after those already in arr1.
 *
 * Modifies and returns arr1.
 */
function concatWithMaxLimit(arr1, arr2, limit) {
  // if queue is full or somehow over the max
  if (arr1.length >= limit) {
    //return up to the max length
    return arr1.slice(0, limit);
  }

  // if queue is not yet full but incoming responses
  // would put the queue over
  if (arr1.length + arr2.length > limit) {
    // find the difference and return only enough responses to fill the queue
    const diff = limit - arr1.length;
    const slicedArr2 = arr2.slice(0, diff);
    return arr1.concat(slicedArr2);
  }

  // otherwise assume it'll all fit, combine the responses with the queue
  return arr1.concat(arr2);
}

export { Libhoney as default };
