'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {join} = require('node:path');
const test = require('node:test');

for (const args of [['gjs', 'apply-once.js'], ['gjs', '-m', 'apply-once.js'], ['./apply-once.js']]) {
    test(`${args.join(' ')} preserves usage validation and reports unavailable service`, () => {
        const options = {
            cwd: join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
            env: {...process.env, GIO_USE_VFS: 'local'},
        };
        const invalid = spawnSync('dbus-run-session', ['--', ...args, '--invalid'], options);
        assert.equal(invalid.status, 2, invalid.stderr);
        assert.match(invalid.stderr, /Usage:/);
        const missing = spawnSync('dbus-run-session', ['--', ...args], options);
        assert.equal(missing.status, 1, missing.stderr);
        assert.match(missing.stderr, /without an owner/);
    });
}
