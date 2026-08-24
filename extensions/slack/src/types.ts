// Slack type declarations define plugin contracts.
export type SlackFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  subtype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

export type SlackAttachment = {
  fallback?: string;
  title?: string;
  text?: string;
  pretext?: string;
  author_name?: string;
  author_id?: string;
  from_url?: string;
  ts?: string;
  channel_name?: string;
  channel_id?: string;
  is_msg_unfurl?: boolean;
  is_share?: boolean;
  image_url?: string;
  image_width?: number;
  image_height?: number;
  thumb_url?: string;
  files?: SlackFile[];
  fields?: Array<{ title?: string; value?: string }>;
  blocks?: unknown[];
  message_blocks?: unknown[];
};

export type SlackMessageEvent = {
  type: "message";
  user?: string;
  bot_id?: string;
  /** Slack app ID stamped on messages an app sends on a user's behalf. */
  app_id?: string;
  subtype?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  blocks?: unknown[];
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  assistant_thread?: Record<string, unknown>;
  /**
   * Internal OpenClaw id for synthetic events that must keep Slack's real ts
   * for routing while using a distinct inbound id for dedupe.
   */
  openclaw_synthetic_message_id?: string;
  /** Internal-only target used to replace a reviewed bot answer in place. */
  openclaw_replace_message_ts?: string;
  /**
   * Set by the thread_ts resolver when Slack supplied parent_user_id but the
   * parent thread timestamp could not be recovered.
   */
  _ambiguousThreadReply?: boolean;
};

export type SlackAppMentionEvent = {
  type: "app_mention";
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  attachments?: SlackAttachment[];
};
