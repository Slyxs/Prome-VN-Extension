import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../constants.js";
import { uploadTextboxImage } from "../utils.js";

/*
 * Custom Textboxes
 * -----------------
 * Renders a Ren'Py-style textbox that plays back a classified message one segment at a
 * time. Textboxes are configured entirely in the UI: upload a frame image, then use the
 * on-screen layout editor to drag/resize where the speaker name and dialogue text should
 * appear. Everything (image URL + area positions/sizes/styling) is stored as a "profile"
 * in the extension settings (`textboxProfiles`) - no manual file/JSON editing required.
 */

function settings() {
	return extension_settings[extensionName];
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function round1(value) {
	return Math.round(value * 10) / 10;
}

function getProfiles() {
	if (!Array.isArray(settings().textboxProfiles)) {
		settings().textboxProfiles = [];
	}
	return settings().textboxProfiles;
}

function getActiveProfile() {
	return getProfiles().find((profile) => profile.id === settings().activeTextboxId) ?? null;
}

function createDefaultProfile(fileName, imageUrl) {
	const baseName = fileName.replace(/\.[^/.]+$/, "").trim() || "Textbox";

	return {
		id: `tb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		name: baseName,
		imageUrl,
		nameArea: {
			enabled: true,
			top: 6, left: 6, width: 30, height: 12,
			fontSize: 22, fontColor: "#ffcc00", shadow: true,
		},
		dialogueArea: {
			top: 22, left: 6, width: 88, height: 68,
			fontSize: 18, fontColor: "#ffffff", shadow: false,
		},
	};
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

/**
 * Applies an area's position/size/font styling to the live on-screen textbox.
 * @param {JQuery} $area - The area container element
 * @param {JQuery} $text - The text element inside the area
 * @param {object} area - The area config (top/left/width/height/fontSize/fontColor/shadow)
 * @param {{isNameArea?: boolean}} [opts] - Options
 */
function applyLiveAreaStyle($area, $text, area, opts = {}) {
	if (!area || (opts.isNameArea && area.enabled === false)) {
		$area.hide();
		return;
	}

	$area.show().css({
		top: `${area.top}%`,
		left: `${area.left}%`,
		width: `${area.width}%`,
		height: `${area.height}%`,
		display: "flex",
		flexDirection: "column",
		justifyContent: "flex-start",
		textAlign: "left",
	});

	$text.css({
		fontSize: `${area.fontSize}px`,
		color: area.fontColor,
		textShadow: area.shadow ? "2px 2px 4px rgba(0, 0, 0, 0.8)" : "none",
	});
}

function applyScale() {
	const scale = clamp(Number(settings().textboxScale) || 100, 50, 200) / 100;
	$("#prome-custom-textbox").css({
		transform: scale !== 1 ? `scale(${scale})` : "",
		transformOrigin: "bottom center",
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
 * (enabled state + selected textbox profile). Safe to call any time settings change.
 */
export function applyCustomTextboxMode() {
	injectCustomTextboxElement();

	if (!settings().customTextboxEnabled) {
		clearTimers();
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	const profile = getActiveProfile();

	if (!profile) {
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	$("#prome-textbox-bg").attr("src", profile.imageUrl);
	applyLiveAreaStyle($("#prome-textbox-name-area"), $("#prome-textbox-name-text"), profile.nameArea, { isNameArea: true });
	applyLiveAreaStyle($("#prome-textbox-dialogue-area"), $("#prome-textbox-dialogue-text"), profile.dialogueArea);

	restorePosition();
	applyScale();
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
/* Settings UI - Profile Management                                       */
/* ---------------------------------------------------------------------- */

function refreshProfileSelect() {
	const profiles = getProfiles();
	const $select = $("#prome-textbox-select");

	$select.empty();
	$select.append(
		$("<option></option>")
			.val("")
			.text(profiles.length ? "Select a textbox..." : "No textboxes yet - upload one to get started"),
	);

	for (const profile of profiles) {
		$select.append($("<option></option>").val(profile.id).text(profile.name));
	}

	const hasActive = profiles.some((profile) => profile.id === settings().activeTextboxId);
	$select.val(hasActive ? settings().activeTextboxId : "");

	if (!hasActive && settings().activeTextboxId) {
		settings().activeTextboxId = null;
		saveSettingsDebounced();
	}
}

/**
 * Populates the layout editor (image + areas + font controls) from the active profile,
 * or hides it entirely if no profile is selected.
 */
function populateEditorControls() {
	const profile = getActiveProfile();

	$("#prome-textbox-editor").toggleClass("displayNone", !profile);
	$("#prome-textbox-name-input").val(profile?.name ?? "").prop("disabled", !profile);
	$("#prome-textbox-delete").toggleClass("disabled", !profile);

	if (!profile) return;

	$("#prome-textbox-editor-image").attr("src", profile.imageUrl);
	renderEditorAreaBox($("#prome-textbox-editor-name-area"), profile.nameArea);
	renderEditorAreaBox($("#prome-textbox-editor-dialogue-area"), profile.dialogueArea);

	$("#prome-textbox-name-enabled").prop("checked", profile.nameArea.enabled !== false);
	$("#prome-textbox-name-fontsize").val(profile.nameArea.fontSize);
	$("#prome-textbox-name-color").val(profile.nameArea.fontColor);
	$("#prome-textbox-name-shadow").prop("checked", Boolean(profile.nameArea.shadow));

	$("#prome-textbox-dialogue-fontsize").val(profile.dialogueArea.fontSize);
	$("#prome-textbox-dialogue-color").val(profile.dialogueArea.fontColor);
	$("#prome-textbox-dialogue-shadow").prop("checked", Boolean(profile.dialogueArea.shadow));
}

async function onTextboxUpload_Change(event) {
	const file = event.target.files?.[0];
	event.target.value = "";
	if (!file) return;

	toastr.info("Uploading textbox image...", "Prome Textbox");
	const imageUrl = await uploadTextboxImage(file);

	if (!imageUrl) {
		toastr.error("Failed to upload the textbox image.", "Prome Textbox");
		return;
	}

	const profile = createDefaultProfile(file.name, imageUrl);
	getProfiles().push(profile);
	settings().activeTextboxId = profile.id;
	saveSettingsDebounced();

	refreshProfileSelect();
	populateEditorControls();
	applyCustomTextboxMode();
	toastr.success("Textbox image uploaded. Adjust the name/dialogue areas below.", "Prome Textbox");
}

function onTextboxDelete_Click() {
	const profile = getActiveProfile();
	if (!profile) return;

	if (!confirm(`Delete the textbox "${profile.name}"? This cannot be undone.`)) return;

	settings().textboxProfiles = getProfiles().filter((item) => item.id !== profile.id);
	settings().activeTextboxId = settings().textboxProfiles[0]?.id ?? null;
	saveSettingsDebounced();

	refreshProfileSelect();
	populateEditorControls();
	applyCustomTextboxMode();
}

function onTextboxProfileSelect_Change(event) {
	settings().activeTextboxId = String($(event.target).val()) || null;
	saveSettingsDebounced();
	populateEditorControls();
	applyCustomTextboxMode();
}

function onTextboxNameInput_Input(event) {
	const profile = getActiveProfile();
	if (!profile) return;

	const name = String($(event.target).val() || "").trim();
	profile.name = name || profile.name;
	saveSettingsDebounced();
	$(`#prome-textbox-select option[value="${profile.id}"]`).text(profile.name);
}

/* ---------------------------------------------------------------------- */
/* Settings UI - Layout Editor (drag/resize name & dialogue areas)        */
/* ---------------------------------------------------------------------- */

function renderEditorAreaBox($box, area) {
	if (!area) return;
	$box.css({ top: `${area.top}%`, left: `${area.left}%`, width: `${area.width}%`, height: `${area.height}%` });
	$box.toggleClass("prome-textbox-editor-area-disabled", area.enabled === false);
}

function setupSingleAreaInteraction($stage, $box, getArea) {
	let mode = null;
	let startPoint = { x: 0, y: 0 };
	let startRectPx = null;
	let stageRect = null;

	function onPointerMove(event) {
		const area = getArea();
		if (!mode || !area || !stageRect) return;

		const point = event.touches?.[0] ?? event;
		const dx = point.clientX - startPoint.x;
		const dy = point.clientY - startPoint.y;

		if (mode === "move") {
			const leftPx = clamp(startRectPx.left + dx, 0, stageRect.width - startRectPx.width);
			const topPx = clamp(startRectPx.top + dy, 0, stageRect.height - startRectPx.height);
			area.left = round1((leftPx / stageRect.width) * 100);
			area.top = round1((topPx / stageRect.height) * 100);
		} else {
			const widthPx = clamp(startRectPx.width + dx, 24, stageRect.width - startRectPx.left);
			const heightPx = clamp(startRectPx.height + dy, 24, stageRect.height - startRectPx.top);
			area.width = round1((widthPx / stageRect.width) * 100);
			area.height = round1((heightPx / stageRect.height) * 100);
		}

		renderEditorAreaBox($box, area);
	}

	function onPointerUp() {
		if (!mode) return;
		mode = null;
		$(document).off("mousemove.prometbeditor touchmove.prometbeditor mouseup.prometbeditor touchend.prometbeditor");
		saveSettingsDebounced();
		applyCustomTextboxMode();
	}

	function startInteraction(newMode) {
		return (event) => {
			const area = getArea();
			if (!area) return;

			mode = newMode;
			const point = event.touches?.[0] ?? event;
			startPoint = { x: point.clientX, y: point.clientY };
			stageRect = $stage[0].getBoundingClientRect();
			startRectPx = {
				left: (area.left / 100) * stageRect.width,
				top: (area.top / 100) * stageRect.height,
				width: (area.width / 100) * stageRect.width,
				height: (area.height / 100) * stageRect.height,
			};

			$(document).on("mousemove.prometbeditor touchmove.prometbeditor", onPointerMove);
			$(document).on("mouseup.prometbeditor touchend.prometbeditor", onPointerUp);
			event.preventDefault();
			event.stopPropagation();
		};
	}

	$box.on("mousedown touchstart", startInteraction("move"));
	$box.find(".prome-editor-resize-handle").on("mousedown touchstart", startInteraction("resize"));
}

function setupEditorAreaInteractions() {
	const $stage = $("#prome-textbox-editor-stage");
	setupSingleAreaInteraction($stage, $("#prome-textbox-editor-name-area"), () => getActiveProfile()?.nameArea);
	setupSingleAreaInteraction($stage, $("#prome-textbox-editor-dialogue-area"), () => getActiveProfile()?.dialogueArea);
}

/* ---------------------------------------------------------------------- */
/* Settings UI - Font/Style Controls                                       */
/* ---------------------------------------------------------------------- */

function onNameEnabled_Click(event) {
	const profile = getActiveProfile();
	if (!profile) return;
	profile.nameArea.enabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	renderEditorAreaBox($("#prome-textbox-editor-name-area"), profile.nameArea);
	applyCustomTextboxMode();
}

function onNameFontSize_Input(event) {
	const profile = getActiveProfile();
	if (!profile) return;
	profile.nameArea.fontSize = clamp(Number($(event.target).val()) || 22, 8, 72);
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onNameColor_Input(event) {
	const profile = getActiveProfile();
	if (!profile) return;
	profile.nameArea.fontColor = String($(event.target).val());
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onNameShadow_Click(event) {
	const profile = getActiveProfile();
	if (!profile) return;
	profile.nameArea.shadow = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onDialogueFontSize_Input(event) {
	const profile = getActiveProfile();
	if (!profile) return;
	profile.dialogueArea.fontSize = clamp(Number($(event.target).val()) || 18, 8, 72);
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onDialogueColor_Input(event) {
	const profile = getActiveProfile();
	if (!profile) return;
	profile.dialogueArea.fontColor = String($(event.target).val());
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onDialogueShadow_Click(event) {
	const profile = getActiveProfile();
	if (!profile) return;
	profile.dialogueArea.shadow = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onTextboxScale_Input(event) {
	const value = clamp(Number($(event.target).val()) || 100, 50, 200);
	settings().textboxScale = value;
	$("#prome-textbox-scale-value").text(`${value}%`);
	saveSettingsDebounced();
	applyScale();
}

/* ---------------------------------------------------------------------- */
/* Settings UI - Playback/Position Controls                               */
/* ---------------------------------------------------------------------- */

function onCustomTextboxEnable_Click(event) {
	settings().customTextboxEnabled = Boolean($(event.target).prop("checked"));
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
	if (!settings().customTextboxEnabled || !getActiveProfile()) {
		toastr.warning("Enable the custom textbox and upload/select a textbox image first.", "Prome Textbox");
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

	const scale = clamp(Number(settings().textboxScale) || 100, 50, 200);
	$("#prome-textbox-scale").val(scale);
	$("#prome-textbox-scale-value").text(`${scale}%`);

	refreshProfileSelect();
	populateEditorControls();
	applyCustomTextboxMode();
}

/**
 * Binds the Custom Textbox settings UI event handlers and sets up the on-screen
 * draggable textbox element.
 */
export function setupCustomTextboxJQuery() {
	injectCustomTextboxElement();

	$("#prome-textbox-enable").on("click", onCustomTextboxEnable_Click);
	$("#prome-textbox-upload-input").on("change", onTextboxUpload_Change);
	$("#prome-textbox-upload").on("click", () => $("#prome-textbox-upload-input").trigger("click"));
	$("#prome-textbox-delete").on("click", onTextboxDelete_Click);
	$("#prome-textbox-select").on("change", onTextboxProfileSelect_Change);
	$("#prome-textbox-name-input").on("input", onTextboxNameInput_Input);

	$("#prome-textbox-name-enabled").on("click", onNameEnabled_Click);
	$("#prome-textbox-name-fontsize").on("input", onNameFontSize_Input);
	$("#prome-textbox-name-color").on("input", onNameColor_Input);
	$("#prome-textbox-name-shadow").on("click", onNameShadow_Click);
	$("#prome-textbox-dialogue-fontsize").on("input", onDialogueFontSize_Input);
	$("#prome-textbox-dialogue-color").on("input", onDialogueColor_Input);
	$("#prome-textbox-dialogue-shadow").on("click", onDialogueShadow_Click);

	$("#prome-textbox-scale").on("input", onTextboxScale_Input);

	$("#prome-textbox-auto-advance").on("click", onTextboxAutoAdvance_Click);
	$("#prome-textbox-auto-advance-delay").on("input", onTextboxAutoAdvanceDelay_Input);
	$("#prome-textbox-streaming").on("click", onTextboxStreaming_Click);
	$("#prome-textbox-streaming-speed").on("input", onTextboxStreamingSpeed_Input);
	$("#prome-textbox-reset-position").on("click", onTextboxResetPosition_Click);
	$("#prome-textbox-preview").on("click", onTextboxPreview_Click);

	setupEditorAreaInteractions();

	$(document).on("click", "#prome-custom-textbox", (event) => {
		if ($(event.target).closest("#prome-textbox-drag-handle").length) return;
		onTextboxClick();
	});

	makeDraggable($("#prome-custom-textbox"), $("#prome-textbox-drag-handle"));
}
