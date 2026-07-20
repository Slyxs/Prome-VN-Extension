import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { POPUP_TYPE, Popup } from "../../../../popup.js";
import { extensionName } from "../constants.js";
import { uploadTextboxImage } from "../utils.js";

/*
 * Custom Textboxes
 * -----------------
 * Renders a Ren'Py-style textbox that plays back a classified message one segment at a
 * time. Textboxes are fully configured in-app: the user uploads a frame image and then
 * uses the visual Textbox Editor (a popup) to drag/resize the name and dialogue areas
 * directly on top of a live preview of the image, plus basic font controls. Everything
 * is stored as a "profile" in the extension's own settings (`textboxProfiles`) - no
 * manual file/JSON placement required.
 *
 * Profile shape:
 * {
 *   id: string,
 *   name: string,
 *   imageUrl: string,
 *   nameArea: { enabled, top, left, width, height, fontSize, fontColor, shadow },
 *   dialogueArea: { top, left, width, height, fontSize, fontColor, shadow },
 * }
 * (top/left/width/height are percentages of the textbox's own size, fontSize is in px.)
 */

function settings() {
	return extension_settings[extensionName];
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function getPoint(event) {
	return event.touches?.[0] ?? event;
}

/* ---------------------------------------------------------------------- */
/* Profile helpers                                                        */
/* ---------------------------------------------------------------------- */

function createDefaultProfile(name, imageUrl) {
	return {
		id: `textbox_${Date.now()}`,
		name,
		imageUrl,
		nameArea: { enabled: true, top: 4, left: 6, width: 30, height: 14, fontSize: 22, fontColor: "#ffcc00", shadow: true },
		dialogueArea: { top: 22, left: 6, width: 88, height: 66, fontSize: 18, fontColor: "#ffffff", shadow: false },
	};
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

/* ---------------------------------------------------------------------- */
/* On-screen textbox DOM / Styling                                        */
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
 * Applies a single area's position/size/font styling to a pair of (box, text) elements.
 * @param {JQuery} $area - The positioned box element
 * @param {JQuery} $text - The text element inside the box
 * @param {object} area - The area config (top/left/width/height/fontSize/fontColor/shadow)
 */
function styleAreaBox($area, $text, area) {
	if (!area) return;

	$area.css({
		top: `${area.top}%`,
		left: `${area.left}%`,
		width: `${area.width}%`,
		height: `${area.height}%`,
	});

	$text.css({
		fontSize: `${area.fontSize}px`,
		color: area.fontColor,
		textShadow: area.shadow ? "2px 2px 4px rgba(0, 0, 0, 0.8)" : "none",
	});
}

function applyScale() {
	const pct = clamp(Number(settings().textboxScale) || 100, 50, 200);
	$("#prome-custom-textbox").css("transform", `scale(${pct / 100})`);
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
 * (enabled state + active profile). Safe to call any time settings change.
 */
export function applyCustomTextboxMode() {
	injectCustomTextboxElement();

	if (!settings().customTextboxEnabled) {
		clearTimers();
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	const active = getActiveProfile();

	if (!active) {
		$("#prome-custom-textbox").addClass("displayNone");
		return;
	}

	$("#prome-textbox-bg").attr("src", active.imageUrl);
	styleAreaBox($("#prome-textbox-name-area"), $("#prome-textbox-name-text"), active.nameArea);
	styleAreaBox($("#prome-textbox-dialogue-area"), $("#prome-textbox-dialogue-text"), active.dialogueArea);
	$("#prome-textbox-name-area").toggle(Boolean(active.nameArea?.enabled));

	applyScale();
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
/* Textbox Editor Popup (drag/resize layout editor)                      */
/* ---------------------------------------------------------------------- */

function buildEditorHtml(profile) {
	return `
		<div class="prome-textbox-editor">
			<h3 data-i18n="Textbox Editor">Textbox Editor</h3>
			<small data-i18n="Drag the boxes to move them, drag the corner handle to resize. Everything is saved automatically.">
				Drag the boxes to move them, drag the corner handle to resize. Everything is saved automatically.
			</small>

			<div class="prome-textbox-editor-stage">
				<img class="prome-textbox-editor-image" src="${profile.imageUrl}" alt="" />
				<div class="prome-textbox-editor-area prome-textbox-editor-area-name" data-area="nameArea">
					<div class="prome-editor-area-label" data-i18n="Name">Name</div>
					<span class="prome-textbox-editor-preview-text">Character Name</span>
					<div class="prome-editor-resize-handle"></div>
				</div>
				<div class="prome-textbox-editor-area prome-textbox-editor-area-dialogue" data-area="dialogueArea">
					<div class="prome-editor-area-label" data-i18n="Dialogue">Dialogue</div>
					<span class="prome-textbox-editor-preview-text">This is a preview of the dialogue text area. Drag and resize me to fit your textbox image.</span>
					<div class="prome-editor-resize-handle"></div>
				</div>
			</div>

			<div class="prome-textbox-editor-controls">
				<div class="prome-textbox-editor-column">
					<h4 data-i18n="Name Area">Name Area</h4>
					<label class="checkbox_label" data-area="nameArea" data-field="enabled">
						<input type="checkbox" ${profile.nameArea.enabled ? "checked" : ""} />
						<span data-i18n="Show Name">Show Name</span>
					</label>
					<label data-i18n="Font Size">Font Size</label>
					<input type="number" class="text_pole" min="8" max="72" step="1" data-area="nameArea" data-field="fontSize" value="${profile.nameArea.fontSize}" />
					<label data-i18n="Font Color">Font Color</label>
					<input type="color" data-area="nameArea" data-field="fontColor" value="${profile.nameArea.fontColor}" />
					<label class="checkbox_label" data-area="nameArea" data-field="shadow">
						<input type="checkbox" ${profile.nameArea.shadow ? "checked" : ""} />
						<span data-i18n="Text Shadow">Text Shadow</span>
					</label>
				</div>
				<div class="prome-textbox-editor-column">
					<h4 data-i18n="Dialogue Area">Dialogue Area</h4>
					<label data-i18n="Font Size">Font Size</label>
					<input type="number" class="text_pole" min="8" max="72" step="1" data-area="dialogueArea" data-field="fontSize" value="${profile.dialogueArea.fontSize}" />
					<label data-i18n="Font Color">Font Color</label>
					<input type="color" data-area="dialogueArea" data-field="fontColor" value="${profile.dialogueArea.fontColor}" />
					<label class="checkbox_label" data-area="dialogueArea" data-field="shadow">
						<input type="checkbox" ${profile.dialogueArea.shadow ? "checked" : ""} />
						<span data-i18n="Text Shadow">Text Shadow</span>
					</label>
				</div>
			</div>
		</div>
	`;
}

function refreshEditorPreview($popupContent, profile) {
	for (const areaKey of ["nameArea", "dialogueArea"]) {
		const $area = $popupContent.find(`.prome-textbox-editor-area[data-area="${areaKey}"]`);
		const $text = $area.find(".prome-textbox-editor-preview-text");
		styleAreaBox($area, $text, profile[areaKey]);
		if (areaKey === "nameArea") {
			$area.toggleClass("prome-textbox-editor-area-disabled", !profile.nameArea.enabled);
		}
	}
}

function setupAreaDragResize($popupContent, $stage, areaKey, profile, onChange) {
	const $area = $popupContent.find(`.prome-textbox-editor-area[data-area="${areaKey}"]`);
	let mode = null;
	let startX = 0;
	let startY = 0;
	let startRect = null;

	function stageRect() {
		return $stage[0].getBoundingClientRect();
	}

	function onMove(event) {
		if (!mode) return;
		const point = getPoint(event);
		const dx = point.clientX - startX;
		const dy = point.clientY - startY;
		const rect = stageRect();

		let { top, left, width, height } = startRect;

		if (mode === "move") {
			left = clamp(startRect.left + dx, 0, rect.width - startRect.width);
			top = clamp(startRect.top + dy, 0, rect.height - startRect.height);
		} else if (mode === "resize") {
			width = clamp(startRect.width + dx, rect.width * 0.05, rect.width - startRect.left);
			height = clamp(startRect.height + dy, rect.height * 0.05, rect.height - startRect.top);
		}

		$area.css({
			left: `${(left / rect.width) * 100}%`,
			top: `${(top / rect.height) * 100}%`,
			width: `${(width / rect.width) * 100}%`,
			height: `${(height / rect.height) * 100}%`,
		});
	}

	function onUp() {
		if (!mode) return;
		mode = null;
		$(document).off("mousemove.prometbeditor touchmove.prometbeditor");
		$(document).off("mouseup.prometbeditor touchend.prometbeditor");

		const rect = stageRect();
		const areaRect = $area[0].getBoundingClientRect();
		profile[areaKey].left = clamp(((areaRect.left - rect.left) / rect.width) * 100, 0, 100);
		profile[areaKey].top = clamp(((areaRect.top - rect.top) / rect.height) * 100, 0, 100);
		profile[areaKey].width = clamp((areaRect.width / rect.width) * 100, 5, 100);
		profile[areaKey].height = clamp((areaRect.height / rect.height) * 100, 5, 100);

		onChange();
	}

	function startDrag(newMode) {
		return (event) => {
			mode = newMode;
			const point = getPoint(event);
			startX = point.clientX;
			startY = point.clientY;
			const rect = stageRect();
			const areaRect = $area[0].getBoundingClientRect();
			startRect = {
				left: areaRect.left - rect.left,
				top: areaRect.top - rect.top,
				width: areaRect.width,
				height: areaRect.height,
			};

			$(document).on("mousemove.prometbeditor touchmove.prometbeditor", onMove);
			$(document).on("mouseup.prometbeditor touchend.prometbeditor", onUp);
			event.preventDefault();
			event.stopPropagation();
		};
	}

	$area.on("mousedown touchstart", startDrag("move"));
	$area.find(".prome-editor-resize-handle").on("mousedown touchstart", startDrag("resize"));
}

function setupEditorControls($popupContent, profile, onChange) {
	$popupContent.find("input[data-area]").on("input click change", (event) => {
		const $input = $(event.currentTarget);
		const areaKey = $input.data("area");
		const field = $input.data("field");
		const area = profile[areaKey];
		if (!area) return;

		if ($input.attr("type") === "checkbox") {
			area[field] = Boolean($input.prop("checked"));
		} else if ($input.attr("type") === "number") {
			area[field] = clamp(Number($input.val()) || 0, 8, 72);
		} else {
			area[field] = String($input.val());
		}

		refreshEditorPreview($popupContent, profile);
		onChange();
	});
}

/**
 * Opens the full drag/resize Textbox Editor popup for the given profile.
 * @param {object} profile - The textbox profile to edit
 */
async function openTextboxEditor(profile) {
	const html = buildEditorHtml(profile);

	const popup = new Popup(html, POPUP_TYPE.TEXT, "", {
		wide: true,
		large: true,
		allowVerticalScrolling: true,
		okButton: "Close",
		cancelButton: false,
		onOpen: (openedPopup) => {
			const $content = $(openedPopup.content);
			const $stage = $content.find(".prome-textbox-editor-stage");

			function onChange() {
				saveSettingsDebounced();
				applyCustomTextboxMode();
				refreshTextboxProfileSelect();
			}

			refreshEditorPreview($content, profile);
			setupAreaDragResize($content, $stage, "nameArea", profile, onChange);
			setupAreaDragResize($content, $stage, "dialogueArea", profile, onChange);
			setupEditorControls($content, profile, onChange);
		},
	});

	await popup.show();
}

/* ---------------------------------------------------------------------- */
/* Settings UI                                                            */
/* ---------------------------------------------------------------------- */

function refreshTextboxProfileSelect() {
	const $select = $("#prome-textbox-profile-select");
	const profiles = getProfiles();

	$select.empty();
	$select.append(
		$("<option></option>")
			.val("")
			.text(profiles.length ? "Select a textbox..." : "No textboxes yet - click Add"),
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

	updateProfileControlsState();
}

function updateProfileControlsState() {
	const active = getActiveProfile();
	$("#prome-textbox-name-input").val(active?.name ?? "").prop("disabled", !active);
	$("#prome-textbox-edit").toggleClass("disabled", !active);
	$("#prome-textbox-delete").toggleClass("disabled", !active);
}

function onCustomTextboxEnable_Click(event) {
	settings().customTextboxEnabled = Boolean($(event.target).prop("checked"));
	saveSettingsDebounced();
	applyCustomTextboxMode();
}

function onTextboxProfileSelect_Change(event) {
	settings().activeTextboxId = String($(event.target).val()) || null;
	saveSettingsDebounced();
	updateProfileControlsState();
	applyCustomTextboxMode();
}

async function onTextboxAdd_Click() {
	$("#prome-textbox-file-input").trigger("click");
}

async function onTextboxFile_Change(event) {
	const file = event.target.files?.[0];
	event.target.value = "";
	if (!file) return;

	toastr.info("Uploading textbox image...", "Prome Textbox");

	try {
		const imageUrl = await uploadTextboxImage(file);
		const name = file.name.replace(/\.[^/.]+$/, "") || `Textbox ${getProfiles().length + 1}`;
		const profile = createDefaultProfile(name, imageUrl);

		getProfiles().push(profile);
		settings().activeTextboxId = profile.id;
		saveSettingsDebounced();

		refreshTextboxProfileSelect();
		applyCustomTextboxMode();
		toastr.success("Textbox uploaded! Opening the editor...", "Prome Textbox");

		await openTextboxEditor(profile);
	} catch (err) {
		console.error(`[${extensionName}] Failed to upload textbox image:`, err);
		toastr.error(`Could not upload the image: ${err.message}`, "Prome Textbox");
	}
}

function onTextboxName_Input(event) {
	const active = getActiveProfile();
	if (!active) return;
	active.name = String($(event.target).val());
	saveSettingsDebounced();
	refreshTextboxProfileSelect();
}

async function onTextboxEdit_Click() {
	const active = getActiveProfile();
	if (!active) {
		toastr.warning("Add or select a textbox first.", "Prome Textbox");
		return;
	}
	await openTextboxEditor(active);
}

function onTextboxDelete_Click() {
	const active = getActiveProfile();
	if (!active) return;

	if (!confirm(`Delete the textbox "${active.name}"? This cannot be undone.`)) return;

	settings().textboxProfiles = getProfiles().filter((profile) => profile.id !== active.id);
	settings().activeTextboxId = null;
	saveSettingsDebounced();

	refreshTextboxProfileSelect();
	applyCustomTextboxMode();
}

function onTextboxScale_Input(event) {
	const value = clamp(Number($(event.target).val()) || 100, 50, 200);
	settings().textboxScale = value;
	$("#prome-textbox-scale").val(value);
	$("#prome-textbox-scale-counter").val(value);
	saveSettingsDebounced();
	applyScale();
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
	$("#prome-textbox-scale").val(settings().textboxScale);
	$("#prome-textbox-scale-counter").val(settings().textboxScale);
	$("#prome-textbox-auto-advance").prop("checked", settings().textboxAutoAdvance);
	$("#prome-textbox-auto-advance-delay")
		.val(settings().textboxAutoAdvanceDelay)
		.prop("disabled", !settings().textboxAutoAdvance);
	$("#prome-textbox-streaming").prop("checked", settings().textboxTextStreaming);
	$("#prome-textbox-streaming-speed")
		.val(settings().textboxStreamingSpeed)
		.prop("disabled", !settings().textboxTextStreaming);

	refreshTextboxProfileSelect();
	applyCustomTextboxMode();
}

/**
 * Binds the Custom Textbox settings UI event handlers and sets up the on-screen
 * draggable textbox element.
 */
export function setupCustomTextboxJQuery() {
	injectCustomTextboxElement();

	$("#prome-textbox-enable").on("click", onCustomTextboxEnable_Click);
	$("#prome-textbox-profile-select").on("change", onTextboxProfileSelect_Change);
	$("#prome-textbox-add").on("click", onTextboxAdd_Click);
	$("#prome-textbox-file-input").on("change", onTextboxFile_Change);
	$("#prome-textbox-name-input").on("input", onTextboxName_Input);
	$("#prome-textbox-edit").on("click", onTextboxEdit_Click);
	$("#prome-textbox-delete").on("click", onTextboxDelete_Click);
	$("#prome-textbox-scale").on("input", onTextboxScale_Input);
	$("#prome-textbox-scale-counter").on("input", onTextboxScale_Input);
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
