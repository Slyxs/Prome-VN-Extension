import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName, PROME_TEXTBOX_FOLDER } from "../constants.js";
import { getAvailableTextboxes } from "../utils.js";

/*
 * Custom Textboxes
 * -----------------
 * Renders a Ren'Py-style textbox that plays back a classified message one segment at a
 * time. A textbox asset is a pair of files living in `user/images/prome-textboxes`
 * sharing the same base name: an image (the frame) and a JSON configuration file
 * describing the "safe areas" for the speaker name and dialogue text. Example config:
 *
 * {
 *   "fonts": [
 *     { "font_family": "TitleFont", "font_file": "FancyName.ttf" },
 *     { "font_family": "ReadabilityFont", "font_file": "CleanDialogue.otf" }
 *   ],
 *   "name_area": {
 *     "top": "5%", "left": "8%", "width": "24%", "height": "10%",
 *     "align": "left", "vertical_align": "middle",
 *     "styling": {
 *       "font_family": "TitleFont", "font_size": "26px", "font_color": "#ffcc00",
 *       "outline_color": "#000000", "outline_thickness": "2px", "shadow": true
 *     }
 *   },
 *   "dialogue_area": {
 *     "top": "20%", "left": "10%", "width": "80%", "height": "70%",
 *     "align": "left", "vertical_align": "top", "line_height": "1.4",
 *     "styling": {
 *       "font_family": "ReadabilityFont", "font_size": "18px", "font_color": "#ffffff",
 *       "outline_color": "transparent", "outline_thickness": "0px", "shadow": false
 *     }
 *   }
 * }
 */

function settings() {
	return extension_settings[extensionName];
}

/* ---------------------------------------------------------------------- */
/* DOM / Styling                                                          */
/* ---------------------------------------------------------------------- */

function injectCustomTextboxElement() {
	if ($("#prome-custom-textbox").length) return;

	const html = `
		<div id="prome-custom-textbox" class="prome-custom-textbox displayNone">
			<div id="prome-textbox-drag-handle" class="prome-textbox-drag-handle fa-solid fa-grip" title="Drag to move"></div>
			<img id="prome-textbox-bg" class="prome-textbox-bg" alt="" />
			<div id="prome-textbox-name-area" class="prome-textbox-name-area">
				<span id="prome-textbox-name-text" class="prome-textbox-name-text"></span>
			</div>
			<div id="prome-textbox-dialogue-area" class="prome-textbox-dialogue-area">
				<span id="prome-textbox-dialogue-text" class="prome-textbox-dialogue-text"></span>
			</div>
		</div>
	`;

	$("body").append(html);
}

function loadCustomFonts(fonts) {
	$("#prome-textbox-fonts").remove();

	if (!Array.isArray(fonts) || fonts.length === 0) return;

	const rules = fonts
		.map((font) => {
			if (!font?.font_family || !font?.font_file) return "";
			const url = `/user/images/${PROME_TEXTBOX_FOLDER}/${encodeURIComponent(font.font_file)}`;
			return `@font-face { font-family: "${font.font_family}"; src: url("${url}"); }`;
		})
		.filter(Boolean)
		.join("\n");

	if (rules) {
		$("<style>").attr("id", "prome-textbox-fonts").text(rules).appendTo("head");
	}
}

function verticalAlignToFlex(verticalAlign) {
	if (verticalAlign === "top") return "flex-start";
	if (verticalAlign === "bottom") return "flex-end";
	return "center";
}

function applyAreaStyle($area, $text, areaConfig) {
	if (!areaConfig) return;
	const styling = areaConfig.styling ?? {};

	$area.css({
		top: areaConfig.top ?? "0%",
		left: areaConfig.left ?? "0%",
		width: areaConfig.width ?? "auto",
		height: areaConfig.height ?? "auto",
		display: "flex",
		flexDirection: "column",
		justifyContent: verticalAlignToFlex(areaConfig.vertical_align),
		textAlign: areaConfig.align ?? "left",
	});

	const hasOutline = styling.outline_color && styling.outline_thickness && styling.outline_thickness !== "0px";

	$text.css({
		fontFamily: styling.font_family ? `"${styling.font_family}"` : "",
		fontSize: styling.font_size ?? "",
		color: styling.font_color ?? "",
		lineHeight: areaConfig.line_height ?? "",
		textShadow: styling.shadow ? "2px 2px 4px rgba(0, 0, 0, 0.8)" : "none",
		WebkitTextStroke: hasOutline ? `${styling.outline_thickness} ${styling.outline_color}` : "",
	});
}

function restorePosition() {
	const position = settings().textboxPosition;
	const $textbox = $("#prome-custom-textbox");

	if (position && typeof position.top === "number" && typeof position.left === "number") {
		$textbox.css({ top: `${position.top}px`, left: `${position.left}px`, bottom: "auto", right: "auto" });
	} else {
		$textbox.css({ top: "", left: "", bottom: "", right: "" });
	}
}

function makeDraggable($textbox, $handle) {
	let dragging = false;
	let startX = 0;
	let startY = 0;
	let startTop = 0;
	let startLeft = 0;

	function getPoint(event) {
		return event.touches?.[0] ?? event;
	}

	function onPointerMove(event) {
		if (!dragging) return;
		const point = getPoint(event);
		const dx = point.clientX - startX;
		const dy = point.clientY - startY;
		const maxTop = window.innerHeight - $textbox.outerHeight();
		const maxLeft = window.innerWidth - $textbox.outerWidth();
		const newTop = Math.min(Math.max(0, startTop + dy), Math.max(0, maxTop));
		const newLeft = Math.min(Math.max(0, startLeft + dx), Math.max(0, maxLeft));

		$textbox.css({ top: `${newTop}px`, left: `${newLeft}px`, bottom: "auto", right: "auto" });
	}

	function onPointerUp() {
		if (!dragging) return;
		dragging = false;
		$(document).off("mousemove.prometextbox touchmove.prometextbox");
		$(document).off("mouseup.prometextbox touchend.prometextbox");

		const rect = $textbox[0].getBoundingClientRect();
		settings().textboxPosition = { top: rect.top, left: rect.left };
		saveSettingsDebounced();
	}

	function onPointerDown(event) {
		dragging = true;
		const point = getPoint(event);
		startX = point.clientX;
		startY = point.clientY;
		const rect = $textbox[0].getBoundingClientRect();
		startTop = rect.top;
		startLeft = rect.left;

		$(document).on("mousemove.prometextbox touchmove.prometextbox", onPointerMove);
		$(document).on("mouseup.prometextbox touchend.prometextbox", onPointerUp);
		event.preventDefault();
	}

	$handle.on("mousedown touchstart", onPointerDown);
}

/**
 * Rebuilds and shows/hides the on-screen custom textbox based on the current settings
 * (enabled state + selected textbox). Safe to call any time settings change.
 */
export async function applyCustomTextboxMode() {
	injectCustomTextboxElement();

	if (!settings().customTextboxEnabled) {
		clearTimers();
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	const textboxes = await getAvailableTextboxes();
	const active = textboxes.find((textbox) => textbox.name === settings().activeTextbox);

	if (!active) {
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	$("#prome-textbox-bg").attr("src", active.imageUrl);
	loadCustomFonts(active.config?.fonts);
	applyAreaStyle($("#prome-textbox-name-area"), $("#prome-textbox-name-text"), active.config?.name_area);
	applyAreaStyle($("#prome-textbox-dialogue-area"), $("#prome-textbox-dialogue-text"), active.config?.dialogue_area);

	restorePosition();
	$("#prome-custom-textbox").removeClass("displayNone");
}

/* ---------------------------------------------------------------------- */
/* Segment Playback                                                       */
/* ---------------------------------------------------------------------- */

let currentSequence = [];
let currentIndex = -1;
let isTyping = false;
let typewriterTimer = null;
let advanceTimer = null;

function clearTimers() {
	if (typewriterTimer) {
		clearInterval(typewriterTimer);
		typewriterTimer = null;
	}
	if (advanceTimer) {
		clearTimeout(advanceTimer);
		advanceTimer = null;
	}
}

function scheduleAutoAdvance() {
	if (!settings().textboxAutoAdvance) return;
	if (currentIndex >= currentSequence.length - 1) return;

	const delay = Math.max(0, Number(settings().textboxAutoAdvanceDelay) || 0);
	advanceTimer = setTimeout(() => advanceSegment(), delay);
}

function renderSegment(index) {
	clearTimers();
	const segment = currentSequence[index];
	const text = segment?.text_segment ?? "";
	const $text = $("#prome-textbox-dialogue-text");

	if (settings().textboxTextStreaming) {
		isTyping = true;
		let charIndex = 0;
		const speed = Math.max(1, Number(settings().textboxStreamingSpeed) || 35); // characters per second
		const intervalMs = 1000 / speed;

		$text.text("");
		typewriterTimer = setInterval(() => {
			charIndex++;
			$text.text(text.slice(0, charIndex));

			if (charIndex >= text.length) {
				clearInterval(typewriterTimer);
				typewriterTimer = null;
				isTyping = false;
				scheduleAutoAdvance();
			}
		}, intervalMs);
	} else {
		$text.text(text);
		isTyping = false;
		scheduleAutoAdvance();
	}
}

function completeCurrentSegment() {
	clearTimers();
	isTyping = false;
	const segment = currentSequence[currentIndex];
	$("#prome-textbox-dialogue-text").text(segment?.text_segment ?? "");
	scheduleAutoAdvance();
}

function advanceSegment() {
	clearTimers();
	if (currentIndex >= currentSequence.length - 1) return;
	currentIndex++;
	renderSegment(currentIndex);
}

function onTextboxClick() {
	if (!currentSequence.length) return;
	if (isTyping) {
		completeCurrentSegment();
	} else {
		advanceSegment();
	}
}

/**
 * Plays a classified segment sequence in the custom textbox, one segment at a time.
 * Does nothing if the custom textbox isn't enabled/configured.
 * @param {{text_segment: string, expression: string|null, background: string|null, cg: string|null}[]} sequence
 * @param {string} characterName - The name to show in the name area
 */
export function playSequenceInTextbox(sequence, characterName) {
	if (!settings().customTextboxEnabled) return;
	if (!Array.isArray(sequence) || sequence.length === 0) return;
	if (!$("#prome-custom-textbox").length || $("#prome-custom-textbox").hasClass("displayNone")) return;

	currentSequence = sequence;
	currentIndex = 0;

	$("#prome-textbox-name-text").text(characterName ?? "");
	renderSegment(0);
}

/* ---------------------------------------------------------------------- */
/* Settings UI                                                            */
/* ---------------------------------------------------------------------- */

async function refreshTextboxList() {
	const $select = $("#prome-textbox-select");
	$select.empty().append($("<option></option>").val("").text("Loading..."));

	const textboxes = await getAvailableTextboxes();

	$select.empty();
	$select.append(
		$("<option></option>")
			.val("")
			.text(textboxes.length ? "Select a textbox..." : "No textboxes found"),
	);

	for (const textbox of textboxes) {
		$select.append($("<option></option>").val(textbox.name).text(textbox.name));
	}

	const hasActive = textboxes.some((textbox) => textbox.name === settings().activeTextbox);
	$select.val(hasActive ? settings().activeTextbox : "");

	if (!hasActive && settings().activeTextbox) {
		settings().activeTextbox = "";
		saveSettingsDebounced();
	}

	await applyCustomTextboxMode();
}

function onCustomTextboxEnable_Click(event) {
	settings().customTextboxEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onTextboxSelect_Change(event) {
	settings().activeTextbox = String($(event.target).val());
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onTextboxAutoAdvance_Click(event) {
	const checked = Boolean($(event.target).prop("checked"));
	settings().textboxAutoAdvance = checked;
	$("#prome-textbox-auto-advance-delay").prop("disabled", !checked);
	saveSettingsDebounced();
}

function onTextboxAutoAdvanceDelay_Input(event) {
	const value = Math.max(100, Number($(event.target).val()) || 100);
	settings().textboxAutoAdvanceDelay = value;
	saveSettingsDebounced();
}

function onTextboxStreaming_Click(event) {
	const checked = Boolean($(event.target).prop("checked"));
	settings().textboxTextStreaming = checked;
	$("#prome-textbox-streaming-speed").prop("disabled", !checked);
	saveSettingsDebounced();
}

function onTextboxStreamingSpeed_Input(event) {
	const value = Math.max(1, Number($(event.target).val()) || 1);
	settings().textboxStreamingSpeed = value;
	saveSettingsDebounced();
}

function onTextboxResetPosition_Click() {
	settings().textboxPosition = null;
	saveSettingsDebounced();
	restorePosition();
}

function onTextboxPreview_Click() {
	if (!settings().customTextboxEnabled || !settings().activeTextbox) {
		toastr.warning("Enable the custom textbox and select a textbox first.", "Prome Textbox");
		return;
	}

	playSequenceInTextbox(
		[
			{ text_segment: "This is a preview of your custom textbox.", expression: null, background: null, cg: null },
			{ text_segment: "Click the textbox (or wait, if auto-advance is on) to see the next segment!", expression: null, background: null, cg: null },
		],
		"Preview Character",
	);
}

/**
 * Populates the Custom Textbox settings UI from the current extension settings.
 */
export function setupCustomTextboxHTML() {
	$("#prome-textbox-enable").prop("checked", settings().customTextboxEnabled);
	$("#prome-textbox-auto-advance").prop("checked", settings().textboxAutoAdvance);
	$("#prome-textbox-auto-advance-delay")
		.val(settings().textboxAutoAdvanceDelay)
		.prop("disabled", !settings().textboxAutoAdvance);
	$("#prome-textbox-streaming").prop("checked", settings().textboxTextStreaming);
	$("#prome-textbox-streaming-speed")
		.val(settings().textboxStreamingSpeed)
		.prop("disabled", !settings().textboxTextStreaming);

	refreshTextboxList();
}

/**
 * Binds the Custom Textbox settings UI event handlers and sets up the on-screen
 * draggable textbox element.
 */
export function setupCustomTextboxJQuery() {
	injectCustomTextboxElement();

	$("#prome-textbox-enable").on("click", onCustomTextboxEnable_Click);
	$("#prome-textbox-refresh").on("click", refreshTextboxList);
	$("#prome-textbox-select").on("change", onTextboxSelect_Change);
	$("#prome-textbox-auto-advance").on("click", onTextboxAutoAdvance_Click);
	$("#prome-textbox-auto-advance-delay").on("input", onTextboxAutoAdvanceDelay_Input);
	$("#prome-textbox-streaming").on("click", onTextboxStreaming_Click);
	$("#prome-textbox-streaming-speed").on("input", onTextboxStreamingSpeed_Input);
	$("#prome-textbox-reset-position").on("click", onTextboxResetPosition_Click);
	$("#prome-textbox-preview").on("click", onTextboxPreview_Click);

	$(document).on("click", "#prome-custom-textbox", (event) => {
		if ($(event.target).closest("#prome-textbox-drag-handle").length) return;
		onTextboxClick();
	});

	makeDraggable($("#prome-custom-textbox"), $("#prome-textbox-drag-handle"));
}
