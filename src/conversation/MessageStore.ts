import type { ConversationRecord, MessageRecord } from "@ai-coding-agent/types";

export interface MessageStore {
  create(conversation: ConversationRecord): void;
  getConversation(id: string): ConversationRecord | undefined;
  listConversations(): ConversationRecord[];
  append(message: MessageRecord): void;
  appendMany(conversationId: string, messages: MessageRecord[]): void;
  history(conversationId: string): MessageRecord[];
  delete(conversationId: string): void;
}

/** In-memory conversation + message store (SQLite replaces it in M5). */
export function createMessageStore(): MessageStore {
  const conversations = new Map<string, ConversationRecord>();
  const messages = new Map<string, MessageRecord[]>();

  function create(conversation: ConversationRecord): void {
    conversations.set(conversation.id, conversation);
    messages.set(conversation.id, []);
  }

  function getConversation(id: string): ConversationRecord | undefined {
    return conversations.get(id);
  }

  function listConversations(): ConversationRecord[] {
    return [...conversations.values()];
  }

  function append(message: MessageRecord): void {
    const list = messages.get(message.conversationId);
    if (list) list.push(message);
  }

  function appendMany(conversationId: string, records: MessageRecord[]): void {
    const list = messages.get(conversationId);
    if (list) list.push(...records);
  }

  function history(conversationId: string): MessageRecord[] {
    return messages.get(conversationId) ?? [];
  }

  function deleteConversation(conversationId: string): void {
    conversations.delete(conversationId);
    messages.delete(conversationId);
  }

  return { create, getConversation, listConversations, append, appendMany, history, delete: deleteConversation };
}
