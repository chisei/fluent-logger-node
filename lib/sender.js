'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var msgpack = require('msgpack-lite');
var net = require('net');
var stream = require('stream');
var crypto = require('crypto');
var FluentLoggerError = require('./logger-error');
var EventTime = require('./event-time').EventTime;

var codec = msgpack.createCodec();
codec.addExtPacker(0x00, EventTime, EventTime.pack);
codec.addExtUnpacker(0x00, EventTime.unpack);

function FluentSender(tag_prefix, options){
  options = options || {};
  this.tag_prefix = tag_prefix;
  this.host = options.host || 'localhost';
  this.port = options.port || 24224;
  this.path = options.path;
  this.timeout = options.timeout || 3.0;
  this.reconnectInterval = options.reconnectInterval || 600000; // Default is 10 minutes
  this.requireAckResponse = options.requireAckResponse;
  this.ackResponseTimeout = options.ackResponseTimeout || 190000; // Default is 190 seconds
  this.internalLogger = options.internalLogger || console;
  this._timeResolution = options.milliseconds ? 1 : 1000;
  this._socket = null;
  this._sendQueue = []; // queue for items waiting for being sent.
  this._eventEmitter = new EventEmitter();
}

FluentSender.prototype.emit = function(/*[label] <data>, [timestamp], [callback] */){
  var label, data, timestamp, callback;
  var args = Array.prototype.slice.call(arguments);
  // Label must be string always
  if (typeof args[0] === 'string') label = args.shift();

  // Data can be almost anything
  data = args.shift();

  // Date can be either timestamp number or Date object
  if (typeof args[0] !== 'function') timestamp = args.shift();

  // Last argument is an optional callback
  if (typeof args[0] === 'function') callback = args.shift();

  var item = this._makePacketItem(label, data, timestamp);

  var error;
  var options;
  if (item.tag === null) {
    options = {
      tag_prefix: this.tag_prefix,
      label: label
    };
    error = new FluentLoggerError.MissingTag('tag is missing', options);
    this._handleEvent('error', error, callback);
    return;
  }
  if (typeof item.data !== 'object') {
    options = {
      tag_prefix: this.tag_prefix,
      label: label,
      record: item.data
    };
    error = new FluentLoggerError.DataTypeError('data must be an object', options);
    this._handleEvent('error', error, callback);
    return;
  }

  item.callback = callback;

  this._sendQueue.push(item);
  this._connect(() => {
    this._flushSendQueue();
  });
};

['addListener', 'on', 'once', 'removeListener', 'removeAllListeners', 'setMaxListeners', 'getMaxListeners'].forEach(function(attr, i){
  FluentSender.prototype[attr] = function(){
    return this._eventEmitter[attr].apply(this._eventEmitter, Array.prototype.slice.call(arguments));
  };
});

FluentSender.prototype.end = function(label, data, callback){
  if ((label != null && data != null)) {
    this.emit(label, data, (err) => {
      this._close();
      if (err) {
        this._handleEvent('error', err, callback);
      } else {
        callback && callback();
      }
    });
  } else {
    process.nextTick(() => {
      this._close();
      callback && callback();
    });
  }
};

FluentSender.prototype._close = function() {
  if (this._socket) {
    this._socket.end();
    this._socket = null;
  }
};


FluentSender.prototype._makePacketItem = function(label, data, time){
  var tag = null;
  if (this.tag_prefix && label) {
    tag = [this.tag_prefix, label].join('.');
  } else if (this.tag_prefix) {
    tag = this.tag_prefix;
  } else if (label) {
    tag = label;
  }

  if (typeof time !== 'number' && !(time instanceof EventTime)) {
    time = Math.floor((time ? time.getTime() : Date.now()) / this._timeResolution);
  }

  var packet = [tag, time, data];
  var options = {};
  if (this.requireAckResponse) {
    options = {
      chunk: crypto.randomBytes(16).toString('base64')
    };
    packet.push(options);
  }
  return {
    packet: msgpack.encode(packet, { codec: codec }),
    tag: tag,
    time: time,
    data: data,
    options: options
  };
};

FluentSender.prototype._connect = function(callback){
  if (this._socket === null) {
    this._socket = new net.Socket();
    this._socket.setTimeout(this.timeout);
    this._socket.on('error', (err) => {
      if (this._socket) {
        this._socket.destroy();
        this._socket = null;
        this._handleEvent('error', err);
      }
    });
    this._socket.on('connect', () => {
      this._handleEvent('connect');
    });
    if (this.path) {
      this._socket.connect(this.path, callback);
    } else {
      this._socket.connect(this.port, this.host, callback);
    }
  } else {
    if (!this._socket.writable) {
      this._socket.destroy();
      this._socket = null;
      process.nextTick(() => {
        this._connect(callback);
      });
    } else {
      process.nextTick(callback);
    }
  }
};

FluentSender.prototype._flushSendQueue = function() {
  if (this._flushingSendQueue)
    return;

  this._flushingSendQueue = true;
  process.nextTick(() => {
    if (!this._socket) {
      this._flushingSendQueue = false;
      return;
    }

    if (this._socket.writable) {
      this._doFlushSendQueue();
    } else {
      process.nextTick(waitToWrite);
    }
  });
};

FluentSender.prototype._doFlushSendQueue = function() {
  var item = this._sendQueue.shift();
  var timeoutId = null;
  if (item === undefined) {
    this._flushingSendQueue = false;
    // nothing written;
  } else {
    this._socket.write(new Buffer(item.packet), () => {
      if (this.requireAckResponse) {
        this._socket.once('data', (data) => {
          timeoutId && clearTimeout(timeoutId);
          var response = msgpack.decode(data, { codec: codec });
          if (response.ack !== item.options.chunk) {
            var error = new FluentLoggerError.ResponseError('ack in response and chunk id in sent data are different',
                                                            { ack: response.ack, chunk: item.options.chunk });
            this._handleEvent('error', error, item.callback);
          }
          item.callback && item.callback();
          process.nextTick(() => {
            this._doFlushSendQueue(); // if socket is still available
          });
        });
        timeoutId = setTimeout(() => {
          var error = new FluentLoggerError.ResponseTimeout('ack response timeout');
          this._handleEvent('error', error, item.callback);
        }, this.ackResponseTimeout);
      } else {
        item.callback && item.callback();
        process.nextTick(() => {
          this._doFlushSendQueue(); // if socket is still available
        });
      }
    });
    // TODO: how should we recorver if dequeued items are not sent.
  }
};

FluentSender.prototype._handleEvent = function _handleEvent(signal, data, callback) {
  callback && callback(data);
  if (this._eventEmitter.listenerCount(signal) > 0) {
    this._eventEmitter.emit(signal, data);
  }
};

FluentSender.prototype._setupErrorHandler = function _setupErrorHandler() {
  if (!this.reconnectInterval) {
    return;
  }
  this.on('error', (error) => {
    this._flushingSendQueue = false;
    this.internalLogger.error('Fluentd error', error);
    this.internalLogger.info('Fluentd will reconnect after ' + this.reconnectInterval / 1000 + ' seconds');
    setTimeout(() => {
      this.internalLogger.info('Fluentd is reconnecting...');
      this._connect(() => {
        this.internalLogger.info('Fluentd reconnection finished!!');
      });
    }, this.reconnectInterval);
  });
};

FluentSender.prototype.toStream = function(options) {
  if (typeof options === 'string') {
    options = {label: options};
  } else {
    options = options || {};
  }
  var label = options.label;
  if (!label) {
    throw new Error('label is needed');
  }
  var defaultEncoding = options.encoding || 'UTF-8';
  var writable = new stream.Writable();
  var dataString = '';
  writable._write = (chunk, encoding, callback) => {
    var dataArray = chunk.toString(defaultEncoding).split(/\n/);
    var next = () => {
      if (dataArray.length) {
        dataString += dataArray.shift();
      }
      if (!dataArray.length) {
        process.nextTick(callback);
        return;
      }
      this.emit(label, { message: dataString }, (err) => {
        if (err) {
          this._handleEvent('error', err, callback);
          return;
        }
        dataString = '';
        next();
      });
    };
    next();
  };
  return writable;
};

module.exports = exports = {};
exports.FluentSender = FluentSender;
