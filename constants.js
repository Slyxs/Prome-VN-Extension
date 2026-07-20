export const extensionName = "Prome-VN-Extension";
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
export const VN_MODES = {
	NONE: 0,
	HORIZONTAL: 1,
	VERTICAL: 2,
};

/**
 * The classification methods available for choosing sprites/backgrounds/CGs.
 */
export const CLASSIFICATION_METHODS = {
	/** Uses SillyTavern's built-in expression classification engine. */
	ORIGINAL: "original",
	/** Uses an LLM (via an OpenAI-compatible endpoint) to analyze the message. */
	LLM: "llm",
};

/**
 * The value of `extension_settings.expressions.api` that represents "no classifier selected".
 * Used to suppress ST's built-in classification when LLM-Based classification is active.
 */
export const EXPRESSION_API_NONE = 99;

/**
 * The folder name (relative to the user's `user/images` directory, served at `/user/images/`)
 * where CG images should be placed to be picked up by the LLM-Based classification pipeline.
 */
export const PROME_CG_FOLDER = "prome-cgs";

/**
 * The folder name (relative to the user's `user/images` directory) where custom textbox
 * assets are stored. A textbox is a pair of files sharing the same base name: an image
 * (the textbox frame) and a JSON configuration file describing the safe areas for the
 * speaker name and dialogue text.
 */
export const PROME_TEXTBOX_FOLDER = "prome-textboxes";

/**
 * The file extension used for a textbox's JSON configuration file. It must share the
 * same base name as its paired image (e.g. `my_textbox.png` + `my_textbox.json`).
 */
export const PROME_TEXTBOX_CONFIG_EXTENSION = ".json";

const defaultTintValues = {
	name: "Jarilo Midnight",
	shared: false,
	world: {
		enabled: true,
		blur: 0,
		brightness: 34,
		contrast: 100,
		grayscale: 0,
		hue: 0,
		invert: 0,
		saturate: 100,
		sepia: 10,
	},
	character: {
		enabled: true,
		blur: 0,
		brightness: 100,
		contrast: 100,
		grayscale: 0,
		hue: 0,
		invert: 0,
		saturate: 100,
		sepia: 0,
	},
};

const defaultTintPresets = [
	{
		name: "Dark Penacony",
		shared: false,
		world: {
			enabled: true,
			blur: 0,
			brightness: 34,
			contrast: 100,
			grayscale: 0,
			hue: 90,
			invert: 1,
			saturate: 100,
			sepia: 10,
		},
		character: {
			enabled: true,
			blur: 0,
			brightness: 100,
			contrast: 100,
			grayscale: 0,
			hue: 0,
			invert: 0,
			saturate: 100,
			sepia: 0,
		},
	},
	{
		name: "Jarilo Midnight",
		shared: false,
		world: {
			enabled: true,
			blur: 0,
			brightness: 34,
			contrast: 100,
			grayscale: 0,
			hue: 0,
			invert: 0,
			saturate: 100,
			sepia: 10,
		},
		character: {
			enabled: true,
			blur: 0,
			brightness: 100,
			contrast: 100,
			grayscale: 0,
			hue: 0,
			invert: 0,
			saturate: 100,
			sepia: 0,
		},
	},
];

export const defaultSettings = {
	enableVN_UI: false,
	letterboxMode: 0,
	letterboxColor: "rgba(0, 0, 0, 1)",
	letterboxSize: 8,
	hideSheld: false,
	spriteZoom: false,
	zoomSpeed: 0.6,
	zoomAnimation: "ease",
	spriteDefocusTint: false,
	showOnlyLastMessage: false,
	emulateSprites: false,
	spriteShake: false,
	spriteShadow: false,
	shadowOffsetX: 15,
	shadowOffsetY: 5,
	shadowBlur: 9,
	worldTint: false,
	currentTintValues: defaultTintValues,
	selectedTint: "Jarilo Midnight",
	tintPresets: defaultTintPresets,
	enableUserSprite: false,
	userSprite: "",
	autoHideSprites: false,
	maxViewableCharacters: 5,
	maxSpriteScale: 1,
	scaleSprites: false,

	// Classification
	classificationMethod: CLASSIFICATION_METHODS.ORIGINAL,
	previousExpressionApi: null,
	llmAnalysisUrl: "",
	llmAnalysisApiKey: "",
	llmAnalysisModel: "",
	llmAnalysisAvailableModels: [],
	segmentLimitEnabled: false,
	segmentLimit: 5,

	// Custom Textboxes
	customTextboxEnabled: false,
	activeTextbox: "",
	textboxPosition: null,
	textboxAutoAdvance: false,
	textboxAutoAdvanceDelay: 3000,
	textboxTextStreaming: true,
	textboxStreamingSpeed: 35,
};
