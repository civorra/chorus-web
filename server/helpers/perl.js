/**
 * server/helpers/perl.js — Spawn Perl avec streaming SSE
 */
'use strict';

const { spawn } = require('child_process');
const { sseSend, sseError } = require('./sse');

const PERL = process.env.PERL_BIN || 'perl';

function spawnPerl(args, cwd, res, onDone) {
  const proc = spawn(PERL, args, { cwd, env: process.env });

  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').forEach(line => {
      if (line.trim()) sseSend(res, 'log', { line });
    });
  });

  proc.stderr.on('data', chunk => {
    chunk.toString().split('\n').forEach(line => {
      if (line.trim()) sseSend(res, 'log', { line, level: 'warn' });
    });
  });

  proc.on('close', code => {
    if (code === 0) {
      onDone();
    } else {
      sseError(res, `Processus terminé avec code ${code}`);
    }
  });

  proc.on('error', err => {
    sseError(res, `Impossible de lancer perl : ${err.message}`);
  });

  return proc;
}

module.exports = { spawnPerl, PERL };
