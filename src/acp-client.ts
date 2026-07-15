import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import * as path from 'path';
import { UsageInfo } from './types';

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface SessionUpdate {
    sessionId: string;
    update: {
        sessionUpdate: string;
        [key: string]: unknown;
    };
}

export interface ToolCall {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    rawInput?: unknown;
    rawOutput?: unknown;
}

export interface PermissionOption {
    optionId: string;
    name: string;
    kind: string;
}

export interface PermissionRequest {
    options?: PermissionOption[];
    toolCall?: { title?: string; kind?: string; [key: string]: unknown };
    [key: string]: unknown;
}

/**
 * Resolves a permission request to the chosen optionId, or `undefined`/`null`
 * to fall back to the safe default (deny).
 */
export type PermissionHandler = (request: PermissionRequest) => Promise<string | undefined | null>;

export function getAcpArgs(profile = 'default'): string[] {
    return profile === 'default' ? ['acp'] : ['-p', profile, 'acp'];
}

interface PendingRequest {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timeout: NodeJS.Timeout;
    method: string;
    idleTimeoutMs?: number;
}

export class AcpClient extends EventEmitter {
    private proc: ChildProcess | null = null;
    private nextId = 1;
    private pendingRequests = new Map<number, PendingRequest>();
    private buffer = '';
    private initialized = false;
    private sessionId: string | null = null;
    private hermesPath: string;
    private requestTimeoutMs: number;
    private streamIdleTimeoutMs: number;
    private stopping = false;

    /**
     * Optional gate for `session/request_permission`. When set, the chosen
     * optionId is sent back to Hermes. When unset (or it resolves to a falsy
     * value), the request is denied by default.
     */
    public permissionHandler: PermissionHandler | null = null;

    constructor(hermesPath: string, requestTimeoutMs = 30_000, streamIdleTimeoutMs = 120_000, private readonly profile = 'default') {
        super();
        this.hermesPath = hermesPath;
        this.requestTimeoutMs = requestTimeoutMs;
        this.streamIdleTimeoutMs = streamIdleTimeoutMs;
    }

    private getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map((folder) => path.resolve(folder.uri.fsPath));
    }

    private assertWorkspacePath(targetPath: string): void {
        const roots = this.getWorkspaceRoots();
        if (!roots.length) {
            throw new Error('Workspace file access is unavailable because no folder is open in VS Code.');
        }

        const normalizedTarget = path.resolve(targetPath);
        const isAllowed = roots.some((root) => {
            const relative = path.relative(root, normalizedTarget);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        });

        if (!isAllowed) {
            throw new Error(`Blocked file access outside the current workspace: ${targetPath}`);
        }
    }

    async start(): Promise<void> {
        if (this.proc) return;

        this.stopping = false;

        this.proc = spawn(this.hermesPath, getAcpArgs(this.profile), {
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.proc.stdout!.on('data', (data: Buffer) => {
            this.buffer += data.toString('utf8');
            this.processBuffer();
        });

        this.proc.stderr!.on('data', (data: Buffer) => {
            this.emit('log', data.toString('utf8'));
        });

        this.proc.on('exit', (code) => {
            if (!this.stopping) {
                this.emit('exit', code);
            }
            this.proc = null;
            this.initialized = false;
            for (const { reject, timeout } of this.pendingRequests.values()) {
                clearTimeout(timeout);
                reject(new Error(`Hermes ACP process exited with code ${code}`));
            }
            this.pendingRequests.clear();
        });

        this.proc.on('error', (err) => {
            this.emit('error', err);
        });

        await this.initialize();
    }

    private processBuffer(): void {
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line) as JsonRpcMessage;
                this.handleMessage(msg);
            } catch (e) {
                this.emit('log', `[parse error] ${line}\n`);
            }
        }
    }

    private handleMessage(msg: JsonRpcMessage): void {
        if ('id' in msg && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                clearTimeout(pending.timeout);
                if ('error' in msg && msg.error) {
                    pending.reject(new Error(msg.error.message));
                } else {
                    pending.resolve((msg as JsonRpcResponse).result);
                }
            }
            return;
        }

        if ('method' in msg) {
            // Notification or server-initiated request
            if ('id' in msg && msg.id !== undefined) {
                this.handleServerRequest(msg as JsonRpcRequest);
            } else {
                this.handleNotification(msg as JsonRpcNotification);
            }
        }
    }

    private handleServerRequest(req: JsonRpcRequest): void {
        const params = req.params as Record<string, unknown> | undefined;

        switch (req.method) {
            case 'session/request_permission': {
                this.emit('permissionRequest', params);
                this.handlePermissionRequest(req.id, params);
                break;
            }

            case 'fs/read_text_file': {
                this.handleReadFile(req.id, params);
                break;
            }

            case 'fs/write_text_file': {
                this.handleWriteFile(req.id, params);
                break;
            }

            default:
                this.sendError(req.id, -32601, `Method not found: ${req.method}`);
        }
    }

    private handleNotification(notif: JsonRpcNotification): void {
        const params = notif.params as Record<string, unknown> | undefined;

        switch (notif.method) {
            case 'session/update':
                if (params) {
                    this.resetIdleTimers();
                    this.emit('sessionUpdate', {
                        sessionId: params.sessionId as string,
                        update: params.update,
                    });
                }
                break;
        }
    }

    private async handlePermissionRequest(id: number, params: Record<string, unknown> | undefined): Promise<void> {
        const options = (params?.options as PermissionOption[] | undefined) ?? [];

        let chosenId: string | undefined | null;
        if (this.permissionHandler) {
            try {
                chosenId = await this.permissionHandler(params as PermissionRequest);
            } catch (e) {
                this.emit('log', `[permission handler error] ${e instanceof Error ? e.message : String(e)}\n`);
                chosenId = undefined;
            }
        }

        if (!chosenId) {
            // No handler, dismissal, or error -> deny by default (fail safe).
            const reject = options.find((o) => o.kind && o.kind.startsWith('reject'));
            chosenId = reject?.optionId;
        }

        if (chosenId) {
            this.sendResponse(id, { outcome: { outcome: 'selected', optionId: chosenId } });
        } else {
            // No explicit reject option advertised; signal cancellation so Hermes
            // does not proceed with the requested action.
            this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
        }
    }

    private async handleReadFile(id: number, params: Record<string, unknown> | undefined): Promise<void> {
        try {
            const path = params?.path as string;
            this.assertWorkspacePath(path);
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
            this.sendResponse(id, { content: Buffer.from(content).toString('utf8') });
        } catch (e) {
            this.sendError(id, -32000, e instanceof Error ? e.message : String(e));
        }
    }

    private async handleWriteFile(id: number, params: Record<string, unknown> | undefined): Promise<void> {
        try {
            const path = params?.path as string;
            const content = params?.content as string;
            this.assertWorkspacePath(path);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(path), Buffer.from(content, 'utf8'));
            this.sendResponse(id, null);
        } catch (e) {
            this.sendError(id, -32000, e instanceof Error ? e.message : String(e));
        }
    }

    private send(msg: JsonRpcMessage): void {
        if (!this.proc || !this.proc.stdin) {
            throw new Error('ACP process not started');
        }
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }

    private sendResponse(id: number, result: unknown): void {
        this.send({ jsonrpc: '2.0', id, result } as JsonRpcResponse);
    }

    private sendError(id: number, code: number, message: string): void {
        this.send({ jsonrpc: '2.0', id, error: { code, message } } as JsonRpcResponse);
    }

    private request<T = unknown>(method: string, params?: unknown, options?: { idleTimeoutMs?: number }): Promise<T> {
        const id = this.nextId++;
        const idleTimeoutMs = options?.idleTimeoutMs;
        const totalTimeoutMs = idleTimeoutMs ?? this.requestTimeoutMs;
        return new Promise<T>((resolve, reject) => {
            const onTimeout = () => {
                this.pendingRequests.delete(id);
                const reason = idleTimeoutMs
                    ? `Hermes ACP stream went silent for ${Math.round(totalTimeoutMs / 1000)}s: ${method}`
                    : `Hermes ACP request timed out after ${Math.round(totalTimeoutMs / 1000)}s: ${method}`;
                reject(new Error(reason));
            };
            const timeout = setTimeout(onTimeout, totalTimeoutMs);

            this.pendingRequests.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
                timeout,
                method,
                idleTimeoutMs,
            });

            try {
                this.send({ jsonrpc: '2.0', id, method, params });
            } catch (err) {
                clearTimeout(timeout);
                this.pendingRequests.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private resetIdleTimers(): void {
        for (const pending of this.pendingRequests.values()) {
            if (pending.idleTimeoutMs === undefined) continue;
            clearTimeout(pending.timeout);
            pending.timeout = setTimeout(() => {
                this.pendingRequests.delete(this.findPendingId(pending) ?? -1);
                pending.reject(new Error(
                    `Hermes ACP stream went silent for ${Math.round(pending.idleTimeoutMs! / 1000)}s: ${pending.method}`,
                ));
            }, pending.idleTimeoutMs);
        }
    }

    private findPendingId(target: PendingRequest): number | null {
        for (const [id, p] of this.pendingRequests) {
            if (p === target) return id;
        }
        return null;
    }

    private async initialize(): Promise<void> {
        await this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: false,
            },
            clientInfo: { name: 'hermes-chat-vscode', version: '0.2.0' },
        });
        this.initialized = true;
    }

    async newSession(cwd: string): Promise<string> {
        const result = await this.request<{ sessionId: string }>('session/new', {
            cwd,
            mcpServers: [],
        });
        this.sessionId = result.sessionId;
        return result.sessionId;
    }

    async resumeSession(sessionId: string, cwd: string): Promise<boolean> {
        try {
            const result = await this.request<{ sessionId?: string }>(
                'session/resume',
                { sessionId, cwd, mcpServers: [] },
            );
            // Hermes silently creates a fresh session when the requested id is unknown
            // and omits sessionId from the response. Treat that as a failed resume so the
            // caller starts a clean session/new instead of prompting against a stale id.
            const returned = result?.sessionId;
            if (!returned || returned !== sessionId) return false;
            this.sessionId = sessionId;
            return true;
        } catch {
            return false;
        }
    }

    async prompt(text: string, sessionId?: string): Promise<{ stopReason: string; usage?: UsageInfo }> {
        const sid = sessionId ?? this.sessionId;
        if (!sid) throw new Error('No active session');
        const result = await this.request<{ stopReason: string; usage?: UsageInfo }>(
            'session/prompt',
            { sessionId: sid, prompt: [{ type: 'text', text }] },
            { idleTimeoutMs: this.streamIdleTimeoutMs },
        );
        return result;
    }

    async cancel(sessionId?: string): Promise<void> {
        const sid = sessionId ?? this.sessionId;
        if (!sid) return;
        // session/cancel is a notification (no response expected)
        this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
    }

    async setModel(modelId: string, sessionId?: string): Promise<void> {
        const sid = sessionId ?? this.sessionId;
        if (!sid) throw new Error('No active session');
        await this.request('session/set_model', { sessionId: sid, modelId });
    }

    isReady(): boolean {
        return this.initialized && this.proc !== null;
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    stop(): void {
        if (this.proc) {
            this.stopping = true;
            this.proc.kill();
            this.proc = null;
        }
        this.initialized = false;
        for (const { reject, timeout } of this.pendingRequests.values()) {
            clearTimeout(timeout);
            reject(new Error('Hermes ACP process stopped'));
        }
        this.pendingRequests.clear();
    }
}
