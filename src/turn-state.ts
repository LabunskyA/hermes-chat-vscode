import { ChatMessage, ToolCallInfo } from './types';

export interface TurnState {
    message: ChatMessage;
    thought: string;
}

export interface TurnUpdate {
    sessionUpdate: string;
    [key: string]: unknown;
}

export function createTurnState(timestamp = Date.now()): TurnState {
    return {
        message: {
            role: 'assistant',
            content: '',
            timestamp,
            toolCalls: [],
        },
        thought: '',
    };
}

export function reduceTurn(state: TurnState, update: TurnUpdate): TurnState {
    switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type !== 'text' || !content.text) return state;
            return withMessage(state, { content: state.message.content + content.text });
        }
        case 'agent_thought_chunk': {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type !== 'text' || !content.text) return state;
            return { ...state, thought: state.thought + content.text };
        }
        case 'tool_call': {
            const tool: ToolCallInfo = {
                id: String(update.toolCallId),
                name: String(update.title || update.kind || 'tool'),
                status: (update.status as ToolCallInfo['status']) || 'in_progress',
                args: update.rawInput,
            };
            return withMessage(state, { toolCalls: [...(state.message.toolCalls ?? []), tool] });
        }
        case 'tool_call_update': {
            const id = String(update.toolCallId);
            const tools = state.message.toolCalls ?? [];
            if (!tools.some((tool) => tool.id === id)) return state;
            return withMessage(state, {
                toolCalls: tools.map((tool) => tool.id === id ? updateTool(tool, update) : tool),
            });
        }
        case 'usage_update': {
            if (!update.usage) return state;
            return withMessage(state, { usage: update.usage as ChatMessage['usage'] });
        }
        default:
            return state;
    }
}

function withMessage(state: TurnState, changes: Partial<ChatMessage>): TurnState {
    return { ...state, message: { ...state.message, ...changes } };
}

function updateTool(tool: ToolCallInfo, update: TurnUpdate): ToolCallInfo {
    const result = update.rawOutput === undefined
        ? tool.result
        : typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
    return {
        ...tool,
        status: inferToolFailure(update.rawOutput)
            ? 'failed'
            : (update.status as ToolCallInfo['status']) || tool.status,
        result,
    };
}

export function inferToolFailure(rawOutput: unknown): boolean {
    if (rawOutput == null) return false;
    const text = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
    try {
        const parsed = JSON.parse(text);
        return Boolean(parsed && typeof parsed === 'object'
            && (parsed.success === false || (typeof parsed.error === 'string' && parsed.error.trim())));
    } catch {
        return false;
    }
}
