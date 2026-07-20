import { getContext, extension_settings } from "../../../extensions.js";
import { getRequestHeaders } from "../../../../script.js";
import {
	extensionName,
	VN_MODES,
	PROME_CG_FOLDER,
	PROME_TEXTBOX_FOLDER,
	PROME_TEXTBOX_CONFIG_EXTENSION,
} from "./constants.js";

/**
 * Returns the last character chat message
 * @returns {object} - The last character chat message
 */
export function getLastChatMessage() {
	const context = getContext();
	const reversedChat = context.chat.slice().reverse();

	return reversedChat.filter((mes) => !mes.is_system && !mes.extra?.image);
}

/**
 * Lists out the characters that have spoken recently
 * @param {number?} limit - The number of characters to return
 * @returns {string[]} - An array of character original avatars
 */
export function getRecentTalkingCharacters(limit) {
	const context = getContext();
	const reversedChat = context.chat.slice().reverse();
	const activeGroup = context.groups.find((x) => x.id === context.groupId);
	const members = activeGroup?.members;

	// Filter out system messages, images, user messages, and inactive/removed characters
	const talkingCharacters = reversedChat
		.filter((mes) => !mes.is_system && !mes.extra?.image && !mes.is_user)
		.map((mes) => mes.original_avatar)
		.filter((avatar) => members?.some((member) => member === avatar));

	// Purge duplicates
	const uniqueTalkingCharacters = [...new Set(talkingCharacters)];

	if (limit) {
		// Limit the number of characters to return
		// If the number of characters is less than the limit, return all characters
		if (uniqueTalkingCharacters.length < limit) {
			return uniqueTalkingCharacters;
		}
		return uniqueTalkingCharacters.slice(0, limit);
	}
	return uniqueTalkingCharacters;
}

/**
 * Returns the current chat ID
 * @returns {string} - The current chat ID
 */
export function getChatId() {
	const context = getContext();
	return context.getCurrentChatId();
}

/**
 * Returns whether letterbox mode is enabled
 * @returns {boolean} - Whether letterbox mode is enabled
 */
export function isLetterboxModeEnabled() {
	return Boolean(
		extension_settings[extensionName].letterboxMode !== VN_MODES.NONE,
	);
}

/**
 * Returns whether the chat box (sheld) is visible
 * @returns {boolean} - Whether the chat box is visible
 */
export function isSheldVisible() {
	return Boolean(!extension_settings[extensionName].hideSheld);
}

/**
 * Returns whether user sprites are enabled
 * @returns {boolean} - Whether user sprites are enabled
 */
export function isUserSpriteEnabled() {
	return Boolean(extension_settings[extensionName].enableUserSprite);
}

/**
 * Returns whether auto-hide sprites are enabled
 * @returns {boolean} - Whether sprites should be auto-hidden
 */
export function isAutoHideSpritesEnabled() {
	return Boolean(extension_settings[extensionName].autoHideSprites);
}

/**
 * Fetches the sprite list for a given sprite pack
 * @param {string} name - The name of the sprite pack
 * @returns {Promise<{sprites: object[], err: Error|null}>} - The list of sprites and any error encountered
 */
export async function getSpriteList(name) {
	try {
		const result = await fetch(
			`/api/sprites/get?name=${encodeURIComponent(name)}`,
		);
		const sprites = result.ok ? await result.json() : [];
		return { sprites, err: null };
	} catch (err) {
		return { sprites: [], err };
	}
}

/**
 * Returns the index of the current group (or -1 if not found)
 * @returns {number} - The index of the current group
 */
export function getGroupIndex() {
	const context = getContext();
	const groupIndex = context.groups.findIndex((x) => {
		return x.id === context.groupId;
	});
	return groupIndex;
}

/**
 * Returns whether the current chat is a group chat
 * @returns {boolean} - Whether the current chat is a group chat
 */
export function isGroupChat() {
	const context = getContext();
	return context.groupId !== null;
}

/**
 * Check if the member is disabled in the group chat
 * @param {string} name - The member name
 * @returns {boolean} - Whether the member is disabled in the group chat
 */
export function isDisabledMember(name) {
	const context = getContext();
	const group = context.groups.find((x) => x.id === context.groupId);
	if (!group) return false;
	return group.disabled_members.includes(name);
}

/**
 * Checks if a sprite pack exists
 * @param {string} spritePack - The name of the sprite pack
 * @returns {Promise<boolean>} - Whether the sprite pack exists
 */
export async function spritePackExists(spritePack) {
	if (spritePack.length === 0) return false;
	const { sprites, err } = await getSpriteList(spritePack);
	if (err) {
		console.error(
			`[${extensionName}] Error checking sprite pack "${spritePack}": ${err}`,
		);
		return false;
	}
	return sprites.length > 0;
}

/**
 * Resolves the sprite folder name for a character, respecting any
 * expression folder override the user has configured (see `/expression-folder-override`).
 * @param {object} character - The character object
 * @returns {string} - The sprite folder name to look up sprites under
 */
export function getSpriteFolderName(character) {
	const avatarFileName = character.avatar.replace(/\.[^/.]+$/, "");
	const override = extension_settings.expressionOverrides?.find(
		(e) => e.name === avatarFileName,
	);
	return override?.path || character.name;
}

/**
 * Fetches the list of available expression labels (sprites) for a character,
 * including any custom-named sprites the user has added.
 * @param {object} character - The character object
 * @returns {Promise<string[]>} - A unique list of available expression labels
 */
export async function getAvailableExpressions(character) {
	if (!character) return [];

	const spriteFolderName = getSpriteFolderName(character);
	const { sprites, err } = await getSpriteList(spriteFolderName);

	if (err) {
		console.error(
			`[${extensionName}] Error fetching expressions for "${spriteFolderName}": ${err}`,
		);
		return [];
	}

	return [...new Set(sprites.map((sprite) => sprite.label))];
}

/**
 * Fetches the list of available background images, both the global/system
 * backgrounds and the ones locked to the current chat.
 * @returns {Promise<{global: string[], chat: string[]}>} - The available backgrounds
 */
export async function getAvailableBackgrounds() {
	let global = [];

	try {
		const response = await fetch("/api/backgrounds/all", {
			method: "POST",
			headers: getRequestHeaders(),
			body: JSON.stringify({}),
		});

		if (response.ok) {
			const { images } = await response.json();
			global = images.map((image) => image.filename);
		}
	} catch (err) {
		console.error(`[${extensionName}] Error fetching background list: ${err}`);
	}

	const context = getContext();
	const chat = context.chatMetadata?.chat_backgrounds ?? [];

	return { global, chat };
}

/**
 * Lists the image files stored in one of the user's `user/images/<folder>` directories.
 * The folder is automatically created server-side if it doesn't already exist.
 * @param {string} folder - The folder name under `user/images`
 * @returns {Promise<string[]>} - The list of file names found in the folder
 */
async function listUserImageFolder(folder) {
	try {
		const response = await fetch("/api/images/list", {
			method: "POST",
			headers: getRequestHeaders(),
			body: JSON.stringify({ folder }),
		});

		if (!response.ok) return [];
		return await response.json();
	} catch (err) {
		console.error(`[${extensionName}] Error listing image folder "${folder}": ${err}`);
		return [];
	}
}

/**
 * Fetches the list of available CG labels (file names without extension) from the
 * dedicated Prome CG folder (`user/images/prome-cgs`).
 * @returns {Promise<string[]>} - The available CG labels
 */
export async function getAvailableCGs() {
	const files = await listUserImageFolder(PROME_CG_FOLDER);
	return files.map((file) => file.replace(/\.[^/.]+$/, ""));
}

/**
 * Ensures the Prome CG and textbox asset folders exist on the server, creating them
 * if necessary.
 * @returns {Promise<void>}
 */
export async function ensurePromeAssetFolders() {
	await Promise.all([
		listUserImageFolder(PROME_CG_FOLDER),
		listUserImageFolder(PROME_TEXTBOX_FOLDER),
	]);
}

/**
 * Fetches and parses a textbox's JSON configuration file directly from its public URL.
 * @param {string} configUrl - The public URL of the configuration file
 * @returns {Promise<object|null>} - The parsed configuration, or null if it couldn't be loaded
 */
export async function fetchTextboxConfig(configUrl) {
	try {
		const response = await fetch(configUrl);
		if (!response.ok) return null;
		return await response.json();
	} catch (err) {
		console.error(`[${extensionName}] Error fetching textbox config "${configUrl}": ${err}`);
		return null;
	}
}

/**
 * Lists the available custom textboxes. A textbox is a pair of files sharing the same
 * base name inside the Prome textbox folder: an image (the frame) and a JSON config
 * (the safe areas for the name/dialogue text). Only images with a matching config file
 * are considered valid textboxes.
 * @returns {Promise<{name: string, imageUrl: string, config: object}[]>} - The available textboxes
 */
export async function getAvailableTextboxes() {
	const files = await listUserImageFolder(PROME_TEXTBOX_FOLDER);
	const textboxes = [];

	for (const file of files) {
		const baseName = file.replace(/\.[^/.]+$/, "");
		const imageUrl = `/user/images/${PROME_TEXTBOX_FOLDER}/${encodeURIComponent(file)}`;
		const configUrl = `/user/images/${PROME_TEXTBOX_FOLDER}/${encodeURIComponent(baseName)}${PROME_TEXTBOX_CONFIG_EXTENSION}`;
		const config = await fetchTextboxConfig(configUrl);

		// A textbox is only valid if it has a matching JSON configuration file.
		if (!config) continue;

		textboxes.push({ name: baseName, imageUrl, config });
	}

	return textboxes;
}