import { extensionName, CLASSIFICATION_METHODS, EXPRESSION_API_NONE } from "../constants.js";
import { extension_settings, getContext } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import {
	isGroupChat,
	getAvailableExpressions,
	getAvailableBackgrounds,
	getAvailableCGs,
	getSpriteFolderName,
} from "../utils.js";
import { playSequenceInTextbox } from "./textbox.js";

/* Console Log Styling */
const LOG_TAG = `%c[Prome Analysis]%c`;
const LOG_STYLE_TAG = "background:#6a3fbf;color:#fff;padding:1px 6px;border-radius:3px;font-weight:bold;";
const LOG_STYLE_INFO = "color:#7fdbff;";
const LOG_STYLE_SUCCESS = "color:#2ecc71;font-weight:bold;";
const LOG_STYLE_ERROR = "color:#ff4d4d;font-weight:bold;";
const LOG_STYLE_WARN = "color:#f1c40f;font-weight:bold;";

function settings() {
	return extension_settings[extensionName];
}

function trimTrailingSlash(url) {
	return String(url ?? "").trim().replace(/\/+$/, "");
}

function buildHeaders() {
	const headers = { "Content-Type": "application/json" };
	const apiKey = settings().llmAnalysisApiKey;
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	return headers;
}

/* ---------------------------------------------------------------------- */
/* Per-Chat Analysis Memory                                                */
/* ---------------------------------------------------------------------- */
/*
 * Everything below is stored in `chatMetadata.promeAnalysis`, so it's scoped to the
 * current chat file and persisted via `saveMetadata()`. Structure:
 * {
 *   summary: { text: string, uptoIndex: number, updatedAt: number } | null,
 *   history: { [messageIndex: string]: { [swipeId: string]: {
 *     textHash: string, sequence: object[], resolvedBackground: string|null, updatedAt: number
 *   } } },
 * }
 * `history` doubles as both a replay cache (skip re-analyzing a message/swipe that was
 * already classified) and the source for the "recent backgrounds" prompt context below.
 * Entries are keyed by message index + swipe id, but are only ever trusted if their
 * stored `textHash` still matches the message's current text - this makes the cache
 * self-healing across message deletions/edits/reindexing without needing to explicitly
 * track or repair index shifts.
 */

/**
 * Computes a short, deterministic hash (FNV-1a, 32-bit) of a string. Used to detect
 * whether a message's text still matches a previously cached analysis result.
 * @param {string} text
 * @returns {string} - The hash, as a hex string
 */
function hashText(text) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/**
 * Gets (creating if necessary) the Prome analysis metadata object for the current chat.
 * Always re-reads `chatMetadata` fresh from `getContext()` rather than caching a
 * reference, since the metadata object is replaced whenever the chat changes.
 * @returns {{summary: object|null, history: object}}
 */
function getMeta() {
	const context = getContext();
	context.chatMetadata.promeAnalysis = context.chatMetadata.promeAnalysis || {
		summary: null,
		history: {},
	};
	return context.chatMetadata.promeAnalysis;
}

/**
 * Persists the current chat's metadata to the server.
 */
function saveMeta() {
	getContext().saveMetadata?.();
}

/**
 * Looks up a previously stored analysis result for a message/swipe, but only returns it
 * if the message's current text still matches the hash it was stored with.
 * @param {number} messageId
 * @param {number} swipeId
 * @param {string} textHash
 * @returns {{sequence: object[], resolvedBackground: string|null}|null}
 */
function getCachedAnalysis(messageId, swipeId, textHash) {
	const entry = getMeta().history?.[messageId]?.[swipeId];
	return entry && entry.textHash === textHash ? entry : null;
}

/**
 * Stores a classified sequence for a message/swipe, keyed alongside the text hash it
 * was produced from, so it can be safely replayed later without re-invoking the LLM.
 * @param {number} messageId
 * @param {number} swipeId
 * @param {string} textHash
 * @param {object[]} sequence
 * @param {string|null} resolvedBackground - The background in effect at the end of this message
 */
function storeAnalysis(messageId, swipeId, textHash, sequence, resolvedBackground) {
	const meta = getMeta();
	meta.history[messageId] = meta.history[messageId] || {};
	meta.history[messageId][swipeId] = {
		textHash,
		sequence,
		resolvedBackground: resolvedBackground ?? null,
		updatedAt: Date.now(),
	};
	saveMeta();
}

/**
 * Finds the most recently resolved background from any previously analyzed message
 * before the given index, walking backwards through the chat.
 * @param {number} beforeMessageId
 * @returns {string|null}
 */
function getPreviousResolvedBackground(beforeMessageId) {
	const context = getContext();
	const meta = getMeta();

	for (let idx = beforeMessageId - 1; idx >= 0; idx--) {
		const message = context.chat[idx];
		if (!message || message.is_user || message.is_system) continue;

		const swipeId = message.swipe_id ?? 0;
		const entry = meta.history?.[idx]?.[swipeId];
		if (entry) return entry.resolvedBackground ?? null;
	}

	return null;
}

/**
 * Walks the resolved background of each previously analyzed message before the given
 * index, most recent first, collecting up to `count` entries in chronological order.
 * Used to give the LLM continuity context on which backgrounds have recently been used.
 * @param {number} beforeMessageId
 * @param {number} count
 * @returns {string[]}
 */
function getRecentBackgroundHistory(beforeMessageId, count) {
	if (!count) return [];

	const context = getContext();
	const meta = getMeta();
	const results = [];

	for (let idx = beforeMessageId - 1; idx >= 0 && results.length < count; idx--) {
		const message = context.chat[idx];
		if (!message || message.is_user || message.is_system) continue;

		const swipeId = message.swipe_id ?? 0;
		const entry = meta.history?.[idx]?.[swipeId];
		if (entry?.resolvedBackground) {
			results.unshift(entry.resolvedBackground);
		}
	}

	return results;
}

/**
 * Returns the last `count` chat messages (user and character alike, system messages
 * excluded) before the given message index, formatted as `Name: text` lines.
 * @param {number} beforeMessageId
 * @param {number} count
 * @returns {string[]}
 */
function getRecentChatHistoryLines(beforeMessageId, count) {
	if (!count) return [];

	const context = getContext();
	const start = Math.max(0, beforeMessageId - count);

	return context.chat
		.slice(start, beforeMessageId)
		.filter((message) => message && !message.is_system && message.mes)
		.map((message) => `${message.name}: ${message.mes}`);
}

/**
 * Simulates playback of a classified sequence to determine which background is in
 * effect by the end of the message, carrying forward the previous background if the
 * message never changes it.
 * @param {number} messageId
 * @param {object[]} sequence
 * @returns {string|null}
 */
function computeResolvedBackground(messageId, sequence) {
	let current = getPreviousResolvedBackground(messageId);
	for (const segment of sequence) {
		if (segment.background) current = segment.background;
	}
	return current;
}

/* ---------------------------------------------------------------------- */
/* Rolling Summary                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Generates (or updates) the rolling story summary for the current chat, covering all
 * messages since the last summary (or the whole chat, if none exists yet), using the
 * same LLM endpoint/model configured for classification.
 * @param {number} uptoIndex - The message index the summary should be updated up to (inclusive)
 */
async function generateSummary(uptoIndex) {
	const url = trimTrailingSlash(settings().llmAnalysisUrl);
	const model = settings().llmAnalysisModel;
	if (!url || !model) return;

	const meta = getMeta();
	const previousSummary = meta.summary;
	const fromIndex = previousSummary ? previousSummary.uptoIndex + 1 : 0;

	const context = getContext();
	const messageLines = context.chat
		.slice(Math.max(0, fromIndex), uptoIndex + 1)
		.filter((message) => message && !message.is_system && message.mes)
		.map((message) => `${message.name}: ${message.mes}`);

	if (messageLines.length === 0) return;

	const promptLines = [
		"You are maintaining a concise, up-to-date summary of an ongoing visual novel-style roleplay chat.",
		"Write a short brief (a few sentences) covering: the story so far, where the characters currently are (location), and the current time of day, if it can be determined.",
		"Keep it concise and focused on facts useful for continuity (location/scene, time of day, key relationship/plot state). Do not quote dialogue verbatim.",
	];

	if (previousSummary?.text) {
		promptLines.push(
			"",
			"Previous summary:",
			previousSummary.text,
			"",
			"Update the summary to incorporate the following new messages:",
		);
	} else {
		promptLines.push("", "Summarize the following messages:");
	}

	promptLines.push("", ...messageLines);

	console.log(
		`${LOG_TAG} Updating rolling summary (messages ${fromIndex}-${uptoIndex})...`,
		LOG_STYLE_TAG, LOG_STYLE_INFO,
	);

	try {
		const response = await fetch(`${url}/chat/completions`, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				model,
				messages: [{ role: "system", content: promptLines.join("\n") }],
				temperature: 0.5,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		const text = data?.choices?.[0]?.message?.content?.trim();
		if (!text) throw new Error("Empty summary response.");

		meta.summary = { text, uptoIndex, updatedAt: Date.now() };
		saveMeta();

		console.log(`${LOG_TAG} Rolling summary updated:`, LOG_STYLE_TAG, LOG_STYLE_SUCCESS, text);
	} catch (err) {
		console.error(`${LOG_TAG} Failed to update rolling summary:`, LOG_STYLE_TAG, LOG_STYLE_ERROR, err);
	}
}

/**
 * Checks whether enough new messages have accumulated since the last rolling summary
 * to warrant generating a new one, and does so if needed. Safe to call on every
 * classified message - does nothing if summaries are disabled or the interval hasn't
 * elapsed yet.
 * @param {number} currentMessageIndex
 */
async function maybeUpdateSummary(currentMessageIndex) {
	if (!settings().summaryEnabled) return;

	const interval = Math.max(1, Number(settings().summaryInterval) || 10);
	const lastIndex = getMeta().summary?.uptoIndex ?? -1;
	if (currentMessageIndex - lastIndex < interval) return;

	await generateSummary(currentMessageIndex);
}

/* ---------------------------------------------------------------------- */
/* Classification Method Switching                                        */
/* ---------------------------------------------------------------------- */

/**
 * Ensures ST's built-in expression classification engine is disabled while
 * LLM-Based classification is active (and restores it when switching back).
 */
export function applyClassificationMethod() {
	extension_settings.expressions = extension_settings.expressions || {};

	if (settings().classificationMethod === CLASSIFICATION_METHODS.LLM) {
		if (settings().previousExpressionApi === null || settings().previousExpressionApi === undefined) {
			settings().previousExpressionApi = extension_settings.expressions.api ?? null;
		}

		if (extension_settings.expressions.api !== EXPRESSION_API_NONE) {
			extension_settings.expressions.api = EXPRESSION_API_NONE;
			const $apiSelect = $("#expression_api");
			if ($apiSelect.length) {
				$apiSelect.val(String(EXPRESSION_API_NONE)).trigger("change");
			}
		}

		console.log(
			`${LOG_TAG} LLM-Based classification is active. ST's built-in sprite classifier has been disabled.`,
			LOG_STYLE_TAG, LOG_STYLE_INFO,
		);
	} else if (settings().previousExpressionApi !== null && settings().previousExpressionApi !== undefined) {
		extension_settings.expressions.api = settings().previousExpressionApi;
		const $apiSelect = $("#expression_api");
		if ($apiSelect.length) {
			$apiSelect.val(String(settings().previousExpressionApi)).trigger("change");
		}
		settings().previousExpressionApi = null;
	}

	saveSettingsDebounced();
}

/* ---------------------------------------------------------------------- */
/* Model Fetching                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Fetches the list of available models from the configured OpenAI-compatible endpoint
 * and populates the model select dropdown.
 */
export async function fetchAvailableModels() {
	const url = trimTrailingSlash(settings().llmAnalysisUrl);
	const $select = $("#prome-analysis-model");

	if (!url) {
		toastr.error("Please enter a valid API URL first.", "Prome Analysis");
		return;
	}

	$select.empty();
	$select.append($("<option></option>").val("").text("Fetching models..."));

	try {
		const response = await fetch(`${url}/models`, {
			method: "GET",
			headers: buildHeaders(),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		const rawModels = data?.data ?? data?.models ?? [];
		const models = rawModels
			.map((model) => (typeof model === "string" ? model : model?.id))
			.filter(Boolean)
			.sort();

		if (models.length === 0) {
			throw new Error("No models were returned by the endpoint.");
		}

		settings().llmAnalysisAvailableModels = models;

		$select.empty();
		for (const model of models) {
			$select.append($("<option></option>").val(model).text(model));
		}

		if (models.includes(settings().llmAnalysisModel)) {
			$select.val(settings().llmAnalysisModel);
		} else {
			settings().llmAnalysisModel = models[0];
			$select.val(models[0]);
		}

		saveSettingsDebounced();
		toastr.success(`Fetched ${models.length} model(s).`, "Prome Analysis");
	} catch (err) {
		console.error(`${LOG_TAG} Failed to fetch models:`, LOG_STYLE_TAG, LOG_STYLE_ERROR, err);
		$select.empty();
		$select.append($("<option></option>").val("").text("No models available"));
		toastr.error(`Could not fetch models: ${err.message}`, "Prome Analysis");
	}
}

/* ---------------------------------------------------------------------- */
/* LLM-Based Message Analysis                                             */
/* ---------------------------------------------------------------------- */

function buildSystemPrompt({ expressions, backgrounds, cgs, segmentLimit, summaryText, backgroundHistory, chatHistoryLines }) {
	const schemaExample = {
		sequence: [
			{
				text_segment: "string (an exact, contiguous substring of the message)",
				expression: "string|null",
				background: "string|null",
				cg: "string|null",
			},
		],
	};

	const lines = [
		"You are the narrative director of a visual novel-style roleplay chat.",
		"You will be given the latest message from a character. Split the message into consecutive segments based on shifts in emotion/expression or scene/background, then choose the best matching expression, background and CG for each segment.",
		"",
		`Available expressions for this character: ${expressions.length ? expressions.join(", ") : "(none available)"}`,
		`Available backgrounds: ${backgrounds.length ? backgrounds.join(", ") : "(none available)"}`,
		`Available CGs: ${cgs.length ? cgs.join(", ") : "(none available yet, always use null)"}`,
	];

	if (summaryText) {
		lines.push(
			"",
			"Story summary so far (for context only - do not classify or output segments for this):",
			summaryText,
		);
	}

	if (chatHistoryLines?.length) {
		lines.push(
			"",
			"Recent chat history, most recent last (for context only - do not classify or output segments for this):",
			...chatHistoryLines,
		);
	}

	if (backgroundHistory?.length) {
		lines.push(
			"",
			`On the last ${backgroundHistory.length} message(s), the backgrounds in effect were, in order:`,
			...backgroundHistory.map((bg) => `- ${bg}`),
			"Use this only as a continuity reference for which background is currently active. Only change the background if the new message's text clearly indicates the scene/location changed - do not change it just because it's listed here.",
		);
	}

	lines.push(
		"",
		"Your task must be done accurately: carefully read the whole message first and identify every point where the character's emotion/expression changes, and every point where the scene/location (background) changes, before splitting it into segments. Do not miss real changes, and do not invent changes that are not actually there.",
		"",
		"Rules:",
		"- Only use values from the lists above, matched exactly (case-sensitive), for \"expression\", \"background\" and \"cg\".",
		"- \"expression\" must NEVER be null or an empty string. Every single segment, with no exceptions, must specify the character's current expression as one of the exact values from the \"Available expressions\" list above, even if it is the same expression as the previous segment (i.e. the character's expression did not change in that segment). Pick whichever available expression most closely matches the character's emotional/physical state during that segment.",
		"- \"background\" should be null for the vast majority of segments. Only set \"background\" to a non-null value when the scene or location explicitly changes in the text, such as the character moving from the street into a cafe, entering a different room, or a stated environmental shift happening (e.g. 'the sun set over the forest', 'we arrived at the beach'). Do not set a background just because a segment exists, just because the character's expression changes, or just because a new sentence starts.",
		"- \"cg\" should be null unless a special event should show a CG instead of the character sprite.",
		"- Never output a value for \"expression\", \"background\" or \"cg\" that isn't an exact, verbatim entry from the lists above. If you are unsure, pick the closest matching entry from the list rather than inventing a new one (except \"background\"/\"cg\", which may be null).",
		"- Segments with empty or whitespace-only text_segment values are FORBIDDEN. Every segment must contain meaningful text from the message. Do not create a separate segment just for a space between sentences or quotes. If a boundary would result in a whitespace-only segment, merge that whitespace into the adjacent segment instead.",
		"",
		"CRITICAL TEXT INTEGRITY RULES (violating these invalidates your entire response):",
		"- \"text_segment\" must be an EXACT, VERBATIM, contiguous substring of the original message: same characters, spelling, punctuation, capitalization, whitespace, quotes, asterisks and formatting.",
		"- You must NEVER paraphrase, translate, summarize, censor, correct typos/grammar, add, or remove any text, including emotes, action markers (e.g. *text*), or punctuation.",
		"- Concatenating every \"text_segment\" in order, with nothing added, removed, or reordered, must reproduce the original message character-for-character.",
		"- Every single character of the original message must belong to exactly one segment. Do not skip or drop any part of the message.",
	);

	if (segmentLimit) {
		lines.push(
			"",
			`- Do not produce more than ${segmentLimit} segment(s) in total. Merge adjacent portions of text together (while still picking the best classification for the merged segment) if you need to stay within this limit.`,
		);
	}

	lines.push(
		"",
		"Respond with ONLY valid JSON matching this schema, no commentary, no markdown code fences:",
		JSON.stringify(schemaExample, null, 2),
	);

	return lines.join("\n");
}

function parseSequenceResponse(content) {
	if (!content) return null;

	let text = content.trim();

	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch) {
		text = fenceMatch[1].trim();
	}

	const tryParse = (candidate) => {
		try {
			const parsed = JSON.parse(candidate);
			return Array.isArray(parsed?.sequence) ? parsed : null;
		} catch {
			return null;
		}
	};

	const direct = tryParse(text);
	if (direct) return direct;

	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		const sliced = tryParse(text.slice(firstBrace, lastBrace + 1));
		if (sliced) return sliced;
	}

	return null;
}

/**
 * Guarantees that a classified sequence reproduces the original message text exactly,
 * character-for-character. The LLM is instructed to never alter the original text, but
 * models can still drop, rewrite, or reorder text. This realigns every segment against
 * the untouched original text so no characters are ever lost or changed, discarding any
 * classification that can no longer be trusted to line up with the real text.
 * @param {{sequence: object[]}} parsed - The parsed LLM response
 * @param {string} originalText - The original, untouched message text
 * @returns {{sequence: object[], modified: boolean}} - The reconciled sequence
 */
function reconcileSequenceWithOriginalText(parsed, originalText) {
	const rawSequence = Array.isArray(parsed?.sequence) ? parsed.sequence : [];
	const reconciled = [];
	let cursor = 0;
	let modified = false;

	for (const item of rawSequence) {
		const segment = typeof item?.text_segment === "string" ? item.text_segment : "";
		const hasClassification = Boolean(item?.expression || item?.background || item?.cg);

		if (!segment) {
			// A segment with no text AND no expression/background/cg is completely empty -
			// discard it entirely so it never reaches the playback pipeline.
			if (!hasClassification) {
				modified = true;
				continue;
			}

			// Textless but still classified (e.g. a silent expression/background change):
			// keep it without consuming any of the original text.
			reconciled.push({
				text_segment: "",
				expression: item.expression ?? null,
				background: item.background ?? null,
				cg: item.cg ?? null,
			});
			continue;
		}

		// Only ever search forward from the cursor: segments must stay in order.
		const idx = originalText.indexOf(segment, cursor);

		if (idx === -1) {
			// The model altered this segment's text (or reordered it); it can no longer
			// be trusted, so drop the classification for it. The underlying text is
			// restored later via the "leftover text" gap-filling below.
			modified = true;
			continue;
		}

		if (idx > cursor) {
			// The model skipped over a chunk of the original text; restore it verbatim
			// with no classification of its own, so nothing is ever lost.
			reconciled.push({
				text_segment: originalText.slice(cursor, idx),
				expression: null,
				background: null,
				cg: null,
			});
			modified = true;
		}

		reconciled.push({
			text_segment: segment,
			expression: item.expression ?? null,
			background: item.background ?? null,
			cg: item.cg ?? null,
		});

		cursor = idx + segment.length;
	}

	if (cursor < originalText.length) {
		// Trailing text the model never accounted for at all.
		reconciled.push({
			text_segment: originalText.slice(cursor),
			expression: null,
			background: null,
			cg: null,
		});
		modified = true;
	}

	// Final safety net: if the reconciled sequence still doesn't reproduce the
	// original text exactly (e.g. no usable segments at all), fall back to a
	// single, unclassified segment containing the fully untouched original text.
	const rebuilt = reconciled.map((item) => item.text_segment).join("");
	if (rebuilt !== originalText) {
		return {
			sequence: [{ text_segment: originalText, expression: null, background: null, cg: null }],
			modified: true,
		};
	}

	return { sequence: reconciled, modified };
}

/**
 * Guarantees that every segment ends up with a valid, non-null expression taken from the
 * character's actual available sprites, and that "background"/"cg" are either null or a
 * value that actually exists. The LLM is instructed to always pick a real expression and
 * never invent values, but it can still hallucinate a name, or leave a segment's expression
 * empty/null - this closes that gap client-side so a segment with no expression can never
 * reach the playback pipeline.
 * @param {object[]} sequence - The reconciled sequence
 * @param {string[]} validExpressions - The character's actual available expression labels
 * @param {string[]} validBackgrounds - The actual available background names
 * @param {string[]} validCgs - The actual available CG names
 * @returns {{sequence: object[], modified: boolean}} - The validated sequence
 */
function validateSequenceClassifications(sequence, validExpressions, validBackgrounds, validCgs) {
	let modified = false;
	let lastValidExpression = null;

	const validated = sequence.map((item) => {
		const result = { ...item };

		if (result.expression && validExpressions.includes(result.expression)) {
			lastValidExpression = result.expression;
		} else {
			// Invalid, hallucinated, or missing expression: never leave it empty. Carry
			// forward the last known-good expression (the character's expression didn't
			// change), or fall back to the first available one if this is the first segment.
			const fallback = lastValidExpression ?? validExpressions[0] ?? null;
			if (result.expression !== fallback) modified = true;
			result.expression = fallback;
			if (fallback) lastValidExpression = fallback;
		}

		if (result.background && !validBackgrounds.includes(result.background)) {
			modified = true;
			result.background = null;
		}

		if (result.cg && !validCgs.includes(result.cg)) {
			modified = true;
			result.cg = null;
		}

		return result;
	});

	return { sequence: validated, modified };
}

/**
 * Merges segments whose text is empty or contains only whitespace into their nearest
 * non-empty neighbor, carrying the neighbor's classification with it. This guarantees
 * the LLM's rule against whitespace-only segments is enforced client-side even when
 * the model ignores the instruction.
 * @param {object[]} sequence - The validated sequence
 * @returns {object[]} - The sequence with no whitespace-only segments
 */
function collapseWhitespaceSegments(sequence) {
	const isWhitespaceOnly = (text) => typeof text === "string" && text.trim().length === 0;
	if (!Array.isArray(sequence) || sequence.length === 0) return sequence;

	const result = [];
	let pendingWhitespace = [];

	for (let i = 0; i < sequence.length; i++) {
		const item = sequence[i];

		if (isWhitespaceOnly(item.text_segment)) {
			pendingWhitespace.push(item.text_segment);
			continue;
		}

		if (pendingWhitespace.length > 0) {
			// Attach trailing whitespace from the previous segment(s) to this segment.
			const mergedText = pendingWhitespace.join("") + item.text_segment;
			result.push({ ...item, text_segment: mergedText });
			pendingWhitespace = [];
		} else {
			result.push(item);
		}
	}

	if (pendingWhitespace.length > 0 && result.length > 0) {
		// Whitespace remained at the very end; attach it to the last segment.
		const last = result[result.length - 1];
		last.text_segment += pendingWhitespace.join("");
	}

	return result;
}

/**
 * Enforces the user-configured maximum segment count by merging any segments beyond
 * the limit into the final one. Never drops or alters any text.
 * @param {object[]} sequence - The reconciled sequence
 * @param {number|null} limit - The maximum number of segments allowed, or a falsy value to disable
 * @returns {object[]} - The (possibly merged) sequence
 */
function enforceSegmentLimit(sequence, limit) {
	if (!limit || sequence.length <= limit) return sequence;

	const kept = sequence.slice(0, limit - 1);
	const overflow = sequence.slice(limit - 1);
	const mergedText = overflow.map((item) => item.text_segment).join("");
	const lastOverflowItem = overflow[overflow.length - 1];

	kept.push({
		text_segment: mergedText,
		expression: lastOverflowItem.expression,
		background: lastOverflowItem.background,
		cg: lastOverflowItem.cg,
	});

	return kept;
}

/**
 * Resolves the character that authored a given chat message.
 * @param {object} context - The ST context
 * @param {object} message - The chat message object
 * @returns {object|null} - The matching character, or null if not found
 */
function resolveMessageCharacter(context, message) {
	if (isGroupChat()) {
		return context.characters.find((c) => c.avatar === message.original_avatar) ?? null;
	}
	if (context.characterId === undefined) return null;
	return context.characters[context.characterId] ?? null;
}

/**
 * Analyzes a rendered character message using the configured LLM endpoint and
 * logs the resulting sequence to the console. Does nothing if LLM-Based
 * classification is not the active classification method.
 * @param {number} messageId - The index of the message in the current chat
 */
export async function analyzeMessageWithLLM(messageId) {
	if (settings().classificationMethod !== CLASSIFICATION_METHODS.LLM) return;

	const context = getContext();
	const message = context.chat[messageId];

	// "..." is ST's placeholder text while a swipe/generation is still in progress - never
	// analyze it (this shows up on MESSAGE_SWIPED, fired before generation completes).
	if (!message || message.is_user || message.is_system || !message.mes || message.mes === "...") return;

	const swipeId = message.swipe_id ?? 0;

	// When swiping right past the last existing swipe to generate a brand new one, ST
	// sets swipe_id to a new, not-yet-existing slot (swipe_id >= swipes.length) and fires
	// MESSAGE_SWIPED immediately - but it only replaces the on-screen "..." placeholder in
	// the DOM at that point, `message.mes` itself still holds the *previous* swipe's text
	// until generation actually finishes. Analyzing here would misclassify the old text
	// under the new swipe's slot. Bail out and let CHARACTER_MESSAGE_RENDERED (fired once
	// the real text is ready) trigger the analysis instead.
	if (Array.isArray(message.swipes) && swipeId >= message.swipes.length) return;

	const character = resolveMessageCharacter(context, message);
	if (!character) return;

	const originalText = message.mes;
	const textHash = hashText(originalText);

	const cached = getCachedAnalysis(messageId, swipeId, textHash);
	if (cached) {
		console.log(
			`${LOG_TAG} Message from "${character.name}" was already analyzed - replaying the cached result instead of calling the LLM again.`,
			LOG_STYLE_TAG, LOG_STYLE_INFO,
		);
		playSequenceInTextbox(cached.sequence, character.name, getSpriteFolderName(character));
		maybeUpdateSummary(messageId).catch(() => {});
		return;
	}

	const url = trimTrailingSlash(settings().llmAnalysisUrl);
	const model = settings().llmAnalysisModel;

	if (!url || !model) {
		console.warn(
			`${LOG_TAG} LLM-Based classification is enabled, but the API URL and/or model isn't configured yet.`,
			LOG_STYLE_TAG, LOG_STYLE_WARN,
		);
		return;
	}

	const [expressions, backgroundsData, cgs] = await Promise.all([
		getAvailableExpressions(character),
		getAvailableBackgrounds(),
		getAvailableCGs(),
	]);

	const backgrounds = [...new Set([...(backgroundsData.global ?? []), ...(backgroundsData.chat ?? [])])];
	const segmentLimit = settings().segmentLimitEnabled ? Number(settings().segmentLimit) || null : null;

	const summaryText = settings().summaryEnabled ? getMeta().summary?.text ?? null : null;
	const backgroundHistory = settings().backgroundHistoryEnabled
		? getRecentBackgroundHistory(messageId, Number(settings().backgroundHistoryCount) || 0)
		: [];
	const chatHistoryLines = settings().chatHistoryEnabled
		? getRecentChatHistoryLines(messageId, Number(settings().chatHistoryCount) || 0)
		: [];

	const systemPrompt = buildSystemPrompt({
		expressions, backgrounds, cgs, segmentLimit,
		summaryText, backgroundHistory, chatHistoryLines,
	});

	console.log(
		`${LOG_TAG} Sending message from "${character.name}" for LLM-based classification...`,
		LOG_STYLE_TAG, LOG_STYLE_INFO,
	);

	try {
		const response = await fetch(`${url}/chat/completions`, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: originalText },
				],
				temperature: 0.8,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content ?? "";
		const parsed = parseSequenceResponse(content);

		if (!parsed) {
			console.error(
				`${LOG_TAG} Could not parse a valid JSON sequence from the model's response. Raw response:`,
				LOG_STYLE_TAG, LOG_STYLE_ERROR, content,
			);
			toastr.error("Could not parse the model's response. Check the console for details.", "Prome Analysis");
			return;
		}

		const { sequence: reconciledSequence, modified: textModified } = reconcileSequenceWithOriginalText(parsed, originalText);
		const { sequence: validatedSequence, modified: classificationModified } = validateSequenceClassifications(
			reconciledSequence, expressions, backgrounds, cgs,
		);
		const collapsedSequence = collapseWhitespaceSegments(validatedSequence);
		const whitespaceModified = collapsedSequence.length !== validatedSequence.length;
		const finalSequence = enforceSegmentLimit(collapsedSequence, segmentLimit);

		if (textModified) {
			console.warn(
				`${LOG_TAG} The model's response didn't perfectly preserve the original text. Segments were realigned to guarantee no characters were lost or changed.`,
				LOG_STYLE_TAG, LOG_STYLE_WARN,
			);
		}

		if (classificationModified) {
			console.warn(
				`${LOG_TAG} The model returned a missing/invalid expression, background or CG on at least one segment. Invalid values were corrected (expressions carried forward, backgrounds/CGs cleared) to guarantee every segment has a valid expression.`,
				LOG_STYLE_TAG, LOG_STYLE_WARN,
			);
		}

		if (whitespaceModified) {
			console.warn(
				`${LOG_TAG} The model produced whitespace-only segment(s). They were merged into neighboring segments so no empty segment reaches the playback pipeline.`,
				LOG_STYLE_TAG, LOG_STYLE_WARN,
			);
		}

		console.log(
			`${LOG_TAG} LLM classification result for "${character.name}":`,
			LOG_STYLE_TAG, LOG_STYLE_SUCCESS,
		);
		console.log({ sequence: finalSequence });
		if (console.table) console.table(finalSequence);

		storeAnalysis(messageId, swipeId, textHash, finalSequence, computeResolvedBackground(messageId, finalSequence));
		maybeUpdateSummary(messageId).catch(() => {});

		playSequenceInTextbox(finalSequence, character.name, getSpriteFolderName(character));
	} catch (err) {
		console.error(`${LOG_TAG} LLM classification failed:`, LOG_STYLE_TAG, LOG_STYLE_ERROR, err);
		toastr.error(`LLM classification failed: ${err.message}`, "Prome Analysis");
	}
}

/* ---------------------------------------------------------------------- */
/* Settings UI                                                            */
/* ---------------------------------------------------------------------- */

function toggleAnalysisSectionVisibility() {
	$("#prome-analysis-settings").toggle(
		settings().classificationMethod === CLASSIFICATION_METHODS.LLM,
	);
}

export function onClassificationMethod_Change(event) {
	settings().classificationMethod = String($(event.target).val());
	saveSettingsDebounced();
	toggleAnalysisSectionVisibility();
	applyClassificationMethod();
}

export function onAnalysisUrl_Input(event) {
	settings().llmAnalysisUrl = String($(event.target).val()).trim();
	saveSettingsDebounced();
}

export function onAnalysisApiKey_Input(event) {
	settings().llmAnalysisApiKey = String($(event.target).val()).trim();
	saveSettingsDebounced();
}

export function onAnalysisModel_Change(event) {
	settings().llmAnalysisModel = String($(event.target).val());
	saveSettingsDebounced();
}

export async function onFetchModels_Click() {
	await fetchAvailableModels();
}

export function onSegmentLimitToggle_Click(event) {
	settings().segmentLimitEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	$("#prome-analysis-segment-limit").prop("disabled", !settings().segmentLimitEnabled);
}

export function onSegmentLimit_Input(event) {
	const value = Math.max(1, Number($(event.target).val()) || 1);
	settings().segmentLimit = value;
	$(event.target).val(value);
	saveSettingsDebounced();
}

export function onSummaryEnabled_Click(event) {
	settings().summaryEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	$("#prome-summary-interval").prop("disabled", !settings().summaryEnabled);
}

export function onSummaryInterval_Input(event) {
	const value = Math.max(1, Number($(event.target).val()) || 1);
	settings().summaryInterval = value;
	$(event.target).val(value);
	saveSettingsDebounced();
}

export function onSummaryReset_Click() {
	const meta = getMeta();
	meta.summary = null;
	saveMeta();
	toastr.success("The rolling summary for this chat has been reset.", "Prome Analysis");
}

export function onChatHistoryEnabled_Click(event) {
	settings().chatHistoryEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	$("#prome-chat-history-count").prop("disabled", !settings().chatHistoryEnabled);
}

export function onChatHistoryCount_Input(event) {
	const value = Math.max(0, Number($(event.target).val()) || 0);
	settings().chatHistoryCount = value;
	$(event.target).val(value);
	saveSettingsDebounced();
}

export function onBackgroundHistoryEnabled_Click(event) {
	settings().backgroundHistoryEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	$("#prome-background-history-count").prop("disabled", !settings().backgroundHistoryEnabled);
}

export function onBackgroundHistoryCount_Input(event) {
	const value = Math.max(0, Number($(event.target).val()) || 0);
	settings().backgroundHistoryCount = value;
	$(event.target).val(value);
	saveSettingsDebounced();
}

export function setupAnalysisHTML() {
	$("#prome-classification-method").val(settings().classificationMethod);
	$("#prome-analysis-url").val(settings().llmAnalysisUrl);
	$("#prome-analysis-key").val(settings().llmAnalysisApiKey);
	$("#prome-analysis-segment-limit-toggle").prop("checked", settings().segmentLimitEnabled);
	$("#prome-analysis-segment-limit")
		.val(settings().segmentLimit)
		.prop("disabled", !settings().segmentLimitEnabled);

	$("#prome-summary-enabled").prop("checked", settings().summaryEnabled);
	$("#prome-summary-interval")
		.val(settings().summaryInterval)
		.prop("disabled", !settings().summaryEnabled);

	$("#prome-chat-history-enabled").prop("checked", settings().chatHistoryEnabled);
	$("#prome-chat-history-count")
		.val(settings().chatHistoryCount)
		.prop("disabled", !settings().chatHistoryEnabled);

	$("#prome-background-history-enabled").prop("checked", settings().backgroundHistoryEnabled);
	$("#prome-background-history-count")
		.val(settings().backgroundHistoryCount)
		.prop("disabled", !settings().backgroundHistoryEnabled);

	const $select = $("#prome-analysis-model");
	$select.empty();

	if (settings().llmAnalysisAvailableModels?.length) {
		for (const model of settings().llmAnalysisAvailableModels) {
			$select.append($("<option></option>").val(model).text(model));
		}
		$select.val(settings().llmAnalysisModel);
	} else if (settings().llmAnalysisModel) {
		$select.append($("<option></option>").val(settings().llmAnalysisModel).text(settings().llmAnalysisModel));
		$select.val(settings().llmAnalysisModel);
	}

	toggleAnalysisSectionVisibility();
}

export function setupAnalysisJQuery() {
	$("#prome-classification-method").on("change", onClassificationMethod_Change);
	$("#prome-analysis-url").on("input", onAnalysisUrl_Input);
	$("#prome-analysis-key").on("input", onAnalysisApiKey_Input);
	$("#prome-analysis-model").on("change", onAnalysisModel_Change);
	$("#prome-analysis-fetch-models").on("click", onFetchModels_Click);
	$("#prome-analysis-segment-limit-toggle").on("click", onSegmentLimitToggle_Click);
	$("#prome-analysis-segment-limit").on("input", onSegmentLimit_Input);
	$("#prome-summary-enabled").on("click", onSummaryEnabled_Click);
	$("#prome-summary-interval").on("input", onSummaryInterval_Input);
	$("#prome-summary-reset").on("click", onSummaryReset_Click);
	$("#prome-chat-history-enabled").on("click", onChatHistoryEnabled_Click);
	$("#prome-chat-history-count").on("input", onChatHistoryCount_Input);
	$("#prome-background-history-enabled").on("click", onBackgroundHistoryEnabled_Click);
	$("#prome-background-history-count").on("input", onBackgroundHistoryCount_Input);
}
