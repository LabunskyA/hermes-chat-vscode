import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { AcpClient, SessionUpdate, PermissionRequest } from './acp-client';
import { checkInstalled, readConfigState, SetupWizard } from './setup-wizard';
import { ChatMessage, ToolCallInfo, UsageInfo } from './types';
import { UsageStore } from './usage-store';
import { HermesProfile, ProfileStore } from './profile-store';

interface AttachedContextFile {
    path: string;
    label: string;
    content: string;
    truncated: boolean;
}

interface WorkspaceTreeNode {
    id: string;
    label: string;
    kind: 'folder' | 'file';
    path?: string;
    children?: WorkspaceTreeNode[];
}

interface StatusBadgeInfo {
    label: string;
    detail: string;
    level: 'ready' | 'warning';
}

interface StatusDetailsInfo {
    title: string;
    summary: string;
    level: 'ready' | 'warning';
    items: string[];
}

interface ChatHistoryEntry {
    id: string;
    sessionId: string;
    title: string;
    updatedAt: number;
    messages: ChatMessage[];
    profile?: string;
}

export class HermesChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'hermes-chat.chatView';
    public static readonly panelViewType = 'hermes-chat.chatPanel';
    private static readonly maxAttachedFileBytes = 20_000;
    private static readonly maxAttachedFiles = 6;
    private static readonly maxStoredMessages = 500;
    private static readonly maxHistoryEntries = 30;

    private sidebarView?: vscode.WebviewView;
    private panel?: vscode.WebviewPanel;
    private messages: ChatMessage[] = [];
    private sessionId: string | null = null;
    private isProcessing = false;
    private acp: AcpClient | null = null;
    private context: vscode.ExtensionContext;
    private currentAssistantMessage: ChatMessage | null = null;
    private currentToolCalls = new Map<string, ToolCallInfo>();
    private usageStore = new UsageStore();
    private attachedFiles: AttachedContextFile[] = [];
    private resumeFailedNoticeShown = false;
    private replaying = false;
    private replayBuffer: ChatMessage[] = [];
    private replayAssistant: ChatMessage | null = null;
    private restoreAttempted = false;
    private readonly profileStore = new ProfileStore();
    private activeProfile: string;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.activeProfile = context.workspaceState.get('hermes-chat.activeProfile', 'default');
        this.sessionId = context.workspaceState.get(this.sessionKey(), null);
        this.messages = context.workspaceState.get<ChatMessage[]>(this.messagesKey(), []);

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.syncViewState()),
            vscode.window.onDidChangeTextEditorSelection(() => this.syncViewState()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('hermes-chat')) {
                    this.syncViewState();
                }
            }),
        );
    }

    private getHermesPath(): string {
        return vscode.workspace.getConfiguration('hermes-chat').get('hermesPath', 'hermes');
    }

    private getRequestTimeoutMs(): number {
        const seconds = vscode.workspace.getConfiguration('hermes-chat').get('timeout', 30);
        return Math.max(1, seconds) * 1000;
    }

    private getStreamIdleTimeoutMs(): number {
        const seconds = vscode.workspace.getConfiguration('hermes-chat').get('streamIdleTimeout', 120);
        return Math.max(5, seconds) * 1000;
    }

    private sessionKey(profile = this.activeProfile): string {
        return `hermes-chat.sessionId.${profile}`;
    }

    private messagesKey(profile = this.activeProfile): string {
        return `hermes-chat.messages.${profile}`;
    }

    private appendMessage(message: ChatMessage): void {
        this.messages.push(message);
        const max = HermesChatViewProvider.maxStoredMessages;
        if (this.messages.length > max) {
            this.messages.splice(0, this.messages.length - max);
        }
        void this.context.workspaceState.update(this.messagesKey(), this.messages);
        this.persistCurrentSession();
    }

    private getHistory(): ChatHistoryEntry[] {
        return this.context.workspaceState.get<ChatHistoryEntry[]>('hermes-chat.history', []);
    }

    private persistCurrentSession(): void {
        if (!this.sessionId || !this.messages.length) return;
        const firstUserMessage = this.messages.find((message) => message.role === 'user')?.content.trim();
        const title = (firstUserMessage || 'Untitled chat').replace(/\s+/g, ' ').slice(0, 56);
        const history = this.getHistory();
        const existing = history.findIndex((entry) => entry.sessionId === this.sessionId && (entry.profile || 'default') === this.activeProfile);
        const entry: ChatHistoryEntry = {
            id: this.sessionId,
            sessionId: this.sessionId,
            title,
            updatedAt: Date.now(),
            messages: this.messages.slice(-HermesChatViewProvider.maxStoredMessages),
            profile: this.activeProfile,
        };
        if (existing >= 0) history.splice(existing, 1);
        history.unshift(entry);
        void this.context.workspaceState.update('hermes-chat.history', history.slice(0, HermesChatViewProvider.maxHistoryEntries));
        this.postMessage({ type: 'historyChanged', history: this.getHistorySummary(history) });
    }

    private getHistorySummary(history = this.getHistory()): Omit<ChatHistoryEntry, 'messages'>[] {
        return history.filter((entry) => (entry.profile || 'default') === this.activeProfile).map(({ messages: _messages, ...entry }) => entry);
    }

    private getProfiles(): HermesProfile[] {
        return this.profileStore.list();
    }

    private getProfileHome(): string {
        return this.activeProfile === 'default'
            ? this.getHermesHome()
            : path.join(this.getHermesHome(), 'profiles', this.activeProfile);
    }

    private async switchProfile(profile: string): Promise<void> {
        if (this.isProcessing || profile === this.activeProfile) return;
        if (!this.getProfiles().some((item) => item.name === profile)) return;
        this.persistCurrentSession();
        await this.context.workspaceState.update(this.messagesKey(), this.messages);
        this.acp?.stop();
        this.acp = null;
        this.activeProfile = profile;
        this.sessionId = this.context.workspaceState.get(this.sessionKey(), null);
        this.messages = this.context.workspaceState.get<ChatMessage[]>(this.messagesKey(), []);
        this.currentAssistantMessage = null;
        this.currentToolCalls.clear();
        this.restoreAttempted = false;
        this.resumeFailedNoticeShown = false;
        await this.context.workspaceState.update('hermes-chat.activeProfile', profile);
        this.postMessage({ type: 'replaceMessages', messages: this.messages });
        this.postMessage({ type: 'historyChanged', history: this.getHistorySummary() });
        this.syncViewState();
        void this.eagerlyRestoreSession();
    }

    private runHermes(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.getHermesPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf8'); });
            child.on('error', reject);
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Hermes exited with code ${code}`)));
        });
    }

    private async createProfile(name: string, description: string, source?: string): Promise<void> {
        const normalizedName = name.trim().toLowerCase();
        if (!this.profileStore.isValidName(normalizedName)) {
            throw new Error('Agent names must start with a letter and use 2–32 lowercase letters, numbers, or hyphens.');
        }
        if (this.getProfiles().some((profile) => profile.name === normalizedName)) {
            throw new Error(`Agent “${normalizedName}” already exists.`);
        }
        const args = ['profile', 'create', normalizedName];
        if (source && this.getProfiles().some((profile) => profile.name === source)) args.push('--clone-from', source);
        if (description.trim()) args.push('--description', description.trim().slice(0, 240));
        await this.runHermes(args);
        await this.switchProfile(normalizedName);
    }

    private async openHistoryEntry(id: string): Promise<void> {
        const entry = this.getHistory().find((item) => item.id === id);
        if (!entry || (entry.profile || 'default') !== this.activeProfile) return;
        this.acp?.stop();
        this.acp = null;
        this.sessionId = entry.sessionId;
        this.messages = entry.messages;
        await this.context.workspaceState.update(this.sessionKey(), this.sessionId);
        this.postMessage({ type: 'replaceMessages', messages: this.messages });
        this.syncViewState();
    }

    private async ensureAcp(): Promise<AcpClient> {
        if (this.acp && this.acp.isReady()) return this.acp;

        if (this.acp) this.acp.stop();

        const client = new AcpClient(this.getHermesPath(), this.getRequestTimeoutMs(), this.getStreamIdleTimeoutMs(), this.activeProfile);
        client.on('sessionUpdate', (evt: SessionUpdate) => this.handleSessionUpdate(evt));
        client.permissionHandler = (request) => this.promptPermission(request);
        client.on('exit', (code: number | null) => {
            this.postMessage({ type: 'showError', error: `Hermes ACP exited (code ${code}). Will restart on next message.` });
            this.acp = null;
        });
        client.on('error', (err: Error) => {
            this.postMessage({ type: 'showError', error: `Hermes error: ${err.message}` });
        });

        await client.start();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        if (this.sessionId) {
            this.beginReplay();
            const ok = await client.resumeSession(this.sessionId, cwd);
            this.endReplay(ok);
            if (!ok) {
                if (!this.resumeFailedNoticeShown) {
                    void vscode.window.showWarningMessage(
                        'The previous Hermes session could not be restored. A new session was started, so cross-turn recall may be incomplete until session search is used.',
                    );
                    this.resumeFailedNoticeShown = true;
                }
                this.sessionId = await client.newSession(cwd);
                this.context.workspaceState.update(this.sessionKey(), this.sessionId);
            }
        } else {
            this.sessionId = await client.newSession(cwd);
            this.context.workspaceState.update(this.sessionKey(), this.sessionId);
        }

        this.acp = client;
        this.syncViewState();
        return client;
    }

    private getWorkspaceCwd(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    }

    private getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
        return vscode.workspace.workspaceFolders || [];
    }

    private getHermesHome(): string {
        return path.join(os.homedir(), '.hermes');
    }

    private readHermesConfigText(): string {
        const configPath = path.join(this.getProfileHome(), 'config.yaml');
        try {
            return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
        } catch {
            return '';
        }
    }

    private getConfigValue(section: string, key: string): string | null {
        const text = this.readHermesConfigText();
        if (!text) return null;
        const lines = text.split('\n');
        let inSection = false;
        for (const line of lines) {
            if (new RegExp(`^${section}\\s*:`).test(line)) {
                inSection = true;
                continue;
            }
            if (inSection && /^\S/.test(line)) {
                inSection = false;
                continue;
            }
            if (inSection) {
                const match = line.match(new RegExp(`^\\s+${key}\\s*:\\s*(.+)`));
                if (match) return match[1].replace(/^['"]|['"]$/g, '').trim();
            }
        }
        return null;
    }

    private getRecallStatus(): StatusBadgeInfo {
        const stateDbPath = path.join(this.getProfileHome(), 'state.db');
        if (this.resumeFailedNoticeShown) {
            return {
                label: 'Recall',
                detail: 'Session restore failed',
                level: 'warning',
            };
        }
        if (fs.existsSync(stateDbPath)) {
            return {
                label: 'Recall',
                detail: 'Session DB ready',
                level: 'ready',
            };
        }
        return {
            label: 'Recall',
            detail: 'No session DB yet',
            level: 'warning',
        };
    }

    private getRecallDetails(): StatusDetailsInfo {
        const stateDbPath = path.join(this.getProfileHome(), 'state.db');
        const items = [
            `Session ID: ${this.sessionId || 'none'}`,
            `State DB: ${stateDbPath}${fs.existsSync(stateDbPath) ? ' (present)' : ' (missing)'}`,
            `Resume warning shown: ${this.resumeFailedNoticeShown ? 'yes' : 'no'}`,
        ];
        if (this.resumeFailedNoticeShown) {
            items.push('The most recent ACP restore attempt failed, so this editor session started a new Hermes session.');
        }
        return {
            title: 'Recall Diagnostics',
            summary: fs.existsSync(stateDbPath) && !this.resumeFailedNoticeShown
                ? 'Session history storage looks available.'
                : 'Session recall is degraded or not initialized.',
            level: this.getRecallStatus().level,
            items,
        };
    }

    private getMemoryStatus(): StatusBadgeInfo {
        const memoryProvider = this.getConfigValue('memory', 'provider');
        if (memoryProvider) {
            return {
                label: 'Memory',
                detail: memoryProvider,
                level: 'ready',
            };
        }

        const hermesHome = this.getProfileHome();
        const memoryFiles = [
            path.join(hermesHome, 'memories', 'USER.md'),
            path.join(hermesHome, 'memories', 'MEMORY.md'),
            path.join(hermesHome, 'SOUL.md'),
        ];
        if (memoryFiles.some((file) => fs.existsSync(file))) {
            return {
                label: 'Memory',
                detail: 'Local memory files',
                level: 'ready',
            };
        }

        return {
            label: 'Memory',
            detail: 'Not initialized',
            level: 'warning',
        };
    }

    private getMemoryDetails(): StatusDetailsInfo {
        const memoryProvider = this.getConfigValue('memory', 'provider');
        const hermesHome = this.getProfileHome();
        const memoryFiles = [
            path.join(hermesHome, 'memories', 'USER.md'),
            path.join(hermesHome, 'memories', 'MEMORY.md'),
            path.join(hermesHome, 'SOUL.md'),
        ];
        const presentFiles = memoryFiles.filter((file) => fs.existsSync(file));
        return {
            title: 'Memory Diagnostics',
            summary: memoryProvider
                ? `Configured provider: ${memoryProvider}`
                : presentFiles.length
                    ? 'Using local memory files.'
                    : 'No memory provider or local memory files detected.',
            level: this.getMemoryStatus().level,
            items: [
                `Configured provider: ${memoryProvider || 'none'}`,
                `Local memory files: ${presentFiles.length ? presentFiles.map((file) => path.basename(file)).join(', ') : 'none'}`,
                `Hermes home: ${hermesHome}`,
            ],
        };
    }

    private inferToolFailure(rawOutput: unknown): boolean {
        if (rawOutput == null) return false;
        const text = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
                if (parsed.success === false) return true;
                if (typeof parsed.error === 'string' && parsed.error.trim()) return true;
            }
        } catch {
            // Ignore non-JSON tool output.
        }
        return false;
    }

    private async loadAttachedFile(uri: vscode.Uri): Promise<AttachedContextFile> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const truncated = bytes.byteLength > HermesChatViewProvider.maxAttachedFileBytes;
        const contentBytes = truncated ? bytes.slice(0, HermesChatViewProvider.maxAttachedFileBytes) : bytes;
        const content = new TextDecoder('utf-8', { fatal: false }).decode(contentBytes);
        return {
            path: uri.fsPath,
            label: vscode.workspace.asRelativePath(uri),
            content,
            truncated,
        };
    }

    private async getWorkspaceFileCandidates(): Promise<vscode.Uri[]> {
        return vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,.next,dist,build,out,coverage,venv,.venv}/**',
            2000,
        );
    }

    private async buildWorkspaceTree(): Promise<WorkspaceTreeNode[]> {
        const folders = this.getWorkspaceFolders();
        const candidates = await this.getWorkspaceFileCandidates();
        const trees = new Map<string, WorkspaceTreeNode>();

        for (const folder of folders) {
            trees.set(folder.uri.fsPath, {
                id: folder.uri.fsPath,
                label: folder.name,
                kind: 'folder',
                children: [],
            });
        }

        for (const uri of candidates) {
            const folder = folders.find((item) => uri.fsPath.startsWith(item.uri.fsPath));
            if (!folder) continue;

            const relative = path.relative(folder.uri.fsPath, uri.fsPath);
            const segments = relative.split(/[\\/]/).filter(Boolean);
            if (!segments.length) continue;

            let current: WorkspaceTreeNode | undefined = trees.get(folder.uri.fsPath);
            if (!current || !current.children) continue;

            const pathParts = [folder.name];
            for (let index = 0; index < segments.length; index++) {
                if (!current.children) break;
                const segment = segments[index];
                pathParts.push(segment);
                const isFile = index === segments.length - 1;
                let next: WorkspaceTreeNode | undefined = current.children.find(
                    (child) => child.label === segment && child.kind === (isFile ? 'file' : 'folder'),
                );
                if (!next) {
                    next = {
                        id: `${folder.uri.fsPath}:${pathParts.join('/')}`,
                        label: segment,
                        kind: isFile ? 'file' : 'folder',
                        path: isFile ? uri.fsPath : undefined,
                        children: isFile ? undefined : [],
                    };
                    current.children.push(next);
                    current.children.sort((a, b) => {
                        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
                        return a.label.localeCompare(b.label);
                    });
                }
                current = next;
            }
        }

        return Array.from(trees.values());
    }

    private async attachFileByPath(filePath: string): Promise<void> {
        if (this.attachedFiles.some((file) => file.path === filePath)) return;
        if (this.attachedFiles.length >= HermesChatViewProvider.maxAttachedFiles) {
            void vscode.window.showWarningMessage(`You can attach up to ${HermesChatViewProvider.maxAttachedFiles} files per message context.`);
            return;
        }

        try {
            const file = await this.loadAttachedFile(vscode.Uri.file(filePath));
            this.attachedFiles.push(file);
            this.postMessage({ type: 'attachmentsChanged', files: this.attachedFiles });
            this.syncViewState();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`Failed to attach ${vscode.workspace.asRelativePath(vscode.Uri.file(filePath))}: ${message}`);
        }
    }

    private async toggleAttachedFile(filePath: string, checked: boolean): Promise<void> {
        if (checked) {
            await this.attachFileByPath(filePath);
            return;
        }
        this.removeAttachedFile(filePath);
    }

    private removeAttachedFile(filePath: string): void {
        this.attachedFiles = this.attachedFiles.filter((file) => file.path !== filePath);
        this.postMessage({ type: 'attachmentsChanged', files: this.attachedFiles });
        this.syncViewState();
    }

    private clearAttachedFiles(): void {
        if (!this.attachedFiles.length) return;
        this.attachedFiles = [];
        this.postMessage({ type: 'attachmentsChanged', files: [] });
        this.syncViewState();
    }

    private getEditorContextInfo(): Record<string, unknown> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            const workspaceName = vscode.workspace.workspaceFolders?.map((folder) => folder.name).join(', ');
            return {
                fileLabel: workspaceName ? `Workspace: ${workspaceName}` : 'No workspace open',
                detail: this.attachedFiles.length
                    ? `${this.attachedFiles.length} attached file${this.attachedFiles.length === 1 ? '' : 's'} will be included.`
                    : workspaceName
                        ? 'No active file selected. Hermes can search and read this workspace.'
                        : 'Open a folder to give Hermes workspace access.',
                hasSelection: false,
            };
        }

        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        if (!selectedText) {
            return {
                fileLabel: filePath,
                detail: this.attachedFiles.length
                    ? `Active file plus ${this.attachedFiles.length} attached file${this.attachedFiles.length === 1 ? '' : 's'}.`
                    : 'Active file will be included automatically.',
                hasSelection: false,
            };
        }

        const selectedLines = selection.end.line - selection.start.line + 1;
        return {
            fileLabel: filePath,
            detail: `${selectedLines} selected line${selectedLines === 1 ? '' : 's'} in ${editor.document.languageId}${this.attachedFiles.length ? ` plus ${this.attachedFiles.length} attachment${this.attachedFiles.length === 1 ? '' : 's'}` : ''}`,
            hasSelection: true,
        };
    }

    private isHistoryRecallQuery(text: string): boolean {
        return /上次聊天|上次.*聊|之前聊过|之前说过|还记得|什么时候聊过|last chat|previous chat|earlier chat|remember when|when did we talk|last time/i.test(text);
    }

    private getViewStatePayload(): Record<string, unknown> {
        return {
            sessionId: this.sessionId,
            isProcessing: this.isProcessing,
            contextInfo: this.getEditorContextInfo(),
            recallStatus: this.getRecallStatus(),
            memoryStatus: this.getMemoryStatus(),
            recallDetails: this.getRecallDetails(),
            memoryDetails: this.getMemoryDetails(),
            profiles: this.getProfiles(),
            activeProfile: this.activeProfile,
            profileSettings: this.profileStore.getSettings(this.activeProfile),
            attachedFiles: this.attachedFiles.map((file) => ({
                path: file.path,
                label: file.label,
                truncated: file.truncated,
            })),
        };
    }

    private getInitialWebviewState(mode: 'sidebar' | 'panel'): Record<string, unknown> {
        return {
            mode,
            messages: this.messages,
            currentAssistantMessage: this.currentAssistantMessage,
            workspaceTree: [],
            setupCompleted: this.context.globalState.get<boolean>('hermes-chat.setupCompleted', false),
            history: this.getHistorySummary(),
            profiles: this.getProfiles(),
            activeProfile: this.activeProfile,
            ...this.getViewStatePayload(),
        };
    }

    private async refreshWorkspaceTree(): Promise<void> {
        try {
            const tree = await this.buildWorkspaceTree();
            this.postMessage({ type: 'workspaceTree', tree });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.postMessage({ type: 'showError', error: `Failed to load workspace tree: ${message}` });
        }
    }

    private syncViewState(): void {
        this.postMessage({
            type: 'stateSync',
            ...this.getViewStatePayload(),
        });
    }

    private wireWebview(webview: vscode.Webview): vscode.Disposable {
        webview.options = { enableScripts: true };
        return webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'sendMessage':
                    await this.handleUserMessage(message.text);
                    break;
                case 'newSession':
                    await this.newSession();
                    break;
                case 'clearChat':
                    this.clearChat();
                    break;
                case 'cancel':
                    this.acp?.cancel();
                    break;
                case 'openPanel':
                    this.openPanel();
                    break;
                case 'openHistory':
                    if (typeof message.id === 'string') await this.openHistoryEntry(message.id);
                    break;
                case 'switchProfile':
                    if (typeof message.profile === 'string') await this.switchProfile(message.profile);
                    break;
                case 'createProfile':
                    try {
                        await this.createProfile(String(message.name || ''), String(message.description || ''), typeof message.source === 'string' ? message.source : undefined);
                        this.postMessage({ type: 'profileCreated', ok: true, profile: this.activeProfile });
                        this.postMessage({ type: 'profilesChanged', profiles: this.getProfiles(), activeProfile: this.activeProfile });
                    } catch (error) {
                        this.postMessage({ type: 'profileCreated', ok: false, error: error instanceof Error ? error.message : String(error) });
                    }
                    break;
                case 'setupActiveProfile': {
                    this.postMessage({ type: 'openSettingsPage', settings: this.profileStore.getSettings(this.activeProfile), profile: this.activeProfile });
                    break;
                }
                case 'saveProfileSettings': {
                    try {
                        const settings = this.profileStore.saveSettings(
                            this.activeProfile,
                            String(message.provider || ''),
                            String(message.model || ''),
                            typeof message.apiKey === 'string' ? message.apiKey : undefined,
                        );
                        this.acp?.stop();
                        this.acp = null;
                        this.postMessage({ type: 'profileSettingsSaved', ok: true, settings });
                        this.postMessage({ type: 'profilesChanged', profiles: this.getProfiles(), activeProfile: this.activeProfile });
                        this.syncViewState();
                    } catch (error) {
                        this.postMessage({ type: 'profileSettingsSaved', ok: false, error: error instanceof Error ? error.message : String(error) });
                    }
                    break;
                }
                case 'openExtensionSettings':
                    void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Poppywu124.hermes-chat');
                    break;
                case 'openMemoryFile': {
                    const allowedFiles: Record<string, string> = {
                        user: path.join(this.getProfileHome(), 'memories', 'USER.md'),
                        memory: path.join(this.getProfileHome(), 'memories', 'MEMORY.md'),
                        soul: path.join(this.getProfileHome(), 'SOUL.md'),
                    };
                    const filePath = allowedFiles[message.file];
                    if (filePath) void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
                    break;
                }
                case 'toggleAttachment':
                    if (typeof message.path === 'string') {
                        await this.toggleAttachedFile(message.path, Boolean(message.checked));
                    }
                    break;
                case 'removeAttachment':
                    if (typeof message.path === 'string') this.removeAttachedFile(message.path);
                    break;
                case 'clearAttachments':
                    this.clearAttachedFiles();
                    break;
                case 'runSetup':
                    void vscode.commands.executeCommand('hermes-chat.runSetup');
                    break;
                case 'openReferral':
                    void vscode.commands.executeCommand('hermes-chat.getApiKey');
                    break;
                case 'copyInstallCmd':
                    void vscode.env.clipboard.writeText('curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash');
                    this.postMessage({ type: 'installStatus', ok: false, text: 'Copied to clipboard. Paste into your terminal and run.' });
                    break;
                case 'checkInstall':
                    void checkInstalled().then((ok) => {
                        this.postMessage({ type: 'installStatus', ok, text: ok ? 'Hermes CLI detected.' : 'Hermes not found. Install it first.' });
                    });
                    break;
                case 'checkProvider': {
                    const installed = await checkInstalled();
                    if (!installed) {
                        this.postMessage({ type: 'providerStatus', ok: false, text: 'Install Hermes CLI first.' });
                        break;
                    }
                    const cfg = readConfigState();
                    if (cfg.providerConfigured) {
                        this.postMessage({ type: 'providerStatus', ok: true, text: `Configured: ${cfg.activeProvider}` });
                        await this.context.globalState.update('hermes-chat.setupCompleted', true);
                        void vscode.commands.executeCommand('setContext', 'hermes-chat.setupCompleted', true);
                    } else {
                        this.postMessage({ type: 'providerStatus', ok: false, text: 'No provider configured yet. Run hermes setup.' });
                    }
                    break;
                }
            }
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.sidebarView = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml('sidebar');

        const messageSub = this.wireWebview(webviewView.webview);
        webviewView.onDidDispose(() => {
            if (this.sidebarView === webviewView) this.sidebarView = undefined;
            messageSub.dispose();
        });

        this.syncViewState();
        void this.refreshWorkspaceTree();

        if (!this.context.globalState.get<boolean>('hermes-chat.setupCompleted', false)) {
            void checkInstalled().then((ok) => {
                if (ok) this.postMessage({ type: 'installStatus', ok: true, text: 'Hermes CLI detected.' });
            });
        }

        void this.eagerlyRestoreSession();
    }

    /**
     * When a prior session exists but no transcript is loaded yet, start the ACP
     * client eagerly so Hermes can replay the conversation history into the view.
     * Runs at most once; fresh sessions stay lazy to avoid spawning Hermes for
     * users who open the panel without chatting.
     */
    private async eagerlyRestoreSession(): Promise<void> {
        if (this.restoreAttempted) return;
        if (!this.sessionId) return;
        if (this.messages.length) return;
        this.restoreAttempted = true;
        try {
            await this.ensureAcp();
        } catch {
            // Ignore; the session will be (re)established on the next message.
        }
    }

    openPanel(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, true);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            HermesChatViewProvider.panelViewType,
            'Hermes Chat',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );
        this.panel.webview.html = this.getHtml('panel');
        const messageSub = this.wireWebview(this.panel.webview);
        this.panel.onDidDispose(() => {
            messageSub.dispose();
            this.panel = undefined;
        });
        this.syncViewState();
        void this.refreshWorkspaceTree();
    }

    async handleUserMessage(text: string) {
        if (!text.trim()) return;

        if (this.isProcessing) {
            // Cursor-style auto-interrupt: cancel current prompt, wait for it to finish, then send new one.
            try {
                await this.acp?.cancel();
            } catch {
                // ignore cancel errors; the in-flight prompt will still reject and clear isProcessing
            }
            const start = Date.now();
            while (this.isProcessing && Date.now() - start < 5000) {
                await new Promise((r) => setTimeout(r, 50));
            }
            if (this.isProcessing) {
                this.postMessage({ type: 'showError', error: 'Could not interrupt the current response in time. Please try again.' });
                return;
            }
        }

        const query = this.buildQueryWithContext(text);
        const userMessage: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
        this.appendMessage(userMessage);
        this.postMessage({ type: 'addMessage', message: userMessage });

        this.isProcessing = true;
        this.postMessage({ type: 'setLoading', loading: true });
        this.syncViewState();

        // Prepare new assistant message for streaming
        this.currentAssistantMessage = {
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [],
        };
        this.currentToolCalls.clear();
        this.postMessage({ type: 'startAssistantMessage', timestamp: this.currentAssistantMessage.timestamp });

        try {
            const client = await this.ensureAcp();
            const result = await client.prompt(query, this.sessionId ?? undefined);

            if (this.currentAssistantMessage) {
                this.currentAssistantMessage.usage = result.usage;
                this.appendMessage(this.currentAssistantMessage);
                this.postMessage({ type: 'finalizeAssistantMessage', usage: result.usage });
                if (result.usage) void this.usageStore.record(result.usage);
            }
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.postMessage({ type: 'showError', error: errorMsg });
        } finally {
            this.isProcessing = false;
            this.currentAssistantMessage = null;
            this.postMessage({ type: 'setLoading', loading: false });
            this.syncViewState();
        }
    }

    private handleSessionUpdate(evt: SessionUpdate): void {
        const update = evt.update;
        const kind = update.sessionUpdate;

        if (this.replaying) {
            this.handleReplayUpdate(update);
            return;
        }

        switch (kind) {
            case 'agent_message_chunk': {
                const content = update.content as { type: string; text?: string } | undefined;
                if (content?.type === 'text' && content.text) {
                    if (this.currentAssistantMessage) {
                        this.currentAssistantMessage.content += content.text;
                    }
                    this.postMessage({ type: 'appendAssistantText', text: content.text });
                }
                break;
            }
            case 'agent_thought_chunk': {
                const content = update.content as { type: string; text?: string } | undefined;
                if (content?.type === 'text' && content.text) {
                    this.postMessage({ type: 'appendThought', text: content.text });
                }
                break;
            }
            case 'tool_call': {
                const tc: ToolCallInfo = {
                    id: update.toolCallId as string,
                    name: (update.title as string) || (update.kind as string) || 'tool',
                    status: (update.status as ToolCallInfo['status']) || 'in_progress',
                    args: update.rawInput,
                };
                this.currentToolCalls.set(tc.id, tc);
                if (this.currentAssistantMessage) {
                    this.currentAssistantMessage.toolCalls?.push(tc);
                }
                this.postMessage({ type: 'toolCall', tool: tc });
                break;
            }
            case 'tool_call_update': {
                const id = update.toolCallId as string;
                const existing = this.currentToolCalls.get(id);
                if (existing) {
                    if (update.status) existing.status = update.status as ToolCallInfo['status'];
                    if (update.rawOutput !== undefined) {
                        existing.result = typeof update.rawOutput === 'string'
                            ? update.rawOutput
                            : JSON.stringify(update.rawOutput);
                        if (this.inferToolFailure(update.rawOutput)) {
                            existing.status = 'failed';
                        }
                    }
                    this.postMessage({ type: 'toolCallUpdate', tool: existing });
                }
                break;
            }
            case 'usage_update': {
                const usage = update.usage as UsageInfo | undefined;
                if (usage) this.postMessage({ type: 'usageUpdate', usage });
                break;
            }
        }
    }

    private beginReplay(): void {
        this.replaying = true;
        this.replayBuffer = [];
        this.replayAssistant = null;
    }

    private endReplay(restored: boolean): void {
        this.flushReplayAssistant();
        this.replaying = false;
        if (restored && this.replayBuffer.length) {
            const max = HermesChatViewProvider.maxStoredMessages;
            this.messages = this.replayBuffer.slice(-max);
            void this.context.workspaceState.update(this.messagesKey(), this.messages);
            this.postMessage({ type: 'replaceMessages', messages: this.messages });
            this.syncViewState();
        }
        this.replayBuffer = [];
        this.replayAssistant = null;
    }

    private flushReplayAssistant(): void {
        if (this.replayAssistant) {
            this.replayBuffer.push(this.replayAssistant);
            this.replayAssistant = null;
        }
    }

    private ensureReplayAssistant(): ChatMessage {
        if (!this.replayAssistant) {
            this.replayAssistant = { role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [] };
        }
        return this.replayAssistant;
    }

    private handleReplayUpdate(update: SessionUpdate['update']): void {
        const kind = update.sessionUpdate;
        switch (kind) {
            case 'user_message_chunk': {
                // History replay sends each prior message as a single full chunk.
                this.flushReplayAssistant();
                const content = update.content as { type: string; text?: string } | undefined;
                const text = content?.type === 'text' ? content.text ?? '' : '';
                this.replayBuffer.push({ role: 'user', content: text, timestamp: Date.now() });
                break;
            }
            case 'agent_message_chunk': {
                const content = update.content as { type: string; text?: string } | undefined;
                if (content?.type === 'text' && content.text) {
                    this.ensureReplayAssistant().content += content.text;
                }
                break;
            }
            case 'agent_thought_chunk': {
                // Reasoning is not persisted into the rendered history content,
                // but its arrival marks the start of an assistant turn.
                this.ensureReplayAssistant();
                break;
            }
            case 'tool_call': {
                const tc: ToolCallInfo = {
                    id: update.toolCallId as string,
                    name: (update.title as string) || (update.kind as string) || 'tool',
                    status: (update.status as ToolCallInfo['status']) || 'completed',
                    args: update.rawInput,
                };
                this.ensureReplayAssistant().toolCalls?.push(tc);
                break;
            }
            case 'tool_call_update': {
                const id = update.toolCallId as string;
                const existing = this.replayAssistant?.toolCalls?.find((t) => t.id === id);
                if (existing) {
                    if (update.status) existing.status = update.status as ToolCallInfo['status'];
                    if (update.rawOutput !== undefined) {
                        existing.result = typeof update.rawOutput === 'string'
                            ? update.rawOutput
                            : JSON.stringify(update.rawOutput);
                        if (this.inferToolFailure(update.rawOutput)) {
                            existing.status = 'failed';
                        }
                    }
                }
                break;
            }
        }
    }

    /**
     * Gate a Hermes `session/request_permission`. Returns the chosen optionId,
     * or `undefined` to deny (the ACP client falls back to a reject option).
     */
    private async promptPermission(request: PermissionRequest): Promise<string | undefined> {
        const options = request.options ?? [];
        if (!options.length) return undefined;

        const autoApprove = vscode.workspace.getConfiguration('hermes-chat').get('autoApproveTools', false);
        if (autoApprove) {
            const allow = options.find((o) => o.kind === 'allow_always')
                ?? options.find((o) => o.kind === 'allow_once')
                ?? options.find((o) => o.kind?.startsWith('allow'));
            return (allow ?? options[0]).optionId;
        }

        const allowOnce = options.find((o) => o.kind === 'allow_once');
        const allowAlways = options.find((o) => o.kind === 'allow_always');
        const reject = options.find((o) => o.kind?.startsWith('reject'));

        const buttons: { label: string; optionId: string }[] = [];
        if (allowOnce) buttons.push({ label: 'Allow once', optionId: allowOnce.optionId });
        if (allowAlways) buttons.push({ label: 'Always allow', optionId: allowAlways.optionId });
        if (reject) buttons.push({ label: 'Deny', optionId: reject.optionId });
        if (!buttons.length) {
            // Fall back to whatever options were advertised.
            for (const o of options) buttons.push({ label: o.name || o.optionId, optionId: o.optionId });
        }

        const title = request.toolCall?.title || 'Hermes wants to perform an action';
        const choice = await vscode.window.showWarningMessage(
            `Hermes permission request: ${title}`,
            { modal: true, detail: 'Allow Hermes to perform this action in your workspace?' },
            ...buttons.map((b) => b.label),
        );
        if (!choice) return undefined; // dismissed -> deny
        return buttons.find((b) => b.label === choice)?.optionId;
    }

    async newSession() {
        this.persistCurrentSession();
        if (this.acp) {
            this.acp.stop();
            this.acp = null;
        }
        this.sessionId = null;
        this.messages = [];
        this.attachedFiles = [];
        this.context.workspaceState.update(this.sessionKey(), null);
        this.context.workspaceState.update(this.messagesKey(), []);
        this.postMessage({ type: 'clearMessages' });
        this.postMessage({ type: 'attachmentsChanged', files: [] });
        this.syncViewState();
    }

    clearChat() {
        this.messages = [];
        void this.context.workspaceState.update(this.messagesKey(), []);
        this.postMessage({ type: 'clearMessages' });
        this.syncViewState();
    }

    private buildQueryWithContext(text: string): string {
        const editor = vscode.window.activeTextEditor;
        const sections: string[] = [`[Workspace: ${this.getWorkspaceCwd()}]`];

        if (editor) {
            const filePath = vscode.workspace.asRelativePath(editor.document.uri);
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            sections.push(`[File: ${filePath}]`);
            if (selectedText) {
                const lang = editor.document.languageId;
                sections.push(`[Selected code:]\n\`\`\`${lang}\n${selectedText}\n\`\`\``);
            }
        }

        if (this.attachedFiles.length) {
            for (const file of this.attachedFiles) {
                const ext = file.label.split('.').pop() || 'text';
                const truncationNote = file.truncated ? '\n[Note: truncated to fit context limit]' : '';
                sections.push(`[Attached file: ${file.label}]\n\`\`\`${ext}\n${file.content}\n\`\`\`${truncationNote}`);
            }
        }

        if (this.isHistoryRecallQuery(text)) {
            sections.push('[History recall instruction: If the user is asking about previous conversations or exact timing, use session_search before answering. Do not guess or claim the session database is unavailable unless a tool call actually failed and you state that concrete tool result.]');
        }

        sections.push(text);
        return sections.join('\n\n');
    }

    private postMessage(message: Record<string, unknown>) {
        const targets = [this.sidebarView?.webview, this.panel?.webview].filter((webview): webview is vscode.Webview => Boolean(webview));
        for (const target of targets) {
            void target.postMessage(message);
        }
    }

    async switchModel(modelId: string): Promise<void> {
        const client = await this.ensureAcp();
        await client.setModel(modelId, this.sessionId ?? undefined);
    }

    dispose() {
        this.acp?.stop();
    }

    private getHtml(mode: 'sidebar' | 'panel'): string {
        const nonce = getNonce();
        const initialState = JSON.stringify(this.getInitialWebviewState(mode)).replace(/</g, '\\u003c');
        return /*html*/ `<!DOCTYPE html>
<html lang="en" data-mode="${mode}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.sidebarView?.webview.cspSource || this.panel?.webview.cspSource} https: data:; style-src ${this.sidebarView?.webview.cspSource || this.panel?.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
}

html[data-mode="panel"] body {
    background: var(--vscode-editor-background);
}

#shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
}

#topbar {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-editor-background) 8%);
}

.topbar-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.title-group {
    min-width: 0;
}

.title {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground);
}

.subtitle {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

.toolbar-btn {
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
}

.toolbar-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
}

#open-panel-btn {
    display: inline-flex;
}

html[data-mode="panel"] #open-panel-btn {
    display: none;
}

#status-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
}

.pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 11px;
    border: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-badge-background, rgba(127,127,127,0.14));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    min-width: 0;
}

.pill.toggleable {
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
}

.pill.toggleable:hover {
    border-color: var(--vscode-focusBorder, var(--vscode-widget-border, #444));
}

.pill.toggleable:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
}

.pill.active {
    border-color: var(--vscode-focusBorder, var(--vscode-widget-border, #444));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 35%, transparent);
}

.pill strong {
    font-weight: 600;
}

.pill.session-active {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a34) 18%, transparent);
}

.pill.session-idle {
    background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent);
}

.pill.context-selected {
    background: color-mix(in srgb, var(--vscode-progressBar-background, #0e639c) 18%, transparent);
}

.pill.ready {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a34) 18%, transparent);
}

.pill.warning {
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 18%, transparent);
}

#status-diagnostics {
    display: none;
    margin-top: 8px;
    padding: 10px 12px;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background) 12%);
    font-size: 12px;
}

#status-diagnostics.visible {
    display: block;
}

#status-diagnostics.ready {
    border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a34) 45%, var(--vscode-widget-border, #444));
}

#status-diagnostics.warning {
    border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 45%, var(--vscode-widget-border, #444));
}

.diagnostics-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
}

.diagnostics-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
}

.diagnostics-close {
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0;
}

.diagnostics-close:hover {
    color: var(--vscode-foreground);
}

.diagnostics-summary {
    color: var(--vscode-descriptionForeground);
    line-height: 1.45;
}

.diagnostics-list {
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--vscode-foreground);
}

.diagnostics-list li + li {
    margin-top: 4px;
}

#messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

html[data-mode="panel"] #messages {
    padding: 18px 24px;
}

.message {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 100%;
}

.message-bubble {
    padding: 10px 12px;
    border-radius: 8px;
    max-width: 95%;
    overflow-wrap: anywhere;
    line-height: 1.5;
}

html[data-mode="panel"] .message-bubble {
    max-width: min(1100px, 100%);
}

.message.user {
    align-self: flex-end;
    align-items: flex-end;
}

.message.user .message-bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 2px;
}

html[data-mode="panel"] .message.user .message-bubble {
    max-width: min(900px, 82%);
}

.message.assistant {
    align-self: flex-start;
    width: 100%;
}

.message.assistant .message-bubble {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    border-bottom-left-radius: 2px;
    width: 100%;
}

.message-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.message-meta .role {
    font-weight: 600;
    color: var(--vscode-foreground);
}

.message.assistant pre {
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
}

.message.assistant code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
    padding: 1px 4px;
    border-radius: 3px;
}

.message.assistant pre code { background: none; padding: 0; }
.message.assistant p { margin: 6px 0; }
.message.assistant ul, .message.assistant ol { padding-left: 20px; margin: 4px 0; }
.message.assistant h1, .message.assistant h2, .message.assistant h3 { margin: 8px 0 4px; }
.message.assistant li + li { margin-top: 3px; }

.assistant-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.thought {
    border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
    padding: 6px 10px;
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08));
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.thought-label {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    margin-bottom: 4px;
}

.tool-call {
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
}

.tool-call .tool-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-weight: 500;
}

.tool-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tool-call .tool-status {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    text-transform: capitalize;
}

.tool-status.in_progress {
    background: var(--vscode-progressBar-background, #0e639c);
    color: white;
}

.tool-status.completed {
    background: var(--vscode-testing-iconPassed, #388a34);
    color: white;
}

.tool-status.failed {
    background: var(--vscode-errorForeground, #f48771);
    color: white;
}

.tool-call details {
    margin-top: 6px;
}

.tool-call summary {
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

.tool-call pre {
    margin-top: 4px;
    font-size: 11px;
    max-height: 220px;
    overflow-y: auto;
}

.usage-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 8px;
    margin-top: 2px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-widget-border, #333);
}

.usage-chip {
    padding: 3px 7px;
    border-radius: 999px;
    background: var(--vscode-badge-background, rgba(127,127,127,0.14));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
}

.error {
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #f44);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
}

#loading {
    display: none;
    padding: 0 12px 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

#loading.visible { display: block; }

.dots::after {
    content: '';
    animation: dots 1.5s steps(4, end) infinite;
}

@keyframes dots {
    0% { content: ''; }
    25% { content: '.'; }
    50% { content: '..'; }
    75% { content: '...'; }
}

#welcome {
    padding: 18px 14px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    border-radius: 8px;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
}

#welcome h2 { margin-bottom: 6px; color: var(--vscode-foreground); font-size: 15px; }
#welcome p { line-height: 1.5; }
.setup-step {
    margin-top: 12px;
    padding: 12px;
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 6px;
    transition: opacity 0.2s;
}
.setup-step.done { opacity: 0.5; }
.setup-step-title { font-weight: 600; font-size: 13px; color: var(--vscode-foreground); margin-bottom: 6px; }
.setup-step p { margin: 4px 0 8px; font-size: 12px; }
.setup-step pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 8px 10px;
    border-radius: 4px;
    font-size: 11px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin-bottom: 8px;
}
.setup-status { margin-top: 8px; font-size: 12px; min-height: 16px; }
.setup-status.ok { color: var(--vscode-testing-iconPassed); }
.setup-status.err { color: var(--vscode-errorForeground); }
#welcome-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
}

#attachment-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

#agent-picker-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 180px;
    color: var(--vscode-foreground) !important;
    font-size: 11px !important;
}

#agent-picker-btn::before { content: '✦'; color: var(--vscode-textLink-foreground); }
#agent-picker-btn::after { content: '⌄'; color: var(--vscode-descriptionForeground); }
#agent-picker-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

#agent-popover {
    top: auto;
    right: auto;
    bottom: 42px;
    left: 7px;
    width: min(330px, calc(100% - 14px));
}

.agent-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.agent-item.active .history-title::after { content: '  ✓'; color: var(--vscode-testing-iconPassed); }
.agent-meta { overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }

.modal-backdrop { position: fixed; z-index: 40; inset: 0; display: none; place-items: center; padding: 18px; background: color-mix(in srgb, #000 42%, transparent); }
.modal-backdrop.visible { display: grid; }
.agent-modal { width: min(440px, 100%); padding: 18px; border: 1px solid var(--vscode-widget-border, #555); border-radius: 11px; background: var(--vscode-editor-background); box-shadow: 0 12px 40px color-mix(in srgb, #000 35%, transparent); }
.agent-modal h2 { margin: 0 0 5px; font-size: 15px; }
.agent-modal > p { margin: 0 0 16px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.field { margin-bottom: 12px; }
.field label { display: block; margin-bottom: 5px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; }
.field input, .field select { width: 100%; min-height: 32px; padding: 6px 8px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #555)); border-radius: 5px; outline: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
.field input:focus, .field select:focus { border-color: var(--vscode-focusBorder); }
.modal-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.modal-action {
    min-height: 32px;
    padding: 7px 13px;
    border: 1px solid transparent;
    border-radius: 6px;
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
}
.modal-action.secondary {
    background: transparent;
    color: var(--vscode-foreground);
}
.modal-action.secondary:hover {
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
}
.modal-action.primary {
    min-width: 92px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    box-shadow: 0 1px 2px color-mix(in srgb, #000 18%, transparent);
}
.modal-action.primary:hover { background: var(--vscode-button-hoverBackground); }
.modal-action.primary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.modal-action:disabled { cursor: default; opacity: .55; box-shadow: none; }
.modal-error { min-height: 16px; color: var(--vscode-errorForeground); font-size: 11px; }

#workspace-browser {
    display: none;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 8px;
    background: var(--vscode-editor-background);
    padding: 8px;
    max-height: 280px;
    overflow: auto;
}

#workspace-browser.visible {
    display: block;
}

#workspace-browser-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

#workspace-tree-empty {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 2px;
}

.tree-folder,
.tree-file {
    margin-left: 12px;
}

.tree-root {
    margin-left: 0;
}

.tree-folder summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 3px 0;
    color: var(--vscode-foreground);
}

.tree-folder summary::-webkit-details-marker {
    display: none;
}

.folder-chevron {
    display: inline-block;
    width: 10px;
    color: var(--vscode-descriptionForeground);
}

.tree-folder[open] > summary .folder-chevron {
    transform: rotate(90deg);
}

.tree-children {
    margin-left: 10px;
    padding-left: 8px;
    border-left: 1px solid color-mix(in srgb, var(--vscode-widget-border, #444) 70%, transparent);
}

.tree-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px;
}

.tree-file input[type="checkbox"] {
    margin: 0;
}

.tree-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

#attachments {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.attachment-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-badge-background, rgba(127,127,127,0.14));
    font-size: 11px;
    color: var(--vscode-foreground);
}

.attachment-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
}

html[data-mode="panel"] .attachment-chip-label {
    max-width: 320px;
}

.attachment-chip button {
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
}

.attachment-chip button:hover {
    color: var(--vscode-foreground);
}

#input-area {
    padding: 10px 12px 12px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-editor-background) 10%);
}

html[data-mode="panel"] #input-area {
    padding: 14px 24px 18px;
}

#composer-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

#context-badge {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

#composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    width: 100%;
}

html[data-mode="panel"] #composer {
    max-width: 1100px;
}

#input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    resize: none;
    min-height: 36px;
    max-height: 180px;
    outline: none;
}

#input:focus { border-color: var(--vscode-focusBorder); }

#send-btn, #cancel-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    height: 36px;
}

#send-btn:hover, #cancel-btn:hover {
    background: var(--vscode-button-hoverBackground);
}

#send-btn:disabled {
    cursor: default;
    opacity: 0.6;
}

#cancel-btn { display: none; background: var(--vscode-errorForeground, #f48771); }
#cancel-btn.visible { display: inline-block; }

#composer-hint {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

#jump-latest {
    position: fixed;
    right: 12px;
    bottom: 86px;
    display: none;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 999px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    padding: 6px 10px;
    font-size: 11px;
    cursor: pointer;
}

#jump-latest.visible {
    display: inline-flex;
}

/* Native agent-chat visual layer */
body {
    background: var(--vscode-sideBar-background);
}

#shell {
    min-height: 0;
    height: 100vh;
}

#topbar {
    padding: 8px 10px;
    background: transparent;
    border-bottom-color: color-mix(in srgb, var(--vscode-panel-border, var(--vscode-widget-border, #444)) 65%, transparent);
}

.title-group {
    display: flex;
    align-items: center;
    gap: 7px;
}

.title-group::before {
    content: '';
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--vscode-testing-iconPassed, #3fb950);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 14%, transparent);
}

.title {
    font-size: 12px;
    letter-spacing: .01em;
}

.subtitle {
    display: none;
}

.toolbar-btn {
    min-height: 26px;
    padding: 4px 8px;
    border-color: transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--vscode-foreground);
}

.toolbar-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
}

#open-panel-btn {
    font-size: 0;
    width: 26px;
    padding: 0;
    align-items: center;
    justify-content: center;
}

#open-panel-btn::before {
    content: '↗';
    font-size: 15px;
    line-height: 1;
}

.topbar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
}

.icon-btn {
    width: 28px;
    height: 28px;
    display: inline-grid;
    place-items: center;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    cursor: pointer;
    font-size: 17px;
    line-height: 1;
}

.icon-btn:hover,
.icon-btn.active {
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
}

#more-btn { font-size: 19px; letter-spacing: 1px; }
#history-btn { font-size: 19px; }
#history-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.65; stroke-linecap: round; stroke-linejoin: round; }
#settings-btn { font-size: 18px; }
#new-chat-btn { font-size: 19px; }
#new-chat-btn svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

.popover {
    position: absolute;
    z-index: 20;
    top: 43px;
    right: 8px;
    width: min(340px, calc(100% - 16px));
    max-height: min(520px, calc(100vh - 58px));
    display: none;
    overflow: auto;
    border: 1px solid var(--vscode-widget-border, #555);
    border-radius: 9px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    box-shadow: 0 8px 28px color-mix(in srgb, #000 28%, transparent);
}

.popover.visible { display: block; }

.popover-header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 12px 8px;
    background: inherit;
    font-size: 12px;
    font-weight: 600;
}

.popover-empty {
    padding: 20px 12px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    font-size: 11px;
}

.history-item,
.settings-item {
    width: calc(100% - 12px);
    margin: 0 6px 4px;
    padding: 8px 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
}

.history-item:hover,
.settings-item:hover {
    background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
}

.history-title,
.settings-title {
    overflow: hidden;
    color: var(--vscode-foreground);
    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.history-time,
.settings-description {
    margin-top: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    line-height: 1.4;
}

.settings-section-label {
    padding: 11px 12px 5px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
}

.more-menu {
    width: 190px;
    padding: 5px;
}

.more-menu .settings-item {
    width: 100%;
    margin: 0;
    padding: 7px 8px;
}

#settings-page {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: none;
    overflow: auto;
    background: var(--vscode-editor-background);
}

#settings-page.visible { display: block; }

.settings-page-inner {
    width: min(760px, 100%);
    min-height: 100%;
    margin: 0 auto;
    padding: 18px 16px 36px;
}

.settings-page-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 22px;
}

.settings-page-header .icon-btn { flex: 0 0 auto; }
.settings-page-heading { min-width: 0; }
.settings-page-heading h1 { margin: 0; font-size: 18px; font-weight: 600; }
.settings-page-heading p { margin: 5px 0 0; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }

.settings-profile-card {
    display: flex;
    align-items: center;
    gap: 11px;
    margin-bottom: 18px;
    padding: 13px;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, var(--vscode-editor-background) 30%);
}

.settings-profile-avatar {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    border-radius: 9px;
    background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 18%, transparent);
    color: var(--vscode-foreground);
    font-weight: 700;
}

.settings-profile-name { font-size: 13px; font-weight: 600; }
.settings-profile-meta { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; }

.settings-card {
    margin-top: 12px;
    padding: 15px;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 45%, var(--vscode-editor-background) 55%);
}

.settings-card h2 { margin: 0; font-size: 13px; font-weight: 600; }
.settings-card > p { margin: 5px 0 14px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.45; }
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
.settings-grid .field { margin: 0; }
.settings-grid .field.full { grid-column: 1 / -1; }
.settings-grid label { display: block; margin-bottom: 5px; color: var(--vscode-foreground); font-size: 10px; font-weight: 600; }
.settings-grid input,
.settings-grid select {
    width: 100%;
    padding: 8px 9px;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #555));
    border-radius: 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font: inherit;
}
.settings-grid input:focus,
.settings-grid select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
.field-help { margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 9px; line-height: 1.4; }
.settings-link-list { display: grid; gap: 6px; }
.settings-link { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--vscode-foreground); text-align: left; cursor: pointer; }
.settings-link:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent)); }
.settings-link span:last-child { color: var(--vscode-descriptionForeground); }
.settings-page-footer { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding: 12px 0; background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent); backdrop-filter: blur(8px); }
#settings-save-status { min-height: 16px; color: var(--vscode-descriptionForeground); font-size: 10px; }
#settings-save-status.ok { color: var(--vscode-testing-iconPassed); }
#settings-save-status.err { color: var(--vscode-errorForeground); }
#save-profile-settings { padding: 8px 14px; }

@media (max-width: 480px) {
    .settings-grid { grid-template-columns: 1fr; }
    .settings-grid .field.full { grid-column: auto; }
}

#messages {
    gap: 20px;
    padding: 18px 12px 22px;
    scrollbar-width: thin;
}

html[data-mode="panel"] #messages {
    width: 100%;
    padding: 26px max(24px, calc((100% - 920px) / 2)) 36px;
}

.message {
    gap: 7px;
}

.message-meta {
    gap: 7px;
    min-height: 18px;
    padding: 0 2px;
    font-size: 10px;
    opacity: .82;
}

.message-meta::before {
    content: '';
    width: 16px;
    height: 16px;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
}

.message.assistant .message-meta::before {
    content: 'H';
    color: var(--vscode-foreground);
    font-size: 9px;
    font-weight: 700;
}

.message.user .message-meta::before {
    display: none;
}

.message-meta .role {
    font-size: 11px;
}

.message-bubble,
html[data-mode="panel"] .message-bubble {
    max-width: 100%;
    padding: 0;
    border-radius: 0;
    line-height: 1.58;
}

.message.assistant .message-bubble {
    width: 100%;
    padding-left: 25px;
    border: 0;
    background: transparent;
}

.message.user {
    max-width: 92%;
}

.message.user .message-meta {
    padding-right: 4px;
}

.message.user .message-bubble,
html[data-mode="panel"] .message.user .message-bubble {
    max-width: min(720px, 100%);
    padding: 8px 11px;
    border: 1px solid color-mix(in srgb, var(--vscode-widget-border, #555) 70%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
    color: var(--vscode-foreground);
}

.message.assistant p:first-child { margin-top: 0; }
.message.assistant p:last-child { margin-bottom: 0; }

.message.assistant pre {
    padding: 11px 12px;
    border: 1px solid color-mix(in srgb, var(--vscode-widget-border, #444) 70%, transparent);
    border-radius: 7px;
}

.assistant-stack {
    gap: 10px;
}

.tools-container:empty {
    display: none;
}

.thought {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

.thought > summary {
    width: fit-content;
    cursor: pointer;
    list-style: none;
    user-select: none;
}

.thought > summary::-webkit-details-marker { display: none; }
.thought > summary::before { content: '›'; display: inline-block; margin-right: 6px; }
.thought[open] > summary::before { transform: rotate(90deg); }

.thought-body {
    margin: 6px 0 0 11px;
    padding-left: 10px;
    border-left: 1px solid var(--vscode-textBlockQuote-border, #555);
    white-space: pre-wrap;
}

.tool-call {
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--vscode-widget-border, #555) 62%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
    overflow: hidden;
}

.tool-call .tool-header {
    min-height: 32px;
    padding: 6px 9px;
    font-weight: 400;
}

.tool-name {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
}

.tool-name::before {
    content: '›_';
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-weight: 600;
}

.tool-call .tool-status {
    padding: 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
}

.tool-status.completed { color: var(--vscode-testing-iconPassed, #3fb950); }
.tool-status.failed { color: var(--vscode-errorForeground, #f48771); }
.tool-status.in_progress { color: var(--vscode-progressBar-background, #3794ff); }

.tool-call details {
    margin: 0;
    padding: 6px 9px 8px;
    border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border, #555) 45%, transparent);
}

.tool-call summary { user-select: none; }
.tool-call pre { border: 0; border-radius: 5px; }

.usage-bar {
    gap: 10px;
    margin-top: 3px;
    padding-top: 7px;
    border-top-color: color-mix(in srgb, var(--vscode-widget-border, #444) 45%, transparent);
}

.usage-chip {
    padding: 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
}

#welcome {
    margin: auto 0;
    padding: 22px 10px;
    border: 0;
    background: transparent;
    text-align: center;
}

#welcome::before {
    content: 'H';
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    margin: 0 auto 12px;
    border: 1px solid var(--vscode-widget-border, #555);
    border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
    color: var(--vscode-foreground);
    font-size: 15px;
    font-weight: 650;
}

#welcome h2 { font-size: 16px; font-weight: 600; }
#welcome p { max-width: 440px; margin-inline: auto; font-size: 12px; }

#welcome-setup {
    width: min(520px, 100%);
    margin: 0 auto;
}

.ace-referral {
    margin: 16px 0 12px;
    padding: 13px 14px;
    border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 55%, var(--vscode-widget-border, #555));
    border-radius: 9px;
    background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 8%, transparent);
    text-align: left;
}

.ace-referral-label {
    margin-bottom: 5px;
    color: var(--vscode-foreground);
    font-size: 12px;
    font-weight: 600;
}

.ace-referral p {
    margin: 0 0 10px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
}

.ace-referral .toolbar-btn {
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

.ace-referral .toolbar-btn:hover {
    background: var(--vscode-button-hoverBackground);
}

#welcome-setup .setup-step {
    padding: 12px 13px;
    border-color: color-mix(in srgb, var(--vscode-widget-border, #555) 68%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
    text-align: left;
}

#welcome-setup .setup-step p {
    margin-inline: 0;
}

#welcome-setup .setup-step pre {
    border: 1px solid color-mix(in srgb, var(--vscode-widget-border, #555) 55%, transparent);
}

.setup-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
}

.setup-wizard-action {
    margin-top: 12px;
}

#loading {
    padding: 0 12px 7px 37px;
}

html[data-mode="panel"] #loading {
    width: min(920px, calc(100% - 48px));
    margin: 0 auto;
    padding-left: 25px;
}

#input-area,
html[data-mode="panel"] #input-area {
    width: auto;
    margin: 0 8px 8px;
    padding: 7px;
    gap: 6px;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #555));
    border-radius: 11px;
    background: var(--vscode-input-background, var(--vscode-editor-background));
    box-shadow: 0 4px 16px color-mix(in srgb, #000 14%, transparent);
}

html[data-mode="panel"] #input-area {
    width: min(920px, calc(100% - 32px));
    margin: 0 auto 14px;
}

#input-area:focus-within {
    border-color: var(--vscode-focusBorder, #007fd4);
}

#composer-meta {
    order: 3;
    min-height: 24px;
    padding: 0 3px;
}

#composer-hint { display: none; }

#context-badge {
    opacity: .8;
    font-size: 10px;
}

#attachment-toolbar {
    order: 2;
    gap: 4px;
}

#attachment-toolbar .toolbar-btn {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
}

#clear-attachments-btn:not(:hover) {
    opacity: .72;
}

#workspace-browser {
    order: 1;
    border-color: color-mix(in srgb, var(--vscode-widget-border, #555) 65%, transparent);
    box-shadow: 0 -5px 18px color-mix(in srgb, #000 12%, transparent);
}

#composer {
    order: 0;
    gap: 5px;
    align-items: flex-end;
    max-width: none;
}

#input {
    min-height: 40px;
    padding: 9px 7px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    line-height: 1.45;
}

#input:focus { border-color: transparent; }

#send-btn, #cancel-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    margin: 5px 1px;
    border-radius: 7px;
    font-size: 0;
}

#send-btn::before { content: '↑'; font-size: 17px; font-weight: 600; }
#cancel-btn {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
}
#cancel-btn:hover {
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    color: var(--vscode-foreground);
}
#cancel-btn::before { content: '■'; font-size: 9px; }
#send-btn:disabled { background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); color: var(--vscode-descriptionForeground); }

.attachment-chip {
    border-color: color-mix(in srgb, var(--vscode-widget-border, #555) 65%, transparent);
    border-radius: 5px;
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
}

#jump-latest {
    right: 50%;
    bottom: 104px;
    transform: translateX(50%);
    box-shadow: 0 3px 10px color-mix(in srgb, #000 16%, transparent);
}

@media (max-width: 340px) {
    #messages { padding-inline: 9px; }
    .message.assistant .message-bubble { padding-left: 0; }
    .message.assistant .message-meta { padding-left: 0; }
    #context-badge { max-width: 180px; }
}
</style>
</head>
<body>
    <div id="shell">
        <div id="topbar">
            <div class="topbar-row">
                <div class="title-group">
                    <div class="title">Hermes Agent</div>
                    <div class="subtitle">Local coding agent</div>
                </div>
                <div class="topbar-actions">
                    <button id="more-btn" class="icon-btn" type="button" title="More actions" aria-label="More actions">⋯</button>
                    <button id="history-btn" class="icon-btn" type="button" title="Chat history" aria-label="Chat history"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.2 6.4V3.2m0 0h3.2m-3.2 0 2.3 2.3A7 7 0 1 1 3 10"/><path d="M10 6.2V10l2.6 1.6"/></svg></button>
                    <button id="settings-btn" class="icon-btn" type="button" title="Hermes settings" aria-label="Hermes settings">⚙</button>
                    <button id="new-chat-btn" class="icon-btn" type="button" title="New chat" aria-label="New chat"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 3.5H5.8A2.3 2.3 0 0 0 3.5 5.8v8.4a2.3 2.3 0 0 0 2.3 2.3h8.4a2.3 2.3 0 0 0 2.3-2.3V8"/><path d="m10.2 10.1 5.5-5.5 1.7 1.7-5.5 5.5-2.4.7.7-2.4Z"/></svg></button>
                    <button id="open-panel-btn" class="toolbar-btn" type="button" title="Open in panel" aria-label="Open in panel">Open in panel</button>
                </div>
            </div>
        </div>

        <div id="more-popover" class="popover more-menu">
            <button class="settings-item" type="button" data-action="open-panel"><div class="settings-title">Open in panel</div></button>
            <button class="settings-item" type="button" data-action="clear-chat"><div class="settings-title">Clear current chat</div></button>
            <button class="settings-item" type="button" data-action="setup"><div class="settings-title">Run setup wizard</div></button>
        </div>

        <div id="history-popover" class="popover">
            <div class="popover-header"><span>Chat history</span><button class="icon-btn popover-close" type="button" aria-label="Close">×</button></div>
            <div id="history-list"></div>
        </div>

        <div id="settings-popover" class="popover">
            <div class="popover-header"><span>Hermes settings</span><button class="icon-btn popover-close" type="button" aria-label="Close">×</button></div>
            <div class="settings-section-label">Configuration</div>
            <button class="settings-item" type="button" data-setting="extension"><div class="settings-title">Extension settings</div><div class="settings-description">Hermes path, timeouts, and tool permissions</div></button>
            <button class="settings-item" type="button" data-setting="provider"><div class="settings-title">Provider and model</div><div class="settings-description">Configure local Codex, Agent Maestro, or another provider</div></button>
            <div class="settings-section-label">Agent data</div>
            <button class="settings-item" type="button" data-memory="user"><div class="settings-title">User memory</div><div class="settings-description">Open USER.md</div></button>
            <button class="settings-item" type="button" data-memory="memory"><div class="settings-title">Long-term memory</div><div class="settings-description">Open MEMORY.md</div></button>
            <button class="settings-item" type="button" data-memory="soul"><div class="settings-title">Agent personality</div><div class="settings-description">Open SOUL.md</div></button>
        </div>

        <div id="messages">
            <div id="welcome">
                <div id="welcome-setup">
                    <h2>Welcome to Hermes</h2>
                    <p style="margin:6px auto 0;color:var(--vscode-descriptionForeground);">Set up the local agent in two quick steps.</p>

                    <div class="ace-referral">
                        <div class="ace-referral-label">No API key yet? Try Ace Data Cloud</div>
                        <p>One key for 50+ models, including GPT, Claude, and Gemini. Free sign-up includes trial credits, then pay as you go with no subscription.</p>
                        <button class="toolbar-btn" type="button" id="btn-open-referral">Create a free account →</button>
                    </div>

                    <div class="setup-step" id="setup-step-install">
                        <div class="setup-step-title">1. Install Hermes CLI</div>
                        <p>Run this command in your terminal:</p>
                        <pre id="install-cmd">curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</pre>
                        <div class="setup-actions">
                            <button class="toolbar-btn" type="button" id="btn-copy-install">Copy command</button>
                            <button class="toolbar-btn" type="button" id="btn-check-install">Already installed</button>
                        </div>
                        <div id="install-status" class="setup-status"></div>
                    </div>

                    <div class="setup-step" id="setup-step-provider" style="opacity:0.5;pointer-events:none;">
                        <div class="setup-step-title">2. Configure a provider</div>
                        <p>Choose Ace Data Cloud, local Codex through Agent Maestro, or another provider in the setup flow.</p>
                        <div class="setup-actions">
                            <button class="toolbar-btn" type="button" id="btn-open-wizard">Open guided setup</button>
                            <button class="toolbar-btn" type="button" id="btn-check-provider">I've configured it</button>
                        </div>
                        <div id="provider-status" class="setup-status"></div>
                    </div>
                </div>
                <div id="welcome-ready" style="display:none;">
                    <h2>What can Hermes help with?</h2>
                    <p>Ask about your code, attach workspace files, or delegate a task to the local agent.</p>
                </div>
            </div>
        </div>

        <div id="loading"><span class="dots">Hermes is thinking</span></div>
        <div id="input-area">
            <div id="composer-meta">
                <div id="context-badge">No active editor</div>
                <div id="composer-hint">Enter to send, Shift+Enter for a new line</div>
            </div>
            <div id="attachment-toolbar">
                <button id="agent-picker-btn" class="toolbar-btn" type="button"><span id="agent-picker-label">Hermes · default</span></button>
                <button id="attach-files-btn" class="toolbar-btn" type="button">+ Attach files</button>
                <button id="clear-attachments-btn" class="toolbar-btn" type="button">Clear</button>
                <div id="attachments"></div>
            </div>
            <div id="agent-popover" class="popover">
                <div class="popover-header"><span>Choose agent</span><button class="icon-btn popover-close" type="button" aria-label="Close">×</button></div>
                <div id="agent-list"></div>
                <button id="create-agent-btn" class="settings-item" type="button"><div class="settings-title">＋ Create new agent</div><div class="settings-description">Start blank or clone an existing profile</div></button>
            </div>
            <div id="workspace-browser">
                <div id="workspace-browser-header">
                    <span>Attach files from the current workspace</span>
                    <span id="workspace-browser-count"></span>
                </div>
                <div id="workspace-tree-empty">Loading workspace files...</div>
                <div id="workspace-tree"></div>
            </div>
            <div id="composer">
                <textarea id="input" rows="1" placeholder="Ask Hermes to work on your code..." autofocus></textarea>
                <button id="send-btn" title="Send message" aria-label="Send message">Send</button>
                <button id="cancel-btn" title="Stop response" aria-label="Stop response">Stop</button>
            </div>
        </div>
    </div>
    <section id="settings-page" aria-hidden="true">
        <div class="settings-page-inner">
            <header class="settings-page-header">
                <button id="close-settings-page" class="icon-btn" type="button" aria-label="Back to chat">←</button>
                <div class="settings-page-heading"><h1>Agent settings</h1><p>Configure the active Hermes agent without leaving the chat.</p></div>
            </header>
            <div class="settings-profile-card">
                <div class="settings-profile-avatar">H</div>
                <div><div id="settings-profile-name" class="settings-profile-name">default</div><div id="settings-profile-meta" class="settings-profile-meta">Active agent</div></div>
            </div>
            <form id="profile-settings-form">
                <section class="settings-card">
                    <h2>Model connection</h2>
                    <p>Changes apply to this agent only. Existing keys stay untouched unless a new key is entered.</p>
                    <div class="settings-grid">
                        <div class="field"><label for="settings-provider">Provider</label><input id="settings-provider" list="settings-provider-options" placeholder="auto"><datalist id="settings-provider-options"><option value="auto"><option value="openai-codex"><option value="openai-api"><option value="anthropic"><option value="openrouter"><option value="gemini"><option value="nous"><option value="custom"></datalist><div class="field-help">Use any provider identifier supported by Hermes.</div></div>
                        <div class="field"><label for="settings-model">Model</label><input id="settings-model" placeholder="Provider default"><div class="field-help">Leave empty to use the provider default.</div></div>
                        <div class="field full"><label for="settings-api-key">API key</label><input id="settings-api-key" type="password" autocomplete="off" placeholder="Leave blank to keep the current key"><div id="settings-key-help" class="field-help">Keys are stored locally in this agent's private .env file.</div></div>
                    </div>
                </section>
                <section class="settings-card">
                    <h2>Personality & memory</h2>
                    <p>Edit the files that shape how this agent behaves and what it remembers.</p>
                    <div class="settings-link-list">
                        <button class="settings-link" type="button" data-settings-memory="soul"><span>Agent personality</span><span>SOUL.md →</span></button>
                        <button class="settings-link" type="button" data-settings-memory="user"><span>About you</span><span>USER.md →</span></button>
                        <button class="settings-link" type="button" data-settings-memory="memory"><span>Long-term memory</span><span>MEMORY.md →</span></button>
                    </div>
                </section>
                <section class="settings-card">
                    <h2>Extension</h2>
                    <p>Configure Hermes path, response timeouts, and tool approval behavior in VS Code settings.</p>
                    <button id="open-extension-settings-page" class="settings-link" type="button"><span>Open extension settings</span><span>→</span></button>
                </section>
                <div class="settings-page-footer"><div id="settings-save-status"></div><button id="save-profile-settings" type="submit">Save changes</button></div>
            </form>
        </div>
    </section>
    <div id="agent-modal-backdrop" class="modal-backdrop">
        <form id="agent-form" class="agent-modal">
            <h2>Create a Hermes agent</h2>
            <p>Each agent has isolated model settings, personality, memory, skills, and history.</p>
            <div class="field"><label for="agent-name">Name</label><input id="agent-name" required maxlength="32" placeholder="coder" pattern="[a-z][a-z0-9-]{1,31}"></div>
            <div class="field"><label for="agent-description">Role description</label><input id="agent-description" maxlength="240" placeholder="Coding specialist for this workspace"></div>
            <div class="field"><label for="agent-source">Starting point</label><select id="agent-source"><option value="">Blank agent</option></select></div>
            <div id="agent-form-error" class="modal-error"></div>
            <div class="modal-actions"><button id="cancel-create-agent" class="modal-action secondary" type="button">Cancel</button><button id="submit-create-agent" class="modal-action primary" type="submit">Create agent</button></div>
        </form>
    </div>
    <button id="jump-latest" type="button">Jump to latest</button>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const initialData = ${initialState};
const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const loadingEl = document.getElementById('loading');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const jumpLatestBtn = document.getElementById('jump-latest');
const contextBadge = document.getElementById('context-badge');
const openPanelBtn = document.getElementById('open-panel-btn');
const moreBtn = document.getElementById('more-btn');
const historyBtn = document.getElementById('history-btn');
const settingsBtn = document.getElementById('settings-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const morePopover = document.getElementById('more-popover');
const historyPopover = document.getElementById('history-popover');
const settingsPopover = document.getElementById('settings-popover');
const historyList = document.getElementById('history-list');
const attachFilesBtn = document.getElementById('attach-files-btn');
const clearAttachmentsBtn = document.getElementById('clear-attachments-btn');
const attachmentsEl = document.getElementById('attachments');
const workspaceBrowserEl = document.getElementById('workspace-browser');
const workspaceTreeEl = document.getElementById('workspace-tree');
const workspaceTreeEmptyEl = document.getElementById('workspace-tree-empty');
const workspaceBrowserCountEl = document.getElementById('workspace-browser-count');
const agentPickerBtn = document.getElementById('agent-picker-btn');
const agentPickerLabel = document.getElementById('agent-picker-label');
const agentPopover = document.getElementById('agent-popover');
const agentList = document.getElementById('agent-list');
const agentModalBackdrop = document.getElementById('agent-modal-backdrop');
const agentForm = document.getElementById('agent-form');
const agentNameInput = document.getElementById('agent-name');
const agentDescriptionInput = document.getElementById('agent-description');
const agentSourceSelect = document.getElementById('agent-source');
const agentFormError = document.getElementById('agent-form-error');
const submitCreateAgent = document.getElementById('submit-create-agent');
const settingsPage = document.getElementById('settings-page');
const profileSettingsForm = document.getElementById('profile-settings-form');
const settingsProfileName = document.getElementById('settings-profile-name');
const settingsProfileMeta = document.getElementById('settings-profile-meta');
const settingsProvider = document.getElementById('settings-provider');
const settingsModel = document.getElementById('settings-model');
const settingsApiKey = document.getElementById('settings-api-key');
const settingsKeyHelp = document.getElementById('settings-key-help');
const settingsSaveStatus = document.getElementById('settings-save-status');
const saveProfileSettings = document.getElementById('save-profile-settings');

const state = vscode.getState() || { draft: '' };
inputEl.value = state.draft || '';

let currentAssistantEl = null;
let currentTextEl = null;
let currentToolsEl = null;
let chatHistory = initialData.history || [];
let toolEls = new Map();
let shouldStickToBottom = true;
let isProcessing = false;
let workspaceTree = [];
let attachedFilePaths = new Set();
let profiles = initialData.profiles || [];
let activeProfile = initialData.activeProfile || 'default';

function showSettingsPage(settings = initialData.profileSettings || {}, profile = activeProfile) {
    closePopovers();
    settingsProfileName.textContent = profile;
    settingsProfileMeta.textContent = profile === 'default' ? 'Default Hermes agent' : 'Isolated agent profile';
    settingsProvider.value = settings.provider || 'auto';
    settingsModel.value = settings.model || '';
    settingsApiKey.value = '';
    settingsKeyHelp.textContent = settings.apiKeyConfigured
        ? 'A key is already configured. Enter a new one only to replace it.'
        : "Keys are stored locally in this agent's private .env file.";
    settingsSaveStatus.textContent = '';
    settingsSaveStatus.className = '';
    settingsPage.classList.add('visible');
    settingsPage.setAttribute('aria-hidden', 'false');
}

function hideSettingsPage() {
    settingsPage.classList.remove('visible');
    settingsPage.setAttribute('aria-hidden', 'true');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatInline(text) {
    return text
        .replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
}

function renderMarkdown(text) {
    const codeBlocks = [];
    let escaped = escapeHtml(text).replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        const langLabel = lang ? '<div class="subtitle">' + escapeHtml(lang) + '</div>' : '';
        codeBlocks.push(langLabel + '<pre><code>' + code + '</code></pre>');
        return '\\n@@CODEBLOCK_' + idx + '@@\\n';
    });

    const blocks = escaped.split(/\\n{2,}/).map((block) => block.trim()).filter(Boolean);
    const rendered = blocks.map((block) => {
        if (/^@@CODEBLOCK_\\d+@@$/.test(block)) return block;

        const heading = block.match(/^(#{1,3})\\s+(.+)$/);
        if (heading) {
            const level = heading[1].length;
            return '<h' + level + '>' + formatInline(heading[2]) + '</h' + level + '>';
        }

        const lines = block.split('\\n');
        if (lines.every((line) => /^[-*]\\s+/.test(line))) {
            return '<ul>' + lines.map((line) => '<li>' + formatInline(line.replace(/^[-*]\\s+/, '')) + '</li>').join('') + '</ul>';
        }
        if (lines.every((line) => /^\\d+\\.\\s+/.test(line))) {
            return '<ol>' + lines.map((line) => '<li>' + formatInline(line.replace(/^\\d+\\.\\s+/, '')) + '</li>').join('') + '</ol>';
        }

        return '<p>' + formatInline(block).replace(/\\n/g, '<br>') + '</p>';
    }).join('');

    return rendered.replace(/@@CODEBLOCK_(\\d+)@@/g, (_, idx) => codeBlocks[Number(idx)] || '');
}

function updateDraft() {
    vscode.setState({ ...state, draft: inputEl.value });
}

function closePopovers() {
    [morePopover, historyPopover, settingsPopover, agentPopover].forEach((popover) => popover?.classList.remove('visible'));
    [moreBtn, historyBtn, settingsBtn, agentPickerBtn].forEach((button) => button?.classList.remove('active'));
}

function togglePopover(popover, button) {
    const shouldOpen = !popover.classList.contains('visible');
    closePopovers();
    if (shouldOpen) {
        popover.classList.add('visible');
        button.classList.add('active');
    }
}

function renderHistory(history) {
    chatHistory = Array.isArray(history) ? history : [];
    historyList.innerHTML = '';
    if (!chatHistory.length) {
        historyList.innerHTML = '<div class="popover-empty">No previous chats yet</div>';
        return;
    }
    chatHistory.forEach((entry) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'history-item';
        button.innerHTML = '<div class="history-title">' + escapeHtml(entry.title || 'Untitled chat') + '</div>' +
            '<div class="history-time">' + new Date(entry.updatedAt).toLocaleString() + '</div>';
        button.addEventListener('click', () => {
            closePopovers();
            vscode.postMessage({ type: 'openHistory', id: entry.id });
        });
        historyList.appendChild(button);
    });
}

function renderProfiles(nextProfiles, nextActiveProfile) {
    profiles = Array.isArray(nextProfiles) ? nextProfiles : [];
    activeProfile = nextActiveProfile || activeProfile || 'default';
    const active = profiles.find((profile) => profile.name === activeProfile);
    agentPickerLabel.textContent = 'Hermes · ' + (active?.name || activeProfile);
    agentList.innerHTML = '';
    agentSourceSelect.innerHTML = '<option value="">Blank agent</option>';
    profiles.forEach((profile) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'history-item agent-item' + (profile.name === activeProfile ? ' active' : '');
        const summary = [profile.model, profile.provider].filter(Boolean).join(' · ') || profile.description || 'Hermes profile';
        button.innerHTML = '<div><div class="history-title">' + escapeHtml(profile.name) + '</div><div class="agent-meta">' + escapeHtml(summary) + '</div></div>';
        button.disabled = isProcessing || profile.name === activeProfile;
        button.addEventListener('click', () => { closePopovers(); vscode.postMessage({ type: 'switchProfile', profile: profile.name }); });
        agentList.appendChild(button);
        const option = document.createElement('option');
        option.value = profile.name;
        option.textContent = 'Clone from ' + profile.name;
        agentSourceSelect.appendChild(option);
    });
}

function openAgentModal() {
    closePopovers();
    agentForm.reset();
    agentFormError.textContent = '';
    submitCreateAgent.disabled = false;
    agentModalBackdrop.classList.add('visible');
    agentNameInput.focus();
}

function maybeAutoScroll() {
    if (shouldStickToBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    jumpLatestBtn.classList.toggle('visible', !shouldStickToBottom);
}

function updateScrollStickiness() {
    const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    shouldStickToBottom = distanceFromBottom < 48;
    jumpLatestBtn.classList.toggle('visible', !shouldStickToBottom);
}

function createMessageShell(role, timestamp) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message ' + role;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.innerHTML = '<span class="role">' + (role === 'user' ? 'You' : 'Hermes') + '</span><span>' + formatTime(timestamp) + '</span>';
    wrapper.appendChild(meta);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    wrapper.appendChild(bubble);

    return { wrapper, bubble };
}

function syncSessionState(msg) {
    const info = msg.contextInfo || {};
    const detail = info.detail ? ' · ' + info.detail : '';
    contextBadge.textContent = (info.fileLabel || 'No active editor') + detail;
    renderAttachments(msg.attachedFiles || []);
    if (msg.profiles) renderProfiles(msg.profiles, msg.activeProfile);
    if (settingsPage.classList.contains('visible') && msg.profileSettings) showSettingsPage(msg.profileSettings, msg.activeProfile || activeProfile);
}

function updateWorkspaceTreeMeta() {
    workspaceBrowserCountEl.textContent = attachedFilePaths.size
        ? attachedFilePaths.size + ' attached'
        : 'No files attached';
}

function createTreeNode(node, depth = 0) {
    if (node.kind === 'folder') {
        const details = document.createElement('details');
        details.className = 'tree-folder' + (depth === 0 ? ' tree-root' : '');
        details.open = depth < 2;
        const summary = document.createElement('summary');
        summary.innerHTML = '<span class="folder-chevron">▶</span><span class="tree-label">' + escapeHtml(node.label) + '</span>';
        details.appendChild(summary);

        const children = document.createElement('div');
        children.className = 'tree-children';
        (node.children || []).forEach((child) => children.appendChild(createTreeNode(child, depth + 1)));
        details.appendChild(children);
        return details;
    }

    const row = document.createElement('label');
    row.className = 'tree-file';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = attachedFilePaths.has(node.path);
    checkbox.addEventListener('change', () => {
        if (checkbox.checked && attachedFilePaths.size >= ${HermesChatViewProvider.maxAttachedFiles} && !attachedFilePaths.has(node.path)) {
            checkbox.checked = false;
            return;
        }
        vscode.postMessage({ type: 'toggleAttachment', path: node.path, checked: checkbox.checked });
    });
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.label;
    row.appendChild(checkbox);
    row.appendChild(label);
    return row;
}

function renderWorkspaceTree(tree) {
    workspaceTree = Array.isArray(tree) ? tree : [];
    workspaceTreeEl.innerHTML = '';
    if (!workspaceTree.length) {
        workspaceTreeEmptyEl.style.display = 'block';
        workspaceTreeEmptyEl.textContent = 'No workspace files found.';
        updateWorkspaceTreeMeta();
        return;
    }

    workspaceTreeEmptyEl.style.display = 'none';
    workspaceTree.forEach((node) => workspaceTreeEl.appendChild(createTreeNode(node)));
    updateWorkspaceTreeMeta();
}

function renderAttachments(files) {
    attachedFilePaths = new Set((files || []).map((file) => file.path));
    attachmentsEl.innerHTML = '';
    clearAttachmentsBtn.style.display = files.length ? 'inline-flex' : 'none';
    files.forEach((file) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        chip.innerHTML = '<span class="attachment-chip-label">' + escapeHtml(file.label) + (file.truncated ? ' (truncated)' : '') + '</span>';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        removeBtn.title = 'Remove attachment';
        removeBtn.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', path: file.path }));
        chip.appendChild(removeBtn);
        attachmentsEl.appendChild(chip);
    });
    if (workspaceTree.length) renderWorkspaceTree(workspaceTree);
    else updateWorkspaceTreeMeta();
}

function hydrateFromInitialState(data) {
    const setupEl = document.getElementById('welcome-setup');
    const readyEl = document.getElementById('welcome-ready');
    const inputArea = document.getElementById('input-area');
    if (setupEl && readyEl) {
        if (data.setupCompleted) {
            setupEl.style.display = 'none';
            readyEl.style.display = 'block';
        } else {
            setupEl.style.display = 'block';
            readyEl.style.display = 'none';
            if (inputArea) inputArea.style.display = 'none';
        }
    }
    syncSessionState(data);
    renderWorkspaceTree(data.workspaceTree || []);
    if (Array.isArray(data.messages)) {
        data.messages.forEach(addMessageToUI);
    }
    if (data.currentAssistantMessage) {
        startAssistantMessage(data.currentAssistantMessage.timestamp || Date.now());
        if (Array.isArray(data.currentAssistantMessage.toolCalls)) {
            data.currentAssistantMessage.toolCalls.forEach(renderTool);
        }
        if (data.currentAssistantMessage.content) {
            appendAssistantText(data.currentAssistantMessage.content);
        }
    }
    if (data.isProcessing) {
        isProcessing = true;
        loadingEl.classList.add('visible');
        cancelBtn.classList.add('visible');
    }
}

function addMessageToUI(message) {
    if (welcomeEl) welcomeEl.style.display = 'none';
    const shell = createMessageShell(message.role, message.timestamp || Date.now());
    if (message.role === 'user') {
        shell.bubble.textContent = message.content;
    } else {
        shell.bubble.innerHTML = renderMarkdown(message.content);
    }
    messagesEl.appendChild(shell.wrapper);
    maybeAutoScroll();
}

function startAssistantMessage(timestamp) {
    if (welcomeEl) welcomeEl.style.display = 'none';
    const shell = createMessageShell('assistant', timestamp || Date.now());
    currentAssistantEl = shell.wrapper;

    const stack = document.createElement('div');
    stack.className = 'assistant-stack';
    shell.bubble.appendChild(stack);

    currentToolsEl = document.createElement('div');
    currentToolsEl.className = 'tools-container';
    stack.appendChild(currentToolsEl);

    currentTextEl = document.createElement('div');
    currentTextEl.className = 'text-content';
    currentTextEl.dataset.raw = '';
    stack.appendChild(currentTextEl);

    messagesEl.appendChild(currentAssistantEl);
    toolEls = new Map();
    maybeAutoScroll();
}

function appendAssistantText(text) {
    if (!currentTextEl) startAssistantMessage(Date.now());
    const raw = (currentTextEl.dataset.raw || '') + text;
    currentTextEl.dataset.raw = raw;
    currentTextEl.innerHTML = renderMarkdown(raw);
    maybeAutoScroll();
}

function appendThought(text) {
    if (!currentAssistantEl) startAssistantMessage(Date.now());
    let thoughtEl = currentAssistantEl.querySelector('.thought-current');
    if (!thoughtEl) {
        thoughtEl = document.createElement('details');
        thoughtEl.className = 'thought thought-current';
        thoughtEl.open = true;
        thoughtEl.innerHTML = '<summary class="thought-label">Worked for a moment</summary><div class="thought-body"></div>';
        const stack = currentAssistantEl.querySelector('.assistant-stack');
        if (stack) {
            stack.insertBefore(thoughtEl, currentToolsEl && currentToolsEl.childElementCount > 0 ? currentToolsEl.nextSibling : currentTextEl);
        }
    }
    const body = thoughtEl.querySelector('.thought-body');
    body.textContent += text;
    maybeAutoScroll();
}

function renderTool(tool) {
    const existing = toolEls.get(tool.id);
    const status = ['pending', 'in_progress', 'completed', 'failed'].includes(tool.status) ? tool.status : 'pending';
    const statusLabel = status === 'in_progress' ? 'Running' : status === 'completed' ? 'Done' : status === 'failed' ? 'Failed' : 'Queued';
    const inputText = tool.args ? escapeHtml(typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2)) : '';
    const outputText = tool.result ? escapeHtml(tool.result) : '';
    const html = \`
        <div class="tool-header">
            <span class="tool-name">\${escapeHtml(tool.name)}</span>
            <span class="tool-status \${status}">\${statusLabel}</span>
        </div>
        \${inputText ? \`<details><summary>Show input</summary><pre>\${inputText}</pre></details>\` : ''}
        \${outputText ? \`<details \${status === 'failed' ? 'open' : ''}><summary>Show output</summary><pre>\${outputText}</pre></details>\` : ''}
    \`;
    if (existing) {
        existing.innerHTML = html;
    } else {
        if (!currentToolsEl) startAssistantMessage(Date.now());
        const div = document.createElement('div');
        div.className = 'tool-call';
        div.innerHTML = html;
        currentToolsEl.appendChild(div);
        toolEls.set(tool.id, div);
    }
    maybeAutoScroll();
}

function finalizeAssistantMessage(usage) {
    if (!currentAssistantEl) return;
    const thoughtEl = currentAssistantEl.querySelector('.thought-current');
    if (thoughtEl) {
        thoughtEl.classList.remove('thought-current');
        thoughtEl.open = false;
    }
    if (usage) {
        const bar = document.createElement('div');
        bar.className = 'usage-bar';
        const parts = [];
        if (usage.inputTokens != null) parts.push(\`<span class="usage-chip">in \${usage.inputTokens.toLocaleString()}</span>\`);
        if (usage.outputTokens != null) parts.push(\`<span class="usage-chip">out \${usage.outputTokens.toLocaleString()}</span>\`);
        if (usage.totalTokens != null) parts.push(\`<span class="usage-chip">total \${usage.totalTokens.toLocaleString()}</span>\`);
        if (usage.cachedReadTokens) parts.push(\`<span class="usage-chip">cached \${usage.cachedReadTokens.toLocaleString()}</span>\`);
        bar.innerHTML = parts.join('');
        const bubble = currentAssistantEl.querySelector('.message-bubble');
        if (bubble) bubble.appendChild(bar);
    }
    currentAssistantEl = null;
    currentTextEl = null;
    currentToolsEl = null;
}

function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateDraft();
    sendBtn.disabled = true;
    vscode.postMessage({ type: 'sendMessage', text });
}

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
    sendBtn.disabled = !inputEl.value.trim();
    updateDraft();
});

sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
openPanelBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openPanel' }));
moreBtn?.addEventListener('click', () => togglePopover(morePopover, moreBtn));
historyBtn?.addEventListener('click', () => { renderHistory(chatHistory); togglePopover(historyPopover, historyBtn); });
settingsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'setupActiveProfile' }));
agentPickerBtn?.addEventListener('click', () => togglePopover(agentPopover, agentPickerBtn));
newChatBtn?.addEventListener('click', () => { closePopovers(); vscode.postMessage({ type: 'newSession' }); });
document.querySelectorAll('.popover-close').forEach((button) => button.addEventListener('click', closePopovers));
morePopover?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    closePopovers();
    if (action === 'open-panel') vscode.postMessage({ type: 'openPanel' });
    if (action === 'clear-chat') vscode.postMessage({ type: 'clearChat' });
    if (action === 'setup') vscode.postMessage({ type: 'runSetup' });
});
settingsPopover?.addEventListener('click', (event) => {
    const setting = event.target.closest('[data-setting]')?.dataset.setting;
    const memory = event.target.closest('[data-memory]')?.dataset.memory;
    if (setting === 'extension') vscode.postMessage({ type: 'openExtensionSettings' });
    if (setting === 'provider') vscode.postMessage({ type: 'setupActiveProfile' });
    if (memory) vscode.postMessage({ type: 'openMemoryFile', file: memory });
    if (setting || memory) closePopovers();
});
document.getElementById('close-settings-page')?.addEventListener('click', hideSettingsPage);
document.getElementById('open-extension-settings-page')?.addEventListener('click', () => vscode.postMessage({ type: 'openExtensionSettings' }));
document.querySelectorAll('[data-settings-memory]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openMemoryFile', file: button.dataset.settingsMemory })));
profileSettingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveProfileSettings.disabled = true;
    settingsSaveStatus.textContent = 'Saving…';
    settingsSaveStatus.className = '';
    vscode.postMessage({ type: 'saveProfileSettings', provider: settingsProvider.value, model: settingsModel.value, apiKey: settingsApiKey.value });
});
document.addEventListener('click', (event) => {
    if (!event.target.closest('.popover') && !event.target.closest('.topbar-actions') && !event.target.closest('#agent-picker-btn')) closePopovers();
});
document.getElementById('create-agent-btn')?.addEventListener('click', openAgentModal);
document.getElementById('cancel-create-agent')?.addEventListener('click', () => agentModalBackdrop.classList.remove('visible'));
agentModalBackdrop.addEventListener('click', (event) => { if (event.target === agentModalBackdrop) agentModalBackdrop.classList.remove('visible'); });
agentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    agentFormError.textContent = '';
    submitCreateAgent.disabled = true;
    vscode.postMessage({ type: 'createProfile', name: agentNameInput.value, description: agentDescriptionInput.value, source: agentSourceSelect.value || undefined });
});
document.getElementById('btn-copy-install')?.addEventListener('click', () => vscode.postMessage({ type: 'copyInstallCmd' }));
document.getElementById('btn-check-install')?.addEventListener('click', () => vscode.postMessage({ type: 'checkInstall' }));
document.getElementById('btn-check-provider')?.addEventListener('click', () => vscode.postMessage({ type: 'checkProvider' }));
document.getElementById('btn-open-wizard')?.addEventListener('click', () => vscode.postMessage({ type: 'runSetup' }));
document.getElementById('btn-open-referral')?.addEventListener('click', () => vscode.postMessage({ type: 'openReferral' }));
attachFilesBtn?.addEventListener('click', () => {
    workspaceBrowserEl.classList.toggle('visible');
});
clearAttachmentsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'clearAttachments' }));
jumpLatestBtn.addEventListener('click', () => {
    shouldStickToBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    jumpLatestBtn.classList.remove('visible');
});
messagesEl.addEventListener('scroll', updateScrollStickiness);
sendBtn.disabled = !inputEl.value.trim();
inputEl.dispatchEvent(new Event('input'));
hydrateFromInitialState(initialData);
renderHistory(chatHistory);
renderProfiles(profiles, activeProfile);

window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'addMessage': addMessageToUI(msg.message); break;
        case 'startAssistantMessage': startAssistantMessage(msg.timestamp); break;
        case 'appendAssistantText': appendAssistantText(msg.text); break;
        case 'appendThought': appendThought(msg.text); break;
        case 'toolCall': renderTool(msg.tool); break;
        case 'toolCallUpdate': renderTool(msg.tool); break;
        case 'finalizeAssistantMessage': finalizeAssistantMessage(msg.usage); break;
        case 'stateSync': syncSessionState(msg); break;
        case 'profilesChanged': renderProfiles(msg.profiles || [], msg.activeProfile); break;
        case 'openSettingsPage': showSettingsPage(msg.settings, msg.profile); break;
        case 'profileSettingsSaved':
            saveProfileSettings.disabled = false;
            settingsSaveStatus.textContent = msg.ok ? 'Saved. New chats will use these settings.' : (msg.error || 'Unable to save settings.');
            settingsSaveStatus.className = msg.ok ? 'ok' : 'err';
            if (msg.ok) {
                settingsApiKey.value = '';
                settingsKeyHelp.textContent = msg.settings.apiKeyConfigured ? 'A key is configured for this agent.' : "Keys are stored locally in this agent's private .env file.";
            }
            break;
        case 'profileCreated':
            submitCreateAgent.disabled = false;
            if (msg.ok) {
                agentModalBackdrop.classList.remove('visible');
            } else {
                agentFormError.textContent = msg.error || 'Failed to create agent.';
            }
            break;
        case 'attachmentsChanged': renderAttachments(msg.files || []); break;
        case 'workspaceTree': renderWorkspaceTree(msg.tree || []); break;
        case 'historyChanged': renderHistory(msg.history || []); break;
        case 'clearMessages':
            messagesEl.innerHTML = '';
            if (welcomeEl) {
                messagesEl.appendChild(welcomeEl);
                welcomeEl.style.display = 'block';
            }
            currentAssistantEl = null;
            currentTextEl = null;
            currentToolsEl = null;
            toolEls = new Map();
            shouldStickToBottom = true;
            break;
        case 'replaceMessages':
            messagesEl.innerHTML = '';
            if (welcomeEl && !(msg.messages || []).length) {
                messagesEl.appendChild(welcomeEl);
                welcomeEl.style.display = 'block';
            } else if (welcomeEl) {
                welcomeEl.style.display = 'none';
            }
            currentAssistantEl = null;
            currentTextEl = null;
            currentToolsEl = null;
            toolEls = new Map();
            (msg.messages || []).forEach(addMessageToUI);
            shouldStickToBottom = true;
            messagesEl.scrollTop = messagesEl.scrollHeight;
            break;
        case 'setLoading':
            isProcessing = !!msg.loading;
            loadingEl.classList.toggle('visible', msg.loading);
            cancelBtn.classList.toggle('visible', msg.loading);
            if (!msg.loading) {
                inputEl.focus();
                sendBtn.disabled = !inputEl.value.trim();
            }
            if (msg.loading) maybeAutoScroll();
            break;
        case 'showError':
            const errDiv = document.createElement('div');
            errDiv.className = 'error';
            errDiv.textContent = msg.error;
            messagesEl.appendChild(errDiv);
            maybeAutoScroll();
            break;
        case 'installStatus': {
            const el = document.getElementById('install-status');
            if (el) { el.textContent = msg.text; el.className = 'setup-status ' + (msg.ok ? 'ok' : 'err'); }
            if (msg.ok) {
                const step = document.getElementById('setup-step-install');
                const step2 = document.getElementById('setup-step-provider');
                if (step) step.classList.add('done');
                if (step2) { step2.style.opacity = '1'; step2.style.pointerEvents = 'auto'; }
            }
            break;
        }
        case 'providerStatus': {
            const el = document.getElementById('provider-status');
            if (el) { el.textContent = msg.text; el.className = 'setup-status ' + (msg.ok ? 'ok' : 'err'); }
            if (msg.ok) {
                const setupEl = document.getElementById('welcome-setup');
                const readyEl = document.getElementById('welcome-ready');
                const inputArea = document.getElementById('input-area');
                if (setupEl) setupEl.style.display = 'none';
                if (readyEl) readyEl.style.display = 'block';
                if (inputArea) inputArea.style.display = '';
            }
            break;
        }
    }
});
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
