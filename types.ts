export const GMAIL_EXTENSION_ID = "gmail";
export const GMAIL_OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/gmail.send",
] as const;

export type GmailScope = (typeof GMAIL_OAUTH_SCOPES)[number];
export type GmailAddressInput = string | readonly string[];

export interface GoogleOAuthClientShape {
	client_id: string;
	client_secret?: string;
	redirect_uris?: string[];
}

export interface GoogleOAuthCredentialsFile {
	installed?: GoogleOAuthClientShape;
	web?: GoogleOAuthClientShape;
}

export interface GoogleOAuthClientCredentials {
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
}

export interface GoogleOAuthTokenSet {
	accessToken: string;
	refreshToken?: string;
	expiryDate?: number;
	scope?: string;
	tokenType?: string;
}

export interface GmailOAuthBootstrapState {
	consentUrl: string;
	scopes: readonly GmailScope[];
	redirectUri: string;
}

export interface GmailTokenStorePaths {
	baseDir: string;
	credentialsPath: string;
	tokenPath: string;
}

export interface GmailAuthStatus {
	paths: GmailTokenStorePaths;
	hasCredentials: boolean;
	hasTokens: boolean;
	activeAccountEmail?: string;
	tokenExpiryIso?: string;
}

export interface GmailApiHeader {
	name: string;
	value: string;
}

export interface GmailApiMessageBodyData {
	size?: number;
	data?: string;
	attachmentId?: string;
}

export interface GmailApiMessagePart {
	partId?: string;
	mimeType?: string;
	filename?: string;
	headers?: GmailApiHeader[];
	body?: GmailApiMessageBodyData;
	parts?: GmailApiMessagePart[];
}

export interface GmailApiMessage {
	id: string;
	threadId?: string;
	labelIds?: string[];
	snippet?: string;
	payload?: GmailApiMessagePart;
}

export interface GmailApiListMessagesResponse {
	messages?: Array<Pick<GmailApiMessage, "id" | "threadId">>;
	resultSizeEstimate?: number;
}

export interface GmailApiAttachmentResponse {
	size?: number;
	data?: string;
}

export interface GmailApiSendMessageResponse {
	id: string;
	threadId?: string;
	labelIds?: string[];
}

export interface GmailMessageSummary {
	id: string;
	threadId?: string;
	from: string;
	subject: string;
	date: string;
	snippet: string;
}

export interface GmailMessageBody {
	text: string;
	isTruncated: boolean;
	fullLength: number;
}

export interface GmailMessageAttachment {
	/** Stable attachment reference exposed to Pi users/tools. */
	attachmentId: string;
	/** Raw Gmail API attachment id used for the actual download request. */
	apiAttachmentId?: string;
	partId?: string;
	filename: string;
	mimeType: string;
	size: number;
	isInline: boolean;
	isDownloadable: boolean;
	contentId?: string;
	contentDisposition?: string;
}

export interface GmailMessageDetail {
	id: string;
	threadId?: string;
	labelIds: string[];
	from: string;
	to?: string;
	cc?: string;
	subject: string;
	date: string;
	snippet: string;
	body: GmailMessageBody;
	attachments: GmailMessageAttachment[];
}

export interface GmailListMessagesOptions {
	maxResults?: number;
	query?: string;
}

export interface GmailSearchMessagesOptions {
	query: string;
	maxResults?: number;
}

export interface GmailSendAttachmentInput {
	path: string;
	filename?: string;
	contentType?: string;
}

export interface GmailPreparedAttachment {
	path: string;
	filename: string;
	contentType: string;
	size: number;
}

export interface GmailSendMessageRequest {
	to: GmailAddressInput;
	subject: string;
	body?: string;
	htmlBody?: string;
	cc?: GmailAddressInput;
	bcc?: GmailAddressInput;
	replyTo?: string;
	attachments?: GmailSendAttachmentInput[];
}

export interface GmailPreparedSendMessage {
	raw: string;
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo?: string;
	subject: string;
	body?: string;
	htmlBody?: string;
	bodyPreview: string;
	attachments: GmailPreparedAttachment[];
}

export interface GmailAttachmentContent {
	attachmentId: string;
	messageId: string;
	data: Buffer;
	size: number;
}

export interface GmailSavedAttachment {
	attachmentId: string;
	messageId: string;
	filename: string;
	mimeType: string;
	size: number;
	isInline: boolean;
	savedPath: string;
	overwritten: boolean;
}

export interface GmailSendMessageResult {
	id: string;
	threadId?: string;
	labelIds: string[];
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo?: string;
	subject: string;
	bodyPreview: string;
	attachments: GmailPreparedAttachment[];
	hasHtmlBody: boolean;
}
