#!/usr/bin/env node
// Smoke test for AcpClient against a fake ACP server.
// Verifies the JSON-RPC contract end-to-end and guards against the
// resumeSession bug where Hermes silently allocates a new session
// when the requested id is unknown (response omits sessionId).

require('./vscode-shim');
const path = require('path');
const assert = require('assert');

const { AcpClient } = require('../out/acp-client.js');
const { getAcpArgs } = require('../out/acp-client.js');
const { ProfileStore } = require('../out/profile-store.js');
const { createTurnState, reduceTurn } = require('../out/turn-state.js');
const fs = require('fs');
const os = require('os');

const FAKE_SERVER = path.join(__dirname, 'fake-acp-server.js');

let failures = 0;
async function test(name, fn) {
    process.stdout.write('  ' + name + ' ... ');
    try {
        await fn();
        console.log('ok');
    } catch (err) {
        failures += 1;
        console.log('FAIL');
        console.error('    ' + (err && err.stack ? err.stack : String(err)));
    }
}

function makeClient() {
    return new AcpClient(process.execPath + ' ' + FAKE_SERVER, 5000, 5000);
}

// AcpClient's spawn() takes a single program path; we need to spawn `node fake-acp-server.js`.
// Subclass to override start() with a node-based spawn.
const { spawn } = require('child_process');
const { AcpClient: BaseAcpClient } = require('../out/acp-client.js');

class TestAcpClient extends BaseAcpClient {
    async start() {
        if (this.proc) return;
        this.stopping = false;
        this.proc = spawn(process.execPath, [FAKE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.stdout.on('data', (d) => { this.buffer += d.toString('utf8'); this.processBuffer(); });
        this.proc.stderr.on('data', (d) => this.emit('log', d.toString('utf8')));
        this.proc.on('exit', (code) => {
            if (!this.stopping) this.emit('exit', code);
            this.proc = null;
            this.initialized = false;
            for (const { reject, timeout } of this.pendingRequests.values()) {
                clearTimeout(timeout);
                reject(new Error('exited ' + code));
            }
            this.pendingRequests.clear();
        });
        await this.initialize();
    }
}

(async () => {
    console.log('AcpClient smoke tests');

    await test('ACP args isolate named profiles', async () => {
        assert.deepStrictEqual(getAcpArgs('default'), ['acp']);
        assert.deepStrictEqual(getAcpArgs('coder'), ['-p', 'coder', 'acp']);
    });

    await test('ProfileStore discovers isolated profiles', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-profiles-'));
        fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  provider: custom\n  default: root-model\n');
        fs.mkdirSync(path.join(root, 'profiles', 'coder'), { recursive: true });
        fs.writeFileSync(path.join(root, 'profiles', 'coder', 'config.yaml'), 'model:\n  provider: openai-api\n  default: coder-model\n');
        fs.writeFileSync(path.join(root, 'profiles', 'coder', 'profile.yaml'), 'description: Coding specialist\n');
        const profiles = new ProfileStore(root).list();
        assert.deepStrictEqual(profiles.map((profile) => profile.name), ['default', 'coder']);
        assert.strictEqual(profiles[1].description, 'Coding specialist');
        assert.strictEqual(profiles[1].model, 'coder-model');
        fs.rmSync(root, { recursive: true, force: true });
    });

    await test('ProfileStore saves settings inside the selected profile', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-profile-settings-'));
        fs.mkdirSync(path.join(root, 'profiles', 'coder'), { recursive: true });
        const store = new ProfileStore(root);
        const settings = store.saveSettings('coder', 'anthropic', 'claude-sonnet', 'secret-key');
        assert.deepStrictEqual(settings, { provider: 'anthropic', model: 'claude-sonnet', apiKeyConfigured: true });
        assert.match(fs.readFileSync(path.join(root, 'profiles', 'coder', 'config.yaml'), 'utf8'), /provider: anthropic/);
        assert.match(fs.readFileSync(path.join(root, 'profiles', 'coder', '.env'), 'utf8'), /ANTHROPIC_API_KEY=secret-key/);
        assert.strictEqual(fs.existsSync(path.join(root, '.env')), false, 'named profile key must not leak into the default profile');
        fs.rmSync(root, { recursive: true, force: true });
    });

    await test('ProfileStore preserves arbitrary Hermes providers and checks the matching key', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-provider-settings-'));
        fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  provider: openai-api\n  default: gpt-test\n');
        fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=unrelated\nOPENAI_API_KEY=configured\n');
        const store = new ProfileStore(root);
        assert.deepStrictEqual(store.getSettings('default'), { provider: 'openai-api', model: 'gpt-test', apiKeyConfigured: true });
        store.saveSettings('default', 'my-private-gateway', 'private-model');
        assert.strictEqual(store.getSettings('default').provider, 'my-private-gateway');
        fs.rmSync(root, { recursive: true, force: true });
    });

    await test('turn state accumulates streamed assistant text', async () => {
        const initial = createTurnState(1234);
        const next = reduceTurn(initial, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' },
        });
        const complete = reduceTurn(next, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ', world!' },
        });
        assert.strictEqual(complete.message.content, 'Hello, world!');
        assert.strictEqual(complete.message.timestamp, 1234);
        assert.strictEqual(initial.message.content, '', 'reducer must not mutate prior state');
    });

    await test('turn state tracks tool calls through failure', async () => {
        const started = reduceTurn(createTurnState(), {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Run tests',
            status: 'in_progress',
            rawInput: { command: 'npm test' },
        });
        const failed = reduceTurn(started, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            rawOutput: { error: 'tests failed' },
        });
        assert.deepStrictEqual(failed.message.toolCalls, [{
            id: 'tool-1',
            name: 'Run tests',
            status: 'failed',
            args: { command: 'npm test' },
            result: '{"error":"tests failed"}',
        }]);
        assert.strictEqual(started.message.toolCalls[0].status, 'in_progress', 'reducer must not mutate prior tool calls');
    });

    await test('turn state retains thought and latest usage updates', async () => {
        const thinking = reduceTurn(createTurnState(), {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Checking the workspace' },
        });
        const measured = reduceTurn(thinking, {
            sessionUpdate: 'usage_update',
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
        });
        assert.strictEqual(measured.thought, 'Checking the workspace');
        assert.deepStrictEqual(measured.message.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    });

    await test('initialize succeeds', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        assert.strictEqual(c.isReady(), true);
        c.stop();
    });

    await test('newSession returns a sessionId', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const sid = await c.newSession('/tmp');
        assert.ok(sid && typeof sid === 'string', 'expected non-empty sessionId, got ' + sid);
        c.stop();
    });

    await test('listSessions preserves Hermes session metadata and pagination', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const sid = await c.newSession('/tmp/project');
        const page = await c.listSessions('/tmp/project');
        assert.deepStrictEqual(page, {
            sessions: [{
                sessionId: sid,
                cwd: '/tmp/project',
                title: 'Fake Hermes session',
                updatedAt: '2026-07-16T12:00:00Z',
            }],
            nextCursor: 'page-2',
        });
        c.stop();
    });

    await test('loadSession captures replay updates before becoming active', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        const replay = [];
        c.on('sessionUpdate', (event) => replay.push(event.update));
        await c.start();
        const sid = await c.newSession('/tmp/project');
        await c.loadSession(sid, '/tmp/project');
        assert.strictEqual(c.getSessionId(), sid);
        assert.deepStrictEqual(replay.map((update) => update.sessionUpdate), [
            'user_message_chunk',
            'agent_message_chunk',
        ]);
        c.stop();
    });

    await test('forkSession activates the Hermes-created child session', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const source = await c.newSession('/tmp/project');
        const forked = await c.forkSession(source, '/tmp/project');
        assert.notStrictEqual(forked, source);
        assert.match(forked, /^sess-/);
        assert.strictEqual(c.getSessionId(), forked);
        c.stop();
    });

    await test('prompt streams agent_message_chunk and resolves end_turn', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        const chunks = [];
        c.on('sessionUpdate', (evt) => {
            if (evt.update && evt.update.sessionUpdate === 'agent_message_chunk') {
                chunks.push(evt.update.content.text);
            }
        });
        await c.start();
        await c.newSession('/tmp');
        const result = await c.prompt('hi');
        assert.strictEqual(result.stopReason, 'end_turn');
        assert.strictEqual(chunks.join(''), 'Hello, world!', 'streamed text mismatch: ' + JSON.stringify(chunks));
        c.stop();
    });

    await test('resumeSession returns false when server allocates a new session (regression: blank reply bug)', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const ok = await c.resumeSession('definitely-not-a-real-session-id', '/tmp');
        assert.strictEqual(ok, false, 'resumeSession must reject silent fallback to a fresh session');
        c.stop();
    });

    await test('resumeSession returns true when server confirms the requested id', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const sid = await c.newSession('/tmp');
        const ok = await c.resumeSession(sid, '/tmp');
        assert.strictEqual(ok, true);
        c.stop();
    });

    if (failures > 0) {
        console.error('\n' + failures + ' test(s) failed');
        process.exit(1);
    }
    console.log('\nAll tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
