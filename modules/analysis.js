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

function buildSystemPrompt({ expressions, backgrounds, cgs, segmentLimit }) {
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
		"",
		"Your task must be done accurately: carefully read the whole message first and identify every point where the character's emotion/expression changes, and every point where the scene/location (background) changes, before splitting it into segments. Do not miss real changes, and do not invent changes that are not actually there.",
		"",
		"Rules:",
		"- Only use values from the lists above, matched exactly (case-sensitive), for \"expression\", \"background\" and \"cg\".",
		"- \"expression\" must NEVER be null or an empty string. Every single segment, with no exceptions, must specify the character's current expression as one of the exact values from the \"Available expressions\" list above, even if it is the same expression as the previous segment (i.e. the character's expression did not change in that segment). Pick whichever available expression most closely matches the character's emotional/physical state during that segment.",
		"- \"background\" should be null unless the scene/location genuinely changes in that segment. Do not set a background just because a segment exists; only set it on the segment where the scene/location actually changes.",
		"- \"cg\" should be null unless a special event should show a CG instead of the character sprite.",
		"- Never output a value for \"expression\", \"background\" or \"cg\" that isn't an exact, verbatim entry from the lists above. If you are unsure, pick the closest matching entry from the list rather than inventing a new one (except \"background\"/\"cg\", which may be null).",
		"- Segments with empty or whitespace-only text_segment values are FORBIDDEN. Every segment must contain meaningful text from the message. Do not create a separate segment just for a space between sentences or quotes. If a boundary would result in a whitespace-only segment, merge that whitespace into the adjacent segment instead.",
		"",
		"CRITICAL TEXT INTEGRITY RULES (violating these invalidates your entire response):",
		"- \"text_segment\" must be an EXACT, VERBATIM, contiguous substring of the original message: same characters, spelling, punctuation, capitalization, whitespace, quotes, asterisks and formatting.",
		"- You must NEVER paraphrase, translate, summarize, censor, correct typos/grammar, add, or remove any text, including emotes, action markers (e.g. *text*), or punctuation.",
		"- Concatenating every \"text_segment\" in order, with nothing added, removed, or reordered, must reproduce the original message character-for-character.",
		"- Every single character of the original message must belong to exactly one segment. Do not skip or drop any part of the message.",
	];

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

	const url = trimTrailingSlash(settings().llmAnalysisUrl);
	const model = settings().llmAnalysisModel;

	if (!url || !model) {
		console.warn(
			`${LOG_TAG} LLM-Based classification is enabled, but the API URL and/or model isn't configured yet.`,
			LOG_STYLE_TAG, LOG_STYLE_WARN,
		);
		return;
	}

	const context = getContext();
	const message = context.chat[messageId];

	if (!message || message.is_user || message.is_system || !message.mes) return;

	const character = resolveMessageCharacter(context, message);
	if (!character) return;

	const originalText = message.mes;

	const [expressions, backgroundsData, cgs] = await Promise.all([
		getAvailableExpressions(character),
		getAvailableBackgrounds(),
		getAvailableCGs(),
	]);

	const backgrounds = [...new Set([...(backgroundsData.global ?? []), ...(backgroundsData.chat ?? [])])];
	const segmentLimit = settings().segmentLimitEnabled ? Number(settings().segmentLimit) || null : null;

	const systemPrompt = buildSystemPrompt({ expressions, backgrounds, cgs, segmentLimit });

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

export function setupAnalysisHTML() {
	$("#prome-classification-method").val(settings().classificationMethod);
	$("#prome-analysis-url").val(settings().llmAnalysisUrl);
	$("#prome-analysis-key").val(settings().llmAnalysisApiKey);
	$("#prome-analysis-segment-limit-toggle").prop("checked", settings().segmentLimitEnabled);
	$("#prome-analysis-segment-limit")
		.val(settings().segmentLimit)
		.prop("disabled", !settings().segmentLimitEnabled);

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
}
