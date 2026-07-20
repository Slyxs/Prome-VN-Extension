import { extensionName, CLASSIFICATION_METHODS, EXPRESSION_API_NONE } from "../constants.js";
import { extension_settings, getContext } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { isGroupChat, getAvailableExpressions, getAvailableBackgrounds } from "../utils.js";

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

function buildSystemPrompt({ expressions, backgrounds, cgs }) {
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

	return [
		"You are the narrative director of a visual novel-style roleplay chat.",
		"You will be given the latest message from a character. Split the message into consecutive segments based on shifts in emotion, scene or event, then choose the best matching expression, background and CG for each segment.",
		"",
		`Available expressions for this character: ${expressions.length ? expressions.join(", ") : "(none available)"}`,
		`Available backgrounds: ${backgrounds.length ? backgrounds.join(", ") : "(none available)"}`,
		`Available CGs: ${cgs.length ? cgs.join(", ") : "(none available yet, always use null)"}`,
		"",
		"Rules:",
		"- Only use values from the lists above, matched exactly (case-sensitive). If nothing fits, use null.",
		"- \"expression\" should be null if the segment doesn't warrant a sprite change.",
		"- \"background\" should be null unless the scene/location changes in that segment.",
		"- \"cg\" should be null unless a special event should show a CG instead of the character sprite.",
		"- \"text_segment\" must be an exact, contiguous substring of the original message. Do not paraphrase, translate or summarize it.",
		"- The segments must cover the message in order and should not overlap.",
		"- Respond with ONLY valid JSON matching this schema, no commentary, no markdown code fences:",
		JSON.stringify(schemaExample, null, 2),
	].join("\n");
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

	const [expressions, backgroundsData] = await Promise.all([
		getAvailableExpressions(character),
		getAvailableBackgrounds(),
	]);

	const backgrounds = [...new Set([...(backgroundsData.global ?? []), ...(backgroundsData.chat ?? [])])];
	const cgs = []; // Reserved for future implementation

	const systemPrompt = buildSystemPrompt({ expressions, backgrounds, cgs });

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
					{ role: "user", content: message.mes },
				],
				temperature: 0.2,
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

		console.log(
			`${LOG_TAG} LLM classification result for "${character.name}":`,
			LOG_STYLE_TAG, LOG_STYLE_SUCCESS,
		);
		console.log(parsed);
		if (console.table) console.table(parsed.sequence);
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

export function setupAnalysisHTML() {
	$("#prome-classification-method").val(settings().classificationMethod);
	$("#prome-analysis-url").val(settings().llmAnalysisUrl);
	$("#prome-analysis-key").val(settings().llmAnalysisApiKey);

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
}
