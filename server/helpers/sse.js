/**
 * server/helpers/sse.js — Helpers Server-Sent Events
 */
'use strict';

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res, data = {}) {
  sseSend(res, 'done', data);
  res.end();
}

function sseError(res, message) {
  sseSend(res, 'error', { message });
  res.end();
}

module.exports = { sseInit, sseSend, sseDone, sseError };
